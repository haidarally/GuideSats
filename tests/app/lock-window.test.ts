// The lock window and the hold limit. The guide's wallet cancels an accepted hold by itself at its
// settle_deadline (24 blocks ahead on the faucet wallets, measured), so the agent may lock only 1 h
// before the tour, and every accepted hold is checked against the deadline its wallet reports: one that
// cannot last until the planned settle moment (tour start + 2 h meeting buffer, 6 blocks to spare) is
// cancelled at once, and the booking says why. The SIMULATED wallets report block-height deadlines too.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld, loadSeed, type SimWorldOptions } from "../../src/app/world";
import type { LightningBackend, ReceiverWallet } from "../../src/ln/backend";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

/** Le Morne tour three days out; the clock is the test's. */
async function farTour(opts: Partial<SimWorldOptions> = {}) {
  const seed = loadSeed();
  seed.tours = seed.tours.map((t) => (t.id === "tour_lemorne" ? { ...t, startInHours: 72 } : t));
  let now = T0;
  const w = await buildSimWorld({ clock: () => now, seed, ...opts });
  const { booking, mandate } = w.svc.proposeBooking("tour_lemorne");
  const s = pair();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s.h, at: now });
  return { w, booking, mandate, ...s, setNow: (t: number) => (now = t) };
}

/** Wraps the guide's wallet (same ledger underneath). */
function withReceiver(w: { svc: unknown; backend: LightningBackend }, f: (r: ReceiverWallet) => Partial<ReceiverWallet>) {
  const be = w.backend;
  (w.svc as { backend: LightningBackend }).backend = {
    kind: be.kind,
    simulated: be.simulated,
    network: be.network,
    payeeProof: be.payeeProof,
    payer: (id) => be.payer(id),
    receiver: (id) => ({ ...be.receiver(id), ...f(be.receiver(id)) }),
  };
}

describe("the lock window", () => {
  it("the agent cannot lock days ahead: the mandate opens 1 h before the tour", async () => {
    const { w, booking, mandate, h } = await farTour();
    expect(mandate.notBefore).toBe(booking.tourStart - HOUR); // (24 - 6) blocks x 10 min - 2 h meeting buffer
    // No hold invoice before the window (it would expire before the agent may pay it, and H cannot be reused)...
    await expect(w.svc.requestInvoice(booking.id)).rejects.toThrow("lock_window_not_open");
    // ...and a hold invoice obtained some other way is refused by the mandate.
    const inv = (await w.backend.receiver("guide_lemorne").makeHoldInvoice({ amountSats: 21_000, paymentHash: h, description: "early", expirySecs: 600 })).invoice;
    expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "mandate_too_early" });
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("a lock at the earliest moment fits the 24-block hold exactly and still settles 2 h after the tour start", async () => {
    const { w, booking, mandate, p, setNow } = await farTour();
    setNow(mandate.notBefore);
    const inv = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toMatchObject({ ok: true, state: "locked" });
    expect(w.svc.audit().find((a) => a.event === "hold_limit_ok")?.fields).toMatchObject({ deadlineKind: "height", spareBlocks: 0 });
    expect(w.svc.booking(booking.id).holdCheckedAt).toBe(mandate.notBefore);
    setNow(booking.tourStart + 2 * HOUR - 60_000); // the guide and the traveller meet late
    expect(await w.svc.reconcile()).toEqual([]);
    await w.svc.settleWithPreimage(booking.id, p);
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("inside the window the agent locks, and the hold outlives the wait until the tour", async () => {
    const { w, booking, p, setNow } = await farTour();
    setNow(booking.tourStart - 30 * 60_000);
    const inv = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: true, state: "locked", amountSats: 21_000 });
    setNow(booking.tourStart);
    expect(await w.svc.reconcile()).toEqual([]);
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

describe("the hold limit the guide's wallet reports", () => {
  it("a wallet that allows only 12 blocks: the hold is cancelled at once and the traveller refunded", async () => {
    const { w, booking, mandate, setNow } = await farTour({ hold: { holdLimitBlocks: 12 } });
    setNow(mandate.notBefore);
    const inv = await w.svc.requestInvoice(booking.id);
    expect(await w.svc.payWithinMandate(booking.id, inv)).toEqual({ ok: false, reason: "hold_limit_too_short" });
    expect(w.svc.booking(booking.id).state).toBe("refunded_hold_limit");
    expect(w.svc.mandate(booking.id)?.status).toBe("used"); // the single use is spent: no second lock
    expect(w.ledger.balance("traveller")).toBe(120_000);
    expect(w.ledger.allHolds().filter((x) => x.state === "accepted")).toEqual([]);
    expect(w.svc.audit().find((a) => a.event === "hold_limit_too_short")?.fields).toMatchObject({ reason: "too_short", deadlineKind: "height", spareBlocks: -12 });
  });

  it("with 12 blocks, a lock 30 min before the tour fits once the meeting buffer is zero", async () => {
    const ok = await farTour({ hold: { holdLimitBlocks: 12 }, config: { meetingBufferMs: 0 } });
    ok.setNow(ok.booking.tourStart - 30 * 60_000); // 3 blocks needed, 6 margin, 3 to spare
    expect(await ok.w.svc.payWithinMandate(ok.booking.id, await ok.w.svc.requestInvoice(ok.booking.id))).toMatchObject({ ok: true, state: "locked" });
    expect(ok.w.svc.audit().find((a) => a.event === "hold_limit_ok")?.fields).toMatchObject({ spareBlocks: 3 });
  });

  it("unix-seconds deadlines are read as times: 4 h fits, 2 h does not", async () => {
    for (const [holdMaxSecs, ok] of [[4 * 3600, true], [2 * 3600, false]] as const) {
      const { w, booking, mandate, setNow } = await farTour({ hold: { deadlineKind: "unix", holdMaxSecs } });
      setNow(mandate.notBefore);
      const r = await w.svc.payWithinMandate(booking.id, await w.svc.requestInvoice(booking.id));
      expect(r.ok).toBe(ok);
      expect(w.svc.booking(booking.id).state).toBe(ok ? "locked" : "refunded_hold_limit");
    }
  });

  it("fails closed: no settle_deadline, or no block height from get_info, means the hold is cancelled", async () => {
    for (const fault of ["no_settle_deadline", "no_block_height"] as const) {
      const { w, booking, mandate, setNow } = await farTour();
      withReceiver(w, (r) =>
        fault === "no_settle_deadline"
          ? { lookupInvoice: async (h) => ({ ...(await r.lookupInvoice(h)), settleDeadline: undefined }) }
          : { getInfo: async () => ({ ...(await r.getInfo()), blockHeight: undefined }) },
      );
      setNow(mandate.notBefore + 30 * 60_000);
      expect(await w.svc.payWithinMandate(booking.id, await w.svc.requestInvoice(booking.id))).toEqual({ ok: false, reason: "hold_limit_too_short" });
      expect(w.svc.audit().find((a) => a.event === "hold_limit_too_short")?.fields.reason).toBe(fault);
      expect(w.ledger.balance("traveller")).toBe(120_000);
    }
  });

  it("if the wallet cannot be asked, the lock stands unchecked and the next tick checks it", async () => {
    const { w, booking, mandate, setNow } = await farTour({ hold: { holdLimitBlocks: 12 } });
    let down = true;
    withReceiver(w, (r) => ({ getInfo: async () => (down ? Promise.reject(new Error("relay down")) : r.getInfo()) }));
    setNow(mandate.notBefore);
    expect(await w.svc.payWithinMandate(booking.id, await w.svc.requestInvoice(booking.id))).toMatchObject({ ok: true, state: "locked" });
    expect(w.svc.booking(booking.id).holdCheckedAt ?? null).toBeNull();
    expect(await w.svc.reconcile()).toEqual([]); // still down
    down = false;
    expect(await w.svc.reconcile()).toEqual([{ bookingId: booking.id, outcome: "refunded_hold_limit" }]);
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("blocks that come much faster than average: the wallet cancels before a late meeting, and the traveller is refunded", async () => {
    const { w, booking, mandate, p, setNow } = await farTour();
    setNow(mandate.notBefore);
    expect((await w.svc.payWithinMandate(booking.id, await w.svc.requestInvoice(booking.id))).ok).toBe(true);
    w.ledger.mine(24);
    expect(await w.svc.reconcile()).toEqual([{ bookingId: booking.id, outcome: "refunded_expired" }]);
    await expect(w.svc.settleWithPreimage(booking.id, p)).rejects.toThrow("not_locked");
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });
});
