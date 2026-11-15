import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld } from "../../src/app/world";
import { loadFixture, replayShifted } from "../../src/feeds/gdacs";
import type { GdacsFeed } from "../../src/domain/cyclone";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

async function world(feed?: () => GdacsFeed) {
  let now = T0;
  const w = await buildSimWorld({ clock: () => now, feed });
  return { ...w, tick: (ms: number) => (now += ms) };
}

async function lockedBooking(w: Awaited<ReturnType<typeof world>>, tourId = "tour_lemorne") {
  const { booking } = w.svc.proposeBooking(tourId);
  const { p, h } = pair();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: w.clock() });
  const inv = await w.svc.requestInvoice(booking.id);
  const r = await w.svc.payWithinMandate(booking.id, inv);
  return { booking, p, h, inv, r };
}

describe("BookingService on the SIMULATED backend", () => {
  it("happy path: propose -> approve -> lock -> settle with P", async () => {
    const w = await world();
    const { booking, p, r } = await lockedBooking(w);
    expect(r).toEqual({ ok: true, state: "locked", amountSats: 21_000 });
    expect(w.ledger.balance("traveller")).toBe(120_000 - 21_000);
    expect(w.svc.booking(booking.id).state).toBe("locked");
    expect(w.svc.mandate(booking.id)?.status).toBe("used");
    await w.svc.settleWithPreimage(booking.id, p);
    expect(w.svc.booking(booking.id).state).toBe("settled");
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("the guide cannot settle with a wrong P", async () => {
    const w = await world();
    const { booking } = await lockedBooking(w);
    await expect(w.svc.settleWithPreimage(booking.id, "00".repeat(32))).rejects.toThrow("preimage_mismatch");
    await expect(w.svc.settleWithPreimage(booking.id, "nope")).rejects.toThrow("bad_preimage");
  });

  it("a cyclone alert after the lock cancels the hold and refunds the traveller", async () => {
    let feed: GdacsFeed = { features: [] };
    const w = await world(() => feed);
    const { booking } = await lockedBooking(w);
    feed = replayShifted(loadFixture("tc-2024-01-belal.json"), T0 - 6 * HOUR);
    const r = await w.svc.applyCycloneRule();
    expect(r.verdicts.map((v) => v.bookingId)).toEqual([booking.id]);
    expect(w.svc.booking(booking.id).state).toBe("refunded_cyclone");
    expect(w.ledger.balance("traveller")).toBe(120_000);
    expect(w.ledger.balance("guide_lemorne")).toBe(0);
  });

  it("a cyclone alert before the lock means nothing is ever locked", async () => {
    const w = await world(() => replayShifted(loadFixture("tc-2024-01-belal.json"), T0 - 6 * HOUR));
    const { booking } = w.svc.proposeBooking("tour_chamarel");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
    const inv = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "cyclone_alert" });
    await w.svc.applyCycloneRule();
    expect(w.svc.booking(booking.id).state).toBe("skipped_cyclone");
    expect(w.svc.mandate(booking.id)?.status).toBe("revoked");
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("a hold that is never settled times out and is marked refunded", async () => {
    const w = await world();
    const { booking } = await lockedBooking(w);
    w.tick(13 * HOUR);
    expect(await w.svc.reconcileHolds()).toEqual([booking.id]);
    expect(w.svc.booking(booking.id).state).toBe("refunded_expired");
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("two concurrent payments on one mandate: exactly one locks", async () => {
    const w = await world();
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
    const inv = await w.svc.requestInvoice(booking.id);
    const [a, b] = await Promise.all([w.svc.payWithinMandate(booking.id, inv), w.svc.payWithinMandate(booking.id, inv)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(w.ledger.balance("traveller")).toBe(120_000 - 21_000);
  });

  it("an unapproved booking cannot get an invoice or be paid", async () => {
    const w = await world();
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    await expect(w.svc.requestInvoice(booking.id)).rejects.toThrow("not_mandated");
    expect(await w.svc.payWithinMandate(booking.id, "lnbcrt1x")).toMatchObject({ ok: false, reason: "booking_not_payable:proposed" });
  });

  it("the traveller can cancel before the lock, which revokes the mandate", async () => {
    const w = await world();
    const { booking } = w.svc.proposeBooking("tour_lagoon");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() });
    w.svc.cancelByTraveller(booking.id);
    expect(w.svc.booking(booking.id).state).toBe("cancelled");
    expect(w.svc.mandate(booking.id)?.status).toBe("revoked");
  });

  it("the audit trail never holds a preimage", async () => {
    const w = await world();
    const { booking, p } = await lockedBooking(w);
    await w.svc.settleWithPreimage(booking.id, p);
    expect(JSON.stringify(w.svc.audit())).not.toContain(p);
  });

  it("plan B: pay on completion, only after the traveller confirms the tour happened", async () => {
    const w = await world();
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    expect(() => w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: pair().h, at: w.clock() })).toThrow("plan_b_takes_no_hash");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: w.clock() });
    await expect(w.svc.requestInvoice(booking.id)).rejects.toThrow("not_confirmed_by_traveller");
    expect(() => w.svc.confirmTourHappened(booking.id)).toThrow("tour_not_started");
    w.tick(9 * HOUR); // the lagoon tour starts at +6 h and lasts 2 h
    w.svc.confirmTourHappened(booking.id);
    const inv = await w.svc.requestInvoice(booking.id);
    const r = await w.svc.payWithinMandate(booking.id, inv);
    expect(r).toEqual({ ok: true, state: "paid", amountSats: 12_000 });
    expect(w.svc.booking(booking.id).state).toBe("paid");
    expect(w.ledger.balance("guide_lagoon")).toBe(12_000);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toMatchObject({ ok: false });
  });

  it("plan B: an invoice the app did not ask the guide's wallet for is refused", async () => {
    const w = await world();
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: w.clock() });
    w.tick(9 * HOUR);
    w.svc.confirmTourHappened(booking.id);
    await w.svc.requestInvoice(booking.id);
    const other = await w.backend.receiver("guide_lagoon").makeInvoice({ amountSats: 12_000, description: "second", expirySecs: 600 });
    expect(await w.svc.payWithinMandate(booking.id, other.invoice)).toEqual({ ok: false, reason: "invoice_wrong_hash" });
    expect(w.ledger.balance("guide_lagoon")).toBe(0);
  });

  it("plan B: a cyclone means nothing is ever paid", async () => {
    let feed: GdacsFeed = { features: [] };
    const w = await world(() => feed);
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: w.clock() });
    feed = replayShifted(loadFixture("tc-2024-01-belal.json"), T0 - 6 * HOUR);
    await w.svc.applyCycloneRule();
    expect(w.svc.booking(booking.id).state).toBe("skipped_cyclone");
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });
});
