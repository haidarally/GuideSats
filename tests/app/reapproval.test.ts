// Hold mode: a hold invoice that expires before the agent paid it can never be paid, and its H cannot be
// bound to a new hold invoice. The traveller approves again with a NEW secret; the old secret, the old H
// and the old invoice must never work again (replay test).
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld } from "../../src/app/world";
import { agentFacade } from "../../src/agent/tools";
import { runAgent } from "../../src/agent/planner";
import { invoiceExpiresAt } from "../../src/ln/invoiceCheck";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

async function expiredInvoice() {
  let now = T0;
  const w = await buildSimWorld({ clock: () => now });
  const { booking } = w.svc.proposeBooking("tour_lemorne");
  const s1 = pair();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s1.h, at: now });
  const inv1 = await w.svc.requestInvoice(booking.id); // the agent asks, then never pays (e.g. its wallet was offline)
  now = invoiceExpiresAt(inv1)! + 1000;
  return { w, id: booking.id, s1, inv1, setNow: (t: number) => (now = t), now: () => now };
}

describe("hold mode: re-approval with a new secret after the hold invoice expired", () => {
  it("the agent's next request retires H, and the booking waits for the traveller", async () => {
    const { w, id, s1 } = await expiredInvoice();
    await expect(w.svc.requestInvoice(id)).rejects.toThrow("reapproval_needed");
    expect(w.svc.booking(id)).toMatchObject({ state: "reapproval_needed", paymentHash: null, invoice: null });
    expect(w.svc.mandate(id)).toMatchObject({ status: "pending_approval", paymentHash: null, retiredHashes: [s1.h] });
    expect(w.ledger.holdState("guide_lemorne", s1.h)).toBe("expired");
    // The agent cannot approve again: it has no such tool, and the planner stops.
    expect((await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: id })).outcome).toBe("waiting_for_traveller_to_approve_again_with_a_new_code");
  });

  it("the watcher's reconcile step does it too, without the agent", async () => {
    const { w, id } = await expiredInvoice();
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "reapproval_needed" }]);
    expect(await w.svc.reconcile()).toEqual([]);
  });

  it("an invoice that is still payable is kept, and the old one is cancelled at the wallet when it is retired early", async () => {
    const { w, id, s1, inv1, setNow } = await expiredInvoice();
    setNow(invoiceExpiresAt(inv1)! - 120_000); // two minutes left: still payable
    expect(await w.svc.requestInvoice(id)).toBe(inv1);
    setNow(invoiceExpiresAt(inv1)! - 30_000); // under a minute: dead for the app, and cancelled at the wallet
    expect(await w.svc.reconcile()).toEqual([{ bookingId: id, outcome: "reapproval_needed" }]);
    expect(w.ledger.holdState("guide_lemorne", s1.h)).toBe("cancelled");
  });

  it("replay: the old H, the old invoice and the old secret never work again; the new secret pays the guide once", async () => {
    const { w, id, s1, inv1 } = await expiredInvoice();
    await w.svc.reconcile();
    // 1. The old H cannot be approved again.
    expect(() => w.svc.approveMandate(id, { actor: "traveller", paymentHash: s1.h, at: w.clock() })).toThrow("payment_hash_reused");
    // 2. A new secret is approved.
    const s2 = pair();
    w.svc.approveMandate(id, { actor: "traveller", paymentHash: s2.h, at: w.clock() });
    expect(w.svc.booking(id)).toMatchObject({ state: "mandated", paymentHash: s2.h });
    // 3. The old invoice is refused by the app (wrong hash now) and by the wallets (dead hold).
    expect(await w.svc.payWithinMandate(id, inv1)).toMatchObject({ ok: false });
    expect(await w.backend.payer("traveller").payInvoice(inv1)).toMatchObject({ status: "failed" });
    await expect(w.backend.receiver("guide_lemorne").makeHoldInvoice({ amountSats: 21_000, paymentHash: s1.h, description: "again", expirySecs: 600 })).rejects.toThrow();
    // 4. The agent locks with the new H.
    expect((await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: id })).outcome).toBe("locked");
    // 5. The old secret cannot settle, at the app or at the wallet.
    await expect(w.svc.settleWithPreimage(id, s1.p)).rejects.toThrow("preimage_mismatch");
    await expect(w.backend.receiver("guide_lemorne").settleHoldInvoice(s1.p)).rejects.toThrow();
    // 6. The new one does, once.
    await w.svc.settleWithPreimage(id, s2.p);
    await expect(w.svc.settleWithPreimage(id, s2.p)).rejects.toThrow("not_locked");
    expect(w.ledger.balance("guide_lemorne")).toBe(21_000);
    expect(w.ledger.balance("traveller")).toBe(120_000 - 21_000);
    expect(w.svc.mandate(id)).toMatchObject({ status: "used", retiredHashes: [s1.h] });
  });

  it("no re-approval while a payment is in flight, and none once the lock window has closed", async () => {
    const { w, id, setNow } = await expiredInvoice();
    expect(() => w.svc.approveMandate(id, { actor: "traveller", paymentHash: pair().h, at: w.clock() })).toThrow(); // still "mandated"/"approved"
    await w.svc.reconcile();
    setNow(w.svc.booking(id).tourStart + 1);
    expect(() => w.svc.approveMandate(id, { actor: "traveller", paymentHash: pair().h, at: w.clock() })).toThrow("window already closed");
    w.svc.cancelByTraveller(id);
    expect(w.svc.booking(id).state).toBe("cancelled");
    expect(w.svc.mandate(id)?.status).toBe("revoked");
  });
});
