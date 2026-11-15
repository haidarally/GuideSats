// A spending mandate: the only thing that lets the agent move the traveller's sats.
// Pure functions. The agent's tools can read a mandate and ask the guard to spend
// against it; nothing the agent can reach can approve, widen or re-arm one.

export const MAX_CAP_SATS = 1_000_000; // hard ceiling for any single mandate

export type MandateStatus = "pending_approval" | "approved" | "consuming" | "used" | "revoked";

export interface Mandate {
  id: string;
  bookingId: string;
  capSats: number; // integer sats; the spend must be <= cap
  payeePubkey: string; // guide's Lightning node key, 33-byte compressed hex
  notBefore: number; // ms epoch: earliest moment the agent may pay
  notAfter: number; // ms epoch: latest moment the agent may pay
  paymentHash: string | null; // H = SHA-256(P), bound at approval time (hold mode)
  requireHash: boolean; // hold mode: true. Plan B (pay on completion): false, the guide's wallet picks the hash
  status: MandateStatus;
  approvedAt: number | null;
}

/** Only the traveller's own screen produces this. The agent never receives the constructor. */
export interface TravellerApproval {
  actor: "traveller";
  paymentHash: string | null; // required in hold mode, null in plan B
  at: number;
}

export interface SpendRequest {
  amountSats: number;
  payeePubkey: string;
  paymentHash: string;
  now: number;
}

export type MandateRefusal =
  | "not_approved"
  | "in_flight"
  | "already_used"
  | "revoked"
  | "bad_amount"
  | "over_cap"
  | "wrong_payee"
  | "wrong_hash"
  | "too_early"
  | "too_late";

export type SpendDecision = { ok: true } | { ok: false; reason: MandateRefusal };

const HEX32 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

export class MandateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MandateError";
  }
}

export interface DraftMandateInput {
  id: string;
  bookingId: string;
  capSats: number;
  payeePubkey: string;
  notBefore: number;
  notAfter: number;
  requireHash?: boolean; // default true
}

export function draftMandate(input: DraftMandateInput): Mandate {
  if (!Number.isSafeInteger(input.capSats) || input.capSats <= 0) throw new MandateError("cap must be a positive integer of sats");
  if (input.capSats > MAX_CAP_SATS) throw new MandateError(`cap above the ${MAX_CAP_SATS} sats ceiling`);
  if (!PUBKEY.test(input.payeePubkey)) throw new MandateError("payee must be a 33-byte compressed pubkey (hex)");
  if (!Number.isFinite(input.notBefore) || !Number.isFinite(input.notAfter) || input.notBefore >= input.notAfter) {
    throw new MandateError("time window must have notBefore < notAfter");
  }
  return { ...input, requireHash: input.requireHash ?? true, paymentHash: null, status: "pending_approval", approvedAt: null };
}

export function approveMandate(m: Mandate, approval: TravellerApproval): Mandate {
  if (approval.actor !== "traveller") throw new MandateError("only the traveller can approve a mandate");
  if (m.status !== "pending_approval") throw new MandateError(`cannot approve a mandate in status ${m.status}`);
  if (m.requireHash && (approval.paymentHash === null || !HEX32.test(approval.paymentHash))) throw new MandateError("payment hash must be 32-byte hex");
  if (!m.requireHash && approval.paymentHash !== null) throw new MandateError("this mandate does not bind a payment hash");
  if (approval.at >= m.notAfter) throw new MandateError("mandate window already closed");
  return { ...m, paymentHash: approval.paymentHash, status: "approved", approvedAt: approval.at };
}

export function revokeMandate(m: Mandate): Mandate {
  if (m.status === "used") throw new MandateError("a used mandate cannot be revoked");
  return { ...m, status: "revoked" };
}

/** Pure check: would this spend be allowed right now? */
export function checkSpend(m: Mandate, req: SpendRequest): SpendDecision {
  if (m.status === "revoked") return { ok: false, reason: "revoked" };
  if (m.status === "used") return { ok: false, reason: "already_used" };
  if (m.status === "consuming") return { ok: false, reason: "in_flight" };
  if (m.status !== "approved" || (m.requireHash && m.paymentHash === null)) return { ok: false, reason: "not_approved" };
  if (!Number.isSafeInteger(req.amountSats) || req.amountSats <= 0) return { ok: false, reason: "bad_amount" };
  if (req.amountSats > m.capSats) return { ok: false, reason: "over_cap" };
  if (req.payeePubkey !== m.payeePubkey) return { ok: false, reason: "wrong_payee" };
  if (m.paymentHash !== null && req.paymentHash !== m.paymentHash) return { ok: false, reason: "wrong_hash" };
  if (req.now < m.notBefore) return { ok: false, reason: "too_early" };
  if (req.now > m.notAfter) return { ok: false, reason: "too_late" };
  return { ok: true };
}

/** Single use, step 1: reserve the mandate BEFORE any await on the wallet. */
export function beginSpend(m: Mandate, req: SpendRequest): Mandate {
  const d = checkSpend(m, req);
  if (!d.ok) throw new MandateError(`spend refused: ${d.reason}`);
  return { ...m, status: "consuming" };
}

/** Single use, step 2a: the wallet accepted the payment. The mandate is spent for good. */
export function completeSpend(m: Mandate): Mandate {
  if (m.status !== "consuming") throw new MandateError(`cannot complete a mandate in status ${m.status}`);
  return { ...m, status: "used" };
}

/** Single use, step 2b: the wallet definitely failed (nothing left the wallet). Re-arm. */
export function releaseSpend(m: Mandate): Mandate {
  if (m.status !== "consuming") throw new MandateError(`cannot release a mandate in status ${m.status}`);
  return { ...m, status: "approved" };
}
