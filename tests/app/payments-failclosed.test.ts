// The fail-closed branches of payWithinMandate: a definite failure gives the traveller's
// single use back; an unknown outcome (e.g. a reply timeout) keeps the mandate reserved.
import { describe, it, expect } from "vitest";
import { buildSimWorld } from "../../src/app/world";
import type { LightningBackend, PayOutcome } from "../../src/ln/backend";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const H = "ab".repeat(32);

/** Wraps the simulator so the traveller's wallet answers `outcome` without moving any sats. */
function stubPayer(be: LightningBackend, outcome: PayOutcome): LightningBackend {
  return {
    kind: be.kind,
    simulated: be.simulated,
    network: be.network,
    payeeProof: be.payeeProof,
    receiver: (id) => be.receiver(id),
    payer: (id) => ({ ...be.payer(id), payInvoice: async () => outcome }),
  };
}

async function setup(outcome: PayOutcome, mode: "hold" | "on_completion") {
  let now = T0;
  const w = await buildSimWorld({ clock: () => now, config: { acceptTimeoutMs: 30, pollMs: 5 } });
  // Swap the backend the service uses for the stub (same ledger underneath).
  (w.svc as unknown as { backend: LightningBackend }).backend = stubPayer(w.backend, outcome);
  const { booking } = w.svc.proposeBooking("tour_lagoon", mode);
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: mode === "hold" ? H : null, at: now });
  if (mode === "on_completion") {
    now += 9 * 3_600_000;
    w.svc.confirmTourHappened(booking.id);
  }
  const inv = await w.svc.requestInvoice(booking.id);
  return { w, id: booking.id, inv };
}

describe.each(["hold", "on_completion"] as const)("payWithinMandate fail-closed (%s)", (mode) => {
  it("a definite failure re-arms the mandate; nothing moved", async () => {
    const { w, id, inv } = await setup({ status: "failed", error: "INSUFFICIENT_BALANCE" }, mode);
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: false, reason: "payment_failed:INSUFFICIENT_BALANCE" });
    expect(w.svc.mandate(id)?.status).toBe("approved");
    expect(w.svc.booking(id).state).toBe("mandated");
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });
  it("an unknown outcome keeps the mandate reserved, so a second call is refused", async () => {
    const { w, id, inv } = await setup({ status: "unknown", error: "Nip47ReplyTimeoutError" }, mode);
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: false, reason: "payment_unknown_needs_reconcile" });
    expect(w.svc.mandate(id)?.status).toBe("consuming");
    expect(await w.svc.payWithinMandate(id, inv)).toEqual({ ok: false, reason: "no_approved_mandate" }); // status is "consuming"
    expect(w.ledger.balance("traveller")).toBe(120_000);
    expect(w.svc.audit().some((a) => a.event === "pay_unknown")).toBe(true);
  });
});
