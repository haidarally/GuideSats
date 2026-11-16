import { describe, it, expect } from "vitest";
import {
  approveMandate,
  beginSpend,
  checkSpend,
  completeSpend,
  draftMandate,
  MAX_CAP_SATS,
  MandateError,
  releaseSpend,
  retireHash,
  revokeMandate,
  type Mandate,
  type SpendRequest,
} from "../../src/domain/mandate";

const PAYEE = "02" + "11".repeat(32);
const OTHER = "03" + "22".repeat(32);
const H = "ab".repeat(32);
const T0 = Date.parse("2026-11-20T04:00:00Z");
const HOUR = 3_600_000;

function approved(cap = 21_000): Mandate {
  const d = draftMandate({ id: "m1", bookingId: "b1", capSats: cap, payeePubkey: PAYEE, notBefore: T0, notAfter: T0 + 12 * HOUR });
  return approveMandate(d, { actor: "traveller", paymentHash: H, at: T0 - HOUR });
}
const req = (over: Partial<SpendRequest> = {}): SpendRequest => ({ amountSats: 21_000, payeePubkey: PAYEE, paymentHash: H, now: T0 + HOUR, ...over });

describe("draftMandate", () => {
  it("starts pending, with no hash", () => {
    const d = draftMandate({ id: "m", bookingId: "b", capSats: 10, payeePubkey: PAYEE, notBefore: 1, notAfter: 2 });
    expect(d.status).toBe("pending_approval");
    expect(d.paymentHash).toBeNull();
  });
  it.each([
    [{ capSats: 0 }, "positive"],
    [{ capSats: -5 }, "positive"],
    [{ capSats: 1.5 }, "positive"],
    [{ capSats: MAX_CAP_SATS + 1 }, "ceiling"],
    [{ payeePubkey: "04" + "11".repeat(32) }, "33-byte"],
    [{ payeePubkey: "not hex" }, "33-byte"],
    [{ notBefore: 5, notAfter: 5 }, "window"],
  ])("rejects %o", (over, msg) => {
    expect(() => draftMandate({ id: "m", bookingId: "b", capSats: 10, payeePubkey: PAYEE, notBefore: 1, notAfter: 2, ...over })).toThrow(msg);
  });
});

describe("approveMandate", () => {
  const d = draftMandate({ id: "m", bookingId: "b", capSats: 10, payeePubkey: PAYEE, notBefore: T0, notAfter: T0 + HOUR });
  it("only the traveller can approve", () => {
    expect(() => approveMandate(d, { actor: "agent" as "traveller", paymentHash: H, at: T0 })).toThrow(MandateError);
  });
  it("binds the payment hash", () => {
    expect(approveMandate(d, { actor: "traveller", paymentHash: H, at: T0 }).paymentHash).toBe(H);
  });
  it("cannot approve twice (no re-arming with a new hash)", () => {
    const a = approveMandate(d, { actor: "traveller", paymentHash: H, at: T0 });
    expect(() => approveMandate(a, { actor: "traveller", paymentHash: "cd".repeat(32), at: T0 })).toThrow("status approved");
  });
  it("refuses a malformed hash and a closed window", () => {
    expect(() => approveMandate(d, { actor: "traveller", paymentHash: "xyz", at: T0 })).toThrow("hash");
    expect(() => approveMandate(d, { actor: "traveller", paymentHash: H, at: T0 + 2 * HOUR })).toThrow("closed");
  });
});

describe("checkSpend", () => {
  const m = approved();
  it("allows the exact spend inside the window", () => expect(checkSpend(m, req())).toEqual({ ok: true }));
  it("allows a spend below the cap", () => expect(checkSpend(m, req({ amountSats: 20_000 })).ok).toBe(true));
  it.each<[Partial<SpendRequest>, string]>([
    [{ amountSats: 21_001 }, "over_cap"],
    [{ amountSats: 0 }, "bad_amount"],
    [{ amountSats: 10.5 }, "bad_amount"],
    [{ payeePubkey: OTHER }, "wrong_payee"],
    [{ paymentHash: "cd".repeat(32) }, "wrong_hash"],
    [{ now: T0 - 1 }, "too_early"],
    [{ now: T0 + 12 * HOUR + 1 }, "too_late"],
  ])("refuses %o -> %s", (over, reason) => {
    expect(checkSpend(m, req(over))).toEqual({ ok: false, reason });
  });
  it("refuses an unapproved mandate", () => {
    const d = draftMandate({ id: "m", bookingId: "b", capSats: 99_999, payeePubkey: PAYEE, notBefore: T0, notAfter: T0 + HOUR });
    expect(checkSpend(d, req())).toEqual({ ok: false, reason: "not_approved" });
  });
  it("refuses a revoked mandate", () => expect(checkSpend(revokeMandate(m), req())).toEqual({ ok: false, reason: "revoked" }));
});

describe("single use", () => {
  it("begin -> complete makes it used, and a second spend is refused", () => {
    const c = beginSpend(approved(), req());
    expect(c.status).toBe("consuming");
    expect(checkSpend(c, req())).toEqual({ ok: false, reason: "in_flight" });
    const u = completeSpend(c);
    expect(checkSpend(u, req())).toEqual({ ok: false, reason: "already_used" });
    expect(() => beginSpend(u, req())).toThrow("already_used");
    expect(() => revokeMandate(u)).toThrow("used");
  });
  it("release after a definite failure re-arms it once", () => {
    const r = releaseSpend(beginSpend(approved(), req()));
    expect(r.status).toBe("approved");
    expect(() => releaseSpend(r)).toThrow();
    expect(() => completeSpend(r)).toThrow();
  });
});

describe("plan B mandate (no hash: the guide's wallet picks it after the tour)", () => {
  const d = draftMandate({ id: "m", bookingId: "b", capSats: 12_000, payeePubkey: PAYEE, notBefore: T0, notAfter: T0 + HOUR, requireHash: false });
  it("approves with no hash, and refuses a hash", () => {
    expect(approveMandate(d, { actor: "traveller", paymentHash: null, at: T0 }).status).toBe("approved");
    expect(() => approveMandate(d, { actor: "traveller", paymentHash: H, at: T0 })).toThrow("does not bind");
  });
  it("a hold-mode mandate refuses a null hash", () => {
    const h = draftMandate({ id: "m", bookingId: "b", capSats: 12_000, payeePubkey: PAYEE, notBefore: T0, notAfter: T0 + HOUR });
    expect(() => approveMandate(h, { actor: "traveller", paymentHash: null, at: T0 })).toThrow("hash");
  });
  it("still enforces cap, payee, window and single use", () => {
    const a = approveMandate(d, { actor: "traveller", paymentHash: null, at: T0 });
    const ok = { amountSats: 12_000, payeePubkey: PAYEE, paymentHash: "cd".repeat(32), now: T0 + 1 };
    expect(checkSpend(a, ok)).toEqual({ ok: true });
    expect(checkSpend(a, { ...ok, amountSats: 12_001 })).toEqual({ ok: false, reason: "over_cap" });
    expect(checkSpend(a, { ...ok, payeePubkey: OTHER })).toEqual({ ok: false, reason: "wrong_payee" });
    expect(checkSpend(a, { ...ok, now: T0 + 2 * HOUR })).toEqual({ ok: false, reason: "too_late" });
    expect(checkSpend(completeSpend(beginSpend(a, ok)), ok)).toEqual({ ok: false, reason: "already_used" });
  });
});

describe("retireHash (hold mode: the hold invoice for H died unpaid)", () => {
  const H2 = "cd".repeat(32);
  it("re-opens the mandate for the traveller only, and H can never be approved again", () => {
    const r = retireHash(approved());
    expect(r).toMatchObject({ status: "pending_approval", paymentHash: null, retiredHashes: [H] });
    expect(checkSpend(r, req())).toEqual({ ok: false, reason: "not_approved" });
    expect(() => approveMandate(r, { actor: "traveller", paymentHash: H, at: T0 })).toThrow("make a new secret");
    const again = approveMandate(r, { actor: "traveller", paymentHash: H2, at: T0 });
    expect(again).toMatchObject({ status: "approved", paymentHash: H2, retiredHashes: [H] });
    expect(checkSpend(again, req())).toEqual({ ok: false, reason: "wrong_hash" }); // the old H is refused
    expect(checkSpend(again, req({ paymentHash: H2 }))).toEqual({ ok: true });
  });
  it("works from consuming (reconcile, once the wallet says the hold is dead), never from used, revoked or pending", () => {
    const consuming = beginSpend(approved(), req());
    expect(retireHash(consuming).status).toBe("pending_approval");
    expect(() => retireHash(completeSpend(consuming))).toThrow(MandateError);
    expect(() => retireHash(revokeMandate(approved()))).toThrow(MandateError);
    expect(() => retireHash(retireHash(approved()))).toThrow(MandateError);
  });
});
