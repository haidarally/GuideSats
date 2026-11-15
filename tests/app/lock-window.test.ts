// Review (adversarial pass): the hold-mode mandate must not open before lockLeadHours ahead of
// the tour. An earlier lock would sit in an HTLC longer than the hold can live (settle_deadline),
// so it would time out before the meeting and the guide could never be paid.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld, loadSeed } from "../../src/app/world";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

describe("the lock window", () => {
  it("the agent cannot lock days ahead: the mandate opens lockLeadHours before the tour", async () => {
    const seed = loadSeed();
    seed.tours = seed.tours.map((t) => (t.id === "tour_lemorne" ? { ...t, startInHours: 72 } : t));
    let now = T0;
    const w = await buildSimWorld({ clock: () => now, seed });
    const { booking, mandate } = w.svc.proposeBooking("tour_lemorne");
    expect(mandate.notBefore).toBe(booking.tourStart - 10 * HOUR); // 12 h hold limit minus a 2 h meeting buffer
    const { h } = pair();
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: w.clock() });
    // No hold invoice before the window (it would expire before the agent may pay it, and H cannot be reused)...
    await expect(w.svc.requestInvoice(booking.id)).rejects.toThrow("lock_window_not_open");
    // ...and a hold invoice obtained some other way is refused by the mandate.
    const inv = (await w.backend.receiver("guide_lemorne").makeHoldInvoice({ amountSats: 21_000, paymentHash: h, description: "early", expirySecs: 600 })).invoice;
    expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "mandate_too_early" });
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("a lock made the moment the window opens still settles at a meeting up to 2 h late (hold limit 12 h)", async () => {
    const seed = loadSeed();
    seed.tours = seed.tours.map((t) => (t.id === "tour_lemorne" ? { ...t, startInHours: 72 } : t));
    let now = T0;
    const w = await buildSimWorld({ clock: () => now, seed });
    const { booking, mandate } = w.svc.proposeBooking("tour_lemorne");
    const { p, h } = pair();
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: now });
    now = mandate.notBefore; // the earliest moment the agent may lock
    const inv = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toMatchObject({ ok: true, state: "locked" });
    now = booking.tourStart + 2 * HOUR - 60_000; // the guide and the traveller meet late
    expect(await w.svc.reconcileHolds()).toEqual([]);
    await w.svc.settleWithPreimage(booking.id, p);
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("inside the window the agent locks as before, and the hold outlives the wait until the tour", async () => {
    const seed = loadSeed();
    seed.tours = seed.tours.map((t) => (t.id === "tour_lemorne" ? { ...t, startInHours: 72 } : t));
    let now = T0;
    const w = await buildSimWorld({ clock: () => now, seed, config: { invoiceExpirySecs: 3600 } });
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    const { p, h } = pair();
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: w.clock() });
    now = booking.tourStart - 9 * HOUR; // the window opened an hour ago
    const inv = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: true, state: "locked", amountSats: 21_000 });
    now = booking.tourStart; // the meeting: the 12 h hold has not timed out
    expect(await w.svc.reconcileHolds()).toEqual([]);
    await w.svc.settleWithPreimage(booking.id, p);
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("plan B: an expired cached invoice is replaced by a fresh one from the guide's wallet", async () => {
    let now = T0;
    const w = await buildSimWorld({ clock: () => now });
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: now });
    now += 9 * HOUR;
    w.svc.confirmTourHappened(booking.id);
    const first = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.requestInvoice(booking.id)).toBe(first); // still payable: reused
    now += 11 * 60_000; // plan B invoices live 10 minutes
    const second = await w.svc.requestInvoice(booking.id);
    expect(second).not.toBe(first);
    expect(await w.svc.payWithinMandate(booking.id, first)).toMatchObject({ ok: false }); // the old one is dead
    expect(await w.svc.payWithinMandate(booking.id, second)).toEqual({ ok: true, state: "paid", amountSats: 12_000 });
    expect(w.ledger.balance("guide_lagoon")).toBe(12_000);
  });
});
