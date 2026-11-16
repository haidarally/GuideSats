// What happens when the cyclone watcher or the traveller acts
// WHILE a payment is in flight (mandate "consuming", booking still "mandated")?
// The property test awaits every call in turn, so it never interleaves them; these do.
// Invariant checked in every case: the booking state and the ledger agree, and no
// traveller sats stay stuck in a hold that nobody will settle or cancel.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld, type loadSeed } from "../../src/app/world";
import { loadFixture, replayShifted } from "../../src/feeds/gdacs";
import type { GdacsFeed } from "../../src/domain/cyclone";
import type { LightningBackend } from "../../src/ln/backend";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

/** The guide's wallet answers lookup_invoice only when the test opens the gate (a slow relay). */
function gatedLookups(be: LightningBackend) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const wrapped: LightningBackend = {
    kind: be.kind,
    simulated: be.simulated,
    network: be.network,
    payeeProof: be.payeeProof,
    payer: (id) => be.payer(id),
    receiver: (id) => {
      const r = be.receiver(id);
      return { ...r, lookupInvoice: async (h) => (await gate, r.lookupInvoice(h)) };
    },
  };
  return { wrapped, open: () => open() };
}

async function world(opts: { gated?: boolean; feed?: () => GdacsFeed; seed?: ReturnType<typeof loadSeed> } = {}) {
  let now = T0;
  const w = await buildSimWorld({ clock: () => now, feed: opts.feed, seed: opts.seed, config: { acceptTimeoutMs: 2000, pollMs: 5 } });
  let open = () => {};
  if (opts.gated) {
    const g = gatedLookups(w.backend);
    (w.svc as unknown as { backend: LightningBackend }).backend = g.wrapped;
    open = g.open;
  }
  return { ...w, open, tick: (ms: number) => (now += ms) };
}

const cyclone = () => replayShifted(loadFixture("tc-2024-01-belal.json"), T0 - 6 * HOUR);
const acceptedFromTraveller = (w: Awaited<ReturnType<typeof world>>) => w.ledger.allHolds().filter((h) => h.payer === "traveller" && h.state === "accepted");

describe("races between an in-flight payment and the watcher or the traveller", () => {
  it("hold: a cyclone alert while the lock is in flight still refunds the traveller (no stuck hold, no crash)", async () => {
    let feed: GdacsFeed = { features: [] };
    const w = await world({ gated: true, feed: () => feed });
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
    const inv = await w.svc.requestInvoice(booking.id);

    const pending = w.svc.payWithinMandate(booking.id, inv);
    expect(w.svc.mandate(booking.id)?.status).toBe("consuming");
    expect(w.ledger.balance("traveller")).toBe(120_000 - 21_000); // the sats sit in the HTLC

    feed = cyclone();
    await w.svc.applyCycloneRule(); // the watcher's tick lands while the lock is in flight
    w.open();
    const r = await pending; // must not throw
    expect(r.ok).toBe(false);
    await w.svc.applyCycloneRule(); // and the next tick

    expect(acceptedFromTraveller(w)).toEqual([]);
    expect(w.ledger.balance("traveller")).toBe(120_000);
    expect(w.ledger.balance("guide_lemorne")).toBe(0);
    expect(["skipped_cyclone", "refunded_cyclone"]).toContain(w.svc.booking(booking.id).state);
    expect(w.svc.mandate(booking.id)?.status).not.toBe("approved"); // never re-armed on a closed booking
  });

  it("hold: the traveller cannot cancel while the lock is in flight; the lock then completes", async () => {
    const w = await world({ gated: true });
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
    const inv = await w.svc.requestInvoice(booking.id);

    const pending = w.svc.payWithinMandate(booking.id, inv);
    expect(() => w.svc.cancelByTraveller(booking.id)).toThrow("payment_in_flight");
    w.open();
    expect(await pending).toEqual({ ok: true, state: "locked", amountSats: 21_000 });
    expect(w.svc.booking(booking.id).state).toBe("locked");
    expect(acceptedFromTraveller(w)).toHaveLength(1);
  });

  it("hold: if the booking changed anyway, the accepted hold is cancelled at once (defence in depth)", async () => {
    const w = await world({ gated: true });
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
    const inv = await w.svc.requestInvoice(booking.id);

    const pending = w.svc.payWithinMandate(booking.id, inv);
    // Simulate any other writer moving the booking on (a bug elsewhere, a second process...).
    const store = (w.svc as unknown as { store: { putBooking(b: unknown): void } }).store;
    store.putBooking({ ...w.svc.booking(booking.id), state: "cancelled" });
    w.open();
    const r = await pending;
    expect(r).toEqual({ ok: false, reason: "booking_changed_during_payment:cancelled" });
    expect(acceptedFromTraveller(w)).toEqual([]);
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("plan B: the traveller cannot cancel while the payment is in flight (it cannot be undone)", async () => {
    const w = await world();
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: w.clock() });
    w.tick(9 * HOUR);
    w.svc.confirmTourHappened(booking.id);
    const inv = await w.svc.requestInvoice(booking.id);

    const pending = w.svc.payWithinMandate(booking.id, inv);
    expect(() => w.svc.cancelByTraveller(booking.id)).toThrow("payment_in_flight");
    expect(await pending).toEqual({ ok: true, state: "paid", amountSats: 12_000 });
    expect(w.svc.booking(booking.id).state).toBe("paid");
    expect(w.ledger.balance("guide_lagoon")).toBe(12_000);
  });

  it("plan B: a cyclone tick during the payment does not mark a paid booking as skipped", async () => {
    let feed: GdacsFeed = { features: [] };
    const w = await world({ feed: () => feed });
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: w.clock() });
    w.tick(9 * HOUR);
    w.svc.confirmTourHappened(booking.id);
    const inv = await w.svc.requestInvoice(booking.id);

    const pending = w.svc.payWithinMandate(booking.id, inv);
    feed = replayShifted(loadFixture("tc-2024-01-belal.json"), w.clock() - 6 * HOUR);
    const tick = w.svc.applyCycloneRule();
    const r = await pending; // must not throw
    await tick;
    const state = w.svc.booking(booking.id).state;
    // The sats left the traveller, so the booking must say so.
    if (w.ledger.balance("guide_lagoon") === 12_000) expect(state).toBe("paid");
    else expect(state).toBe("skipped_cyclone");
    expect(r.ok).toBe(state === "paid");
  });

  it("hold: after an UNKNOWN lock outcome, a cyclone alert still cancels the hold and refunds the traveller", async () => {
    let feed: GdacsFeed = { features: [] };
    let now = T0;
    const w0 = await buildSimWorld({ clock: () => now, feed: () => feed, config: { acceptTimeoutMs: 30, pollMs: 5 } });
    const be = w0.backend;
    // The guide's wallet never reports the hold as accepted (a lagging wallet): the pay path times out.
    (w0.svc as unknown as { backend: LightningBackend }).backend = {
      kind: be.kind,
      simulated: be.simulated,
      network: be.network,
      payeeProof: be.payeeProof,
      payer: (id) => be.payer(id),
      receiver: (id) => ({ ...be.receiver(id), lookupInvoice: async () => ({ state: "open" as const, amountSats: 0 }) }),
    };
    const { booking } = w0.svc.proposeBooking("tour_lemorne");
    w0.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: now });
    const inv = await w0.svc.requestInvoice(booking.id);
    expect(await w0.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
    expect(w0.ledger.balance("traveller")).toBe(120_000 - 21_000); // in fact the hold IS accepted
    expect(() => w0.svc.cancelByTraveller(booking.id)).toThrow("payment_in_flight");

    feed = cyclone();
    await w0.svc.applyCycloneRule();
    expect(w0.ledger.allHolds().filter((h) => h.payer === "traveller" && h.state === "accepted")).toEqual([]);
    expect(w0.ledger.balance("traveller")).toBe(120_000);
    expect(w0.svc.booking(booking.id).state).toBe("skipped_cyclone");
  });

  it("hold: an UNKNOWN lock on an invoice the app never requested (same H) is still cancelled by a cyclone", async () => {
    let feed: GdacsFeed = { features: [] };
    let now = T0;
    const w0 = await buildSimWorld({ clock: () => now, feed: () => feed, config: { acceptTimeoutMs: 30, pollMs: 5 } });
    const be = w0.backend;
    (w0.svc as unknown as { backend: LightningBackend }).backend = {
      kind: be.kind,
      simulated: be.simulated,
      network: be.network,
      payeeProof: be.payeeProof,
      payer: (id) => be.payer(id),
      receiver: (id) => ({ ...be.receiver(id), lookupInvoice: async () => ({ state: "open" as const, amountSats: 0 }) }),
    };
    const { booking } = w0.svc.proposeBooking("tour_lemorne");
    const { h } = pair();
    w0.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: now });
    // The agent skips request_invoice and pays a valid hold invoice for H made straight at the guide's wallet.
    const inv = (await be.receiver("guide_lemorne").makeHoldInvoice({ amountSats: 21_000, paymentHash: h, description: "swap", expirySecs: 600 })).invoice;
    expect(await w0.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
    expect(w0.svc.booking(booking.id).invoice).toBeNull();
    feed = cyclone();
    await w0.svc.applyCycloneRule();
    expect(w0.ledger.balance("traveller")).toBe(120_000);
    expect(w0.svc.booking(booking.id).state).toBe("skipped_cyclone");
  });

  it("one failing hold cancel does not stop the cyclone rule refunding the other bookings", async () => {
    let feed: GdacsFeed = { features: [] };
    const w = await world({ feed: () => feed });
    const ids: string[] = [];
    for (const tour of ["tour_lemorne", "tour_chamarel"]) {
      const { booking } = w.svc.proposeBooking(tour);
      w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
      expect((await w.svc.payWithinMandate(booking.id, await w.svc.requestInvoice(booking.id))).ok).toBe(true);
      ids.push(booking.id);
    }
    const be = w.backend;
    (w.svc as unknown as { backend: LightningBackend }).backend = {
      ...be,
      kind: be.kind,
      simulated: be.simulated,
      network: be.network,
      payeeProof: be.payeeProof,
      payer: (id) => be.payer(id),
      receiver: (id) =>
        id === "guide_lemorne"
          ? {
              ...be.receiver(id),
              cancelHoldInvoice: async () => {
                throw new Error("relay down");
              },
            }
          : be.receiver(id),
    };
    feed = cyclone();
    await w.svc.applyCycloneRule();
    expect(w.svc.booking(ids[0]!).state).toBe("locked"); // not refunded: it must not claim so
    expect(w.svc.booking(ids[1]!).state).toBe("refunded_cyclone");
    expect(w.ledger.balance("traveller")).toBe(120_000 - 21_000);
  });
});
