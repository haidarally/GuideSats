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
