// A wallet reply that arrives late must never overwrite what happened since: a newer reservation of the
// mandate (after a re-approval), or the invoice hash a payment in flight is pinned to.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld } from "../../src/app/world";
import type { LightningBackend, MadeInvoice, PayOutcome } from "../../src/ln/backend";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A world whose payer holds chosen invoices, and whose guide wallet holds plan-B invoice requests, until the test lets them go. */
async function slowWorld() {
  let now = T0;
  const w = await buildSimWorld({ clock: () => now, config: { acceptTimeoutMs: 5000, pollMs: 2 } });
  const be = w.backend;
  const heldPays = new Map<string, (o: PayOutcome) => void>();
  const holdPay = new Set<string>();
  const heldMakes: (() => void)[] = [];
  let holdMakes = false;
  const wrapped: LightningBackend = {
    kind: be.kind,
    simulated: be.simulated,
    network: be.network,
    payeeProof: be.payeeProof,
    payer: (id) => ({
      ...be.payer(id),
      payInvoice: (inv) => (holdPay.has(inv) ? new Promise<PayOutcome>((r) => heldPays.set(inv, r)) : be.payer(id).payInvoice(inv)),
    }),
    receiver: (id) => ({
      ...be.receiver(id),
      makeInvoice: (req) =>
        holdMakes ? new Promise<MadeInvoice>((r, j) => heldMakes.push(() => be.receiver(id).makeInvoice(req).then(r, j))) : be.receiver(id).makeInvoice(req),
    }),
  };
  (w.svc as unknown as { backend: LightningBackend }).backend = wrapped;
  return {
    ...w,
    holdPay,
    heldPays,
    heldMakes,
    holdMakes: (on: boolean) => (holdMakes = on),
    setNow: (t: number) => (now = t),
    travellerPayer: () => be.payer(w.seed.traveller.id),
  };
}

describe("late wallet replies", () => {
  it("hold: a failed first payment that answers after a re-approval does not undo the new reservation", async () => {
    const w = await slowWorld();
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    const s1 = pair();
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s1.h, at: w.clock() });
    const inv1 = await w.svc.requestInvoice(booking.id);

    // Payment 1 is sent, but its wallet does not answer yet.
    w.holdPay.add(inv1);
    const pay1 = w.svc.payWithinMandate(booking.id, inv1);
    await settle();
    expect(w.svc.mandate(booking.id)?.status).toBe("consuming");

    // Its hold invoice dies at the guide's wallet; the reconcile step retires H1 and the traveller approves again.
    w.ledger.cancel("guide_lemorne", s1.h);
    expect((await w.svc.reconcile()).map((r) => r.outcome)).toEqual(["reapproval_needed"]);
    const s2 = pair();
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s2.h, at: w.clock() });
    const inv2 = await w.svc.requestInvoice(booking.id);

    // Payment 2 reserves the mandate for H2 and is in flight...
    w.holdPay.add(inv2);
    const pay2 = w.svc.payWithinMandate(booking.id, inv2);
    await settle();
    expect(w.svc.mandate(booking.id)).toMatchObject({ status: "consuming", paymentHash: s2.h });

    // ...when payment 1's wallet finally says it failed.
    w.heldPays.get(inv1)!({ status: "failed", error: "PAYMENT_FAILED" });
    expect((await pay1).ok).toBe(false);
    // The newer reservation is untouched: H2 still reserved, H1 still retired.
    expect(w.svc.mandate(booking.id)).toMatchObject({ status: "consuming", paymentHash: s2.h, retiredHashes: [s1.h] });

    // Payment 2 lands: the booking is locked with H2, and no hold is left without a locked booking.
    void w.travellerPayer().payInvoice(inv2).then(w.heldPays.get(inv2));
    expect(await pay2).toMatchObject({ ok: true, state: "locked" });
    expect(w.svc.booking(booking.id)).toMatchObject({ state: "locked", paymentHash: s2.h });
    expect(w.svc.mandate(booking.id)).toMatchObject({ status: "used", paymentHash: s2.h, retiredHashes: [s1.h] });
    expect(w.ledger.allHolds().filter((h) => h.state === "accepted").map((h) => h.paymentHash)).toEqual([s2.h]);
    // H1 can never come back.
    await expect(w.svc.settleWithPreimage(booking.id, s1.p)).rejects.toThrow("preimage_mismatch");
  });
});
