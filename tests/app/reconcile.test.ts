// The reconcile step: every unresolved payment is resolved from the guide's wallet (lookup_invoice by
// hash) on the watcher's tick, and once right after a pay call ends without a clear answer. Outcomes are
// never decided from error text, every change is a compare-and-set, and running it again changes nothing.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld } from "../../src/app/world";
import { loadFixture, replayShifted } from "../../src/feeds/gdacs";
import type { GdacsFeed } from "../../src/domain/cyclone";
import type { LightningBackend, PayerWallet, PayOutcome } from "../../src/ln/backend";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

interface Faults {
  lookupDown: boolean; // the relay is down: lookup_invoice throws
  failLookups: number; // the next n lookups throw
  cancelDown: boolean; // cancel_hold_invoice throws
  gate: Promise<void> | null; // lookups wait for the test to open the gate
  payer: ((p: PayerWallet) => PayerWallet) | null;
}

async function world(feed?: () => GdacsFeed) {
  let now = T0;
  const w = await buildSimWorld({ clock: () => now, feed, config: { acceptTimeoutMs: 30, pollMs: 5 } });
  const be = w.backend;
  const f: Faults = { lookupDown: false, failLookups: 0, cancelDown: false, gate: null, payer: null };
  const wrapped: LightningBackend = {
    kind: be.kind,
    simulated: be.simulated,
    network: be.network,
    payeeProof: be.payeeProof,
    payer: (id) => (f.payer ? f.payer(be.payer(id)) : be.payer(id)),
    receiver: (id) => {
      const r = be.receiver(id);
      return {
        ...r,
        lookupInvoice: async (h) => {
          if (f.gate) await f.gate;
          if (f.lookupDown || f.failLookups-- > 0) throw new Error("relay down");
          return r.lookupInvoice(h);
        },
        cancelHoldInvoice: async (h) => {
          if (f.cancelDown) throw new Error("relay down");
          return r.cancelHoldInvoice(h);
        },
      };
    },
  };
  (w.svc as unknown as { backend: LightningBackend }).backend = wrapped;
  return { ...w, f, tick: (ms: number) => (now += ms) };
}
type W = Awaited<ReturnType<typeof world>>;

async function approvedBooking(w: W, tour = "tour_lemorne") {
  const { booking } = w.svc.proposeBooking(tour);
  const { p, h } = pair();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: w.clock() });
  const inv = await w.svc.requestInvoice(booking.id);
  return { id: booking.id, p, h, inv };
}

/** Like the NWC adapter on the measured wallets: a cancelled hold makes pay_invoice reject (INTERNAL), i.e. "unknown". */
const nwcLikePayer = (p: PayerWallet): PayerWallet => ({
  ...p,
  payInvoice: async (inv) => {
    const o = await p.payInvoice(inv);
    return o.status === "refunded" ? { status: "unknown", error: "INTERNAL" } : o;
  },
});
const count = (w: W, event: string) => w.svc.audit(1000).filter((a) => a.event === event).length;

describe("the reconcile step", () => {
  it("an unknown lock (relay down during the pay) is locked by the next tick, exactly once", async () => {
    const w = await world();
    const { id, p, inv } = await approvedBooking(w);
    w.f.lookupDown = true;
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
    expect(w.svc.mandate(id)?.status).toBe("consuming");
    expect(await w.svc.reconcile()).toEqual([]); // still down: nothing decided
    w.f.lookupDown = false;
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "locked" }]);
    expect(await w.svc.reconcile()).toEqual([]); // idempotent
    expect(w.svc.booking(id).state).toBe("locked");
    expect(w.svc.mandate(id)?.status).toBe("used");
    expect(count(w, "locked")).toBe(1);
    await w.svc.settleWithPreimage(id, p);
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("the guide's wallet cancels the hold and pay_invoice rejects with an error: lookup decides, H is retired", async () => {
    const w = await world();
    const { id, h, inv } = await approvedBooking(w);
    w.f.payer = nwcLikePayer;
    let open!: () => void;
    w.f.gate = new Promise<void>((r) => (open = r));
    const pending = w.svc.payWithinMandate(id, inv);
    expect(w.ledger.balance("traveller")).toBe(120_000 - 21_000); // the sats sit in the hold
    await w.backend.receiver("guide_lemorne").cancelHoldInvoice(h); // e.g. the guide cancels in their own wallet
    w.f.lookupDown = true;
    open();
    expect(await pending).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" }); // the wallet's error decides nothing
    w.f.gate = null;
    w.f.lookupDown = false;
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "reapproval_needed" }]);
    expect(w.svc.booking(id)).toMatchObject({ state: "reapproval_needed", paymentHash: null, invoice: null });
    expect(w.svc.mandate(id)).toMatchObject({ status: "pending_approval", paymentHash: null, retiredHashes: [h] });
    expect(w.ledger.balance("traveller")).toBe(120_000);
    expect(await w.svc.reconcile()).toEqual([]);
    expect(await w.svc.payWithinMandate(id, inv)).toMatchObject({ ok: false }); // the old invoice is dead for the app
    w.svc.cancelByTraveller(id); // no payment in flight any more, so the traveller may cancel
    expect(w.svc.mandate(id)?.status).toBe("revoked");
  });

  it("an accepted hold right after an unknown pay result is locked by the pay path's own lookup", async () => {
    const w = await world();
    const { id, inv } = await approvedBooking(w);
    // The payer answers "unknown" at once (e.g. a reply timeout) although the payment did land.
    w.f.payer = (p) => ({ ...p, payInvoice: async (i) => (void p.payInvoice(i), { status: "unknown", error: "Nip47ReplyTimeoutError" } as PayOutcome) });
    w.f.failLookups = 1; // the wait-for-accepted lookup fails, then the pay path ends on "unknown"
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: true, state: "locked", amountSats: 21_000 });
    expect(w.svc.mandate(id)?.status).toBe("used");
  });

  it("race: the tick and the pay path both see the hold accepted; one locks and nobody cancels it", async () => {
    const w = await world();
    const { id, inv } = await approvedBooking(w);
    let open!: () => void;
    w.f.gate = new Promise<void>((r) => (open = r));
    const pay = w.svc.payWithinMandate(id, inv);
    const tick = w.svc.reconcile();
    open();
    const [r, t] = await Promise.all([pay, tick]);
    expect(r).toEqual({ ok: true, state: "locked", amountSats: 21_000 });
    expect(t.length).toBeLessThanOrEqual(1);
    expect(w.svc.booking(id).state).toBe("locked");
    expect(count(w, "locked")).toBe(1);
    expect(count(w, "lock_aborted_booking_changed")).toBe(0);
    expect(w.ledger.allHolds().filter((x) => x.payer === "traveller").map((x) => x.state)).toEqual(["accepted"]);
  });

  it("race with the cyclone rule after an unknown outcome: refunded, booking skipped, mandate closed once", async () => {
    let feed: GdacsFeed = { features: [] };
    const w = await world(() => feed);
    const { id, inv } = await approvedBooking(w);
    w.f.lookupDown = true;
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
    feed = replayShifted(loadFixture("tc-2024-01-belal.json"), T0 - 6 * HOUR);
    await w.svc.applyCycloneRule();
    expect(w.svc.booking(id).state).toBe("skipped_cyclone");
    expect(w.ledger.balance("traveller")).toBe(120_000);
    expect(w.svc.mandate(id)?.status).toBe("consuming"); // left behind on a terminal booking...
    w.f.lookupDown = false;
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "revoked" }]); // ...and picked up
    expect(await w.svc.reconcile()).toEqual([]);
    expect(w.svc.booking(id).state).toBe("skipped_cyclone");
  });

  it("the guide settled at their wallet while the outcome was unknown: settled", async () => {
    const w = await world();
    const { id, p, inv } = await approvedBooking(w);
    w.f.lookupDown = true;
    await w.svc.payWithinMandate(id, inv);
    await w.backend.receiver("guide_lemorne").settleHoldInvoice(p);
    w.f.lookupDown = false;
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "settled" }]);
    expect(w.svc.booking(id).state).toBe("settled");
    expect(w.svc.mandate(id)?.status).toBe("used");
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("the guide's settle and the tick race on a locked booking: settled once, no error", async () => {
    const w = await world();
    const { id, p, inv } = await approvedBooking(w);
    expect((await w.svc.payWithinMandate(id, inv)).ok).toBe(true);
    let open!: () => void;
    w.f.gate = new Promise<void>((r) => (open = r));
    const tick = w.svc.reconcile(); // waits on the lookup
    await w.svc.settleWithPreimage(id, p);
    open();
    expect(await tick).toEqual([]);
    expect(w.svc.booking(id).state).toBe("settled");
    expect(count(w, "settled_at_wallet")).toBe(0);
  });

  it("an invoice that expired unpaid is cancelled at the wallet before it is released; if that fails, it waits", async () => {
    const w = await world();
    const { id, h, inv } = await approvedBooking(w);
    w.f.payer = (p) => ({ ...p, payInvoice: async () => ({ status: "unknown", error: "Nip47ReplyTimeoutError" }) }); // nothing moved
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
    expect(await w.svc.reconcile()).toEqual([]); // still open at the wallet
    w.tick(2 * HOUR); // past the invoice's expiry
    w.f.cancelDown = true;
    expect(await w.svc.reconcile()).toEqual([]);
    expect(w.svc.mandate(id)?.status).toBe("consuming");
    w.f.cancelDown = false;
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "reapproval_needed" }]);
    expect(w.svc.mandate(id)?.retiredHashes).toEqual([h]);
  });

  it("plan B: an unknown payment that landed is recorded as paid; one that did not stays reserved", async () => {
    for (const landed of [true, false]) {
      const w = await world();
      const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
      w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: w.clock() });
      w.tick(9 * HOUR);
      w.svc.confirmTourHappened(booking.id);
      const inv = await w.svc.requestInvoice(booking.id);
      w.f.payer = (p) => ({ ...p, payInvoice: async (i) => (landed && (await p.payInvoice(i)), { status: "unknown", error: "Nip47ReplyTimeoutError" }) });
      w.f.lookupDown = true;
      expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
      w.f.lookupDown = false;
      w.tick(HOUR); // even past the invoice's expiry, plan B never re-arms on its own
      expect(await w.svc.reconcile()).toEqual(landed ? [{ bookingId: booking.id, outcome: "paid" }] : []);
      expect(w.svc.booking(booking.id).state).toBe(landed ? "paid" : "mandated");
      expect(w.svc.mandate(booking.id)?.status).toBe(landed ? "used" : "consuming");
      expect(w.ledger.balance("guide_lagoon")).toBe(landed ? 12_000 : 0);
    }
  });
});
