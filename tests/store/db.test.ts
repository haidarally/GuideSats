import { describe, it, expect } from "vitest";
import { Store } from "../../src/store/db";
import { approveMandate, beginSpend, draftMandate } from "../../src/domain/mandate";

const m0 = draftMandate({ id: "md_1", bookingId: "bk_1", capSats: 1000, payeePubkey: "02" + "11".repeat(32), notBefore: 0, notAfter: 10_000 });

describe("Store (node:sqlite)", () => {
  it("compare-and-set refuses a stale status (single use is atomic)", () => {
    const s = new Store();
    s.insertMandate(m0);
    const a = approveMandate(m0, { actor: "traveller", paymentHash: "ab".repeat(32), at: 1 });
    expect(s.casMandate(a, "pending_approval")).toBe(true);
    const c = beginSpend(a, { amountSats: 1000, payeePubkey: m0.payeePubkey, paymentHash: "ab".repeat(32), now: 5 });
    expect(s.casMandate(c, "approved")).toBe(true);
    expect(s.casMandate(c, "approved")).toBe(false); // a second payer sees the stale status
    expect(s.getMandate("md_1")?.status).toBe("consuming");
    expect(s.mandateForBooking("bk_1")?.id).toBe("md_1");
  });
  it("one mandate per booking", () => {
    const s = new Store();
    s.insertMandate(m0);
    expect(() => s.insertMandate({ ...m0, id: "md_2" })).toThrow();
  });
  it("stores the audit trail redacted", () => {
    const s = new Store();
    const p = "00".repeat(31) + "09";
    s.audit(1, "settled", { preimage: p, note: `P=${p}`, paymentHash: "ab".repeat(32) });
    const [e] = s.listAudit();
    expect(JSON.stringify(e)).not.toContain(p);
    expect(e?.fields.paymentHash).toBe("ab".repeat(32));
  });
});
