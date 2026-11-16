// The reconcile step: ONE place that resolves every unresolved payment from what the guide's wallet
// says about the invoice (lookup_invoice by payment hash). It runs on the watcher's 30 s tick and once
// right after a pay call ends without a clear answer. It never reads error text, only invoice states.
//
//   mandate "consuming" (a lock in flight, or its outcome unknown), hold mode, looked up by H:
//     accepted          -> mandate used, booking locked (if the booking moved on meanwhile: the hold is cancelled)
//     settled           -> mandate used, booking settled
//     cancelled/expired -> nothing is locked and H can never be paid: H is retired, the booking waits for the
//                          traveller to approve again with a NEW secret (or the mandate is revoked if the booking
//                          moved on). "expired" is made final with cancel_hold_invoice first, because it may come
//                          from the invoice's own expiry time rather than from the wallet.
//     open, or the lookup fails -> left as it is (fail closed) and retried on the next tick
//   mandate "consuming", plan B: settled -> paid. Anything else stays reserved: a plain payment cannot be cancelled.
//   booking "locked": cancelled/expired -> refunded_expired; settled -> settled.
//
// Every change is a compare-and-set (mandate status, booking state). The cyclone rule, the traveller,
// the guide, the pay path and the tick may race; each outcome is applied once, by whoever comes first.
import { applyEvent, nextState, type Booking, type BookingEvent } from "../domain/booking";
import { completeSpend, retireHash, revokeMandate } from "../domain/mandate";
import type { HoldState } from "../ln/backend";
import type { Store } from "../store/db";
import type { PaymentDeps } from "./payments";

export type ReconcileDeps = Pick<PaymentDeps, "store" | "backend" | "clock" | "log" | "guideWalletOf">;

/** What a hold's state at the guide's wallet means for the payment. Shared with `npm run e2e:nwc`. */
export type Resolution = "locked" | "settled" | "released" | "pending";

export function holdResolution(state: HoldState): Resolution {
  if (state === "accepted") return "locked";
  if (state === "settled") return "settled";
  if (state === "cancelled" || state === "expired") return "released";
  return "pending";
}

export type ReconcileOutcome = "locked" | "settled" | "paid" | "reapproval_needed" | "revoked" | "refunded_expired" | "lock_aborted" | "pending" | "unchanged";

/**
 * Applies `event` to the booking as it is NOW in the store, with an atomic compare-and-set on its state.
 * Returns null when the event is not legal from the current state or someone moved the booking first.
 * Every transition made after an await goes through here, so two actors can never both apply one.
 */
export function transitionBooking(store: Store, id: string, event: BookingEvent, at: number, patch: Partial<Booking> = {}): Booking | null {
  const b = store.getBooking(id);
  if (!b || nextState(b.state, event) === null) return null;
  const next: Booking = { ...applyEvent(b, event, at), ...patch };
  return store.casBooking(next, b.state) ? next : null;
}

/** Resolves one booking's unresolved payment, if it has one. Wallet errors leave it as it is. */
export async function reconcileBooking(d: ReconcileDeps, bookingId: string): Promise<ReconcileOutcome> {
  const b = d.store.getBooking(bookingId);
  const m = d.store.mandateForBooking(bookingId);
  if (!b) return "unchanged";
  // A consuming mandate is resolved whatever the booking's state: the cyclone rule may already have closed it.
  if (m?.status === "consuming") {
    const hash = b.mode === "hold" ? m.paymentHash : b.paymentHash;
    if (!hash) return "unchanged";
    let state: HoldState;
    try {
      state = (await d.backend.receiver(d.guideWalletOf(b)).lookupInvoice(hash)).state;
    } catch {
      return "pending";
    }
    if (b.mode === "on_completion") return state === "settled" ? resolvePaidPlanB(d, bookingId, hash) : "pending";
    switch (holdResolution(state)) {
      case "locked":
        return resolveAccepted(d, bookingId, hash);
      case "settled":
        return resolveSettled(d, bookingId, hash);
      case "released":
        if (state === "expired") {
          try {
            await d.backend.receiver(d.guideWalletOf(b)).cancelHoldInvoice(hash);
          } catch {
            return "pending";
          }
        }
        return resolveReleased(d, bookingId, hash);
      default:
        return "pending";
    }
  }
  if (b.state === "locked" && b.paymentHash) {
    let state: HoldState;
    try {
      state = (await d.backend.receiver(d.guideWalletOf(b)).lookupInvoice(b.paymentHash)).state;
    } catch {
      return "pending";
    }
    const at = d.clock();
    if ((state === "expired" || state === "cancelled") && transitionBooking(d.store, bookingId, "HOLD_EXPIRED", at)) {
      d.store.audit(at, "refunded_expired", { bookingId });
      return "refunded_expired";
    }
    if (state === "settled" && transitionBooking(d.store, bookingId, "SETTLE", at)) {
      d.store.audit(at, "settled_at_wallet", { bookingId, amountSats: b.priceSats, paymentHash: b.paymentHash });
      return "settled";
    }
  }
  return "unchanged";
}

/** Still the same reserved mandate for this hash? (A compare-and-set checks the status only.) */
function stillConsuming(d: ReconcileDeps, bookingId: string, hash: string, hold: boolean) {
  const m = d.store.mandateForBooking(bookingId);
  const b = d.store.getBooking(bookingId);
  if (!m || !b || m.status !== "consuming") return null;
  if (hold ? m.paymentHash !== hash : b.paymentHash !== hash) return null;
  return { m, b };
}

/** The hold for H is accepted: the single use is spent for good and the booking is locked. */
export async function resolveAccepted(d: ReconcileDeps, bookingId: string, hash: string, invoice?: string): Promise<ReconcileOutcome> {
  const cur = stillConsuming(d, bookingId, hash, true);
  if (!cur || !d.store.casMandate(completeSpend(cur.m), "consuming")) return "unchanged";
  const at = d.clock();
  if (transitionBooking(d.store, bookingId, "LOCK", at, invoice ? { invoice } : {})) {
    d.store.audit(at, "locked", { bookingId, amountSats: cur.b.priceSats, paymentHash: hash });
    d.log.info("locked", { bookingId, amountSats: cur.b.priceSats, paymentHash: hash });
    return "locked";
  }
  // The booking moved on while the lock was in flight (the service refuses a traveller cancel during a
  // payment, and the cyclone rule cancels the hold itself; this is defence in depth). Give the sats back now.
  const state = d.store.getBooking(bookingId)?.state;
  let cancelled = true;
  try {
    await d.backend.receiver(d.guideWalletOf(cur.b)).cancelHoldInvoice(hash);
  } catch {
    cancelled = false; // the hold still times out at its settle deadline
  }
  d.store.audit(at, "lock_aborted_booking_changed", { bookingId, state, cancelled, paymentHash: hash });
  d.log.warn("lock_aborted_booking_changed", { bookingId, state, cancelled });
  return "lock_aborted";
}

/** The guide's wallet already settled the hold (for example, settled outside the app). */
function resolveSettled(d: ReconcileDeps, bookingId: string, hash: string): ReconcileOutcome {
  const cur = stillConsuming(d, bookingId, hash, true);
  if (!cur || !d.store.casMandate(completeSpend(cur.m), "consuming")) return "unchanged";
  const at = d.clock();
  if (transitionBooking(d.store, bookingId, "LOCK", at) && transitionBooking(d.store, bookingId, "SETTLE", at)) {
    d.store.audit(at, "settled_at_wallet", { bookingId, amountSats: cur.b.priceSats, paymentHash: hash });
    return "settled";
  }
  const state = d.store.getBooking(bookingId)?.state;
  d.store.audit(at, "settled_but_booking_changed", { bookingId, state, amountSats: cur.b.priceSats, paymentHash: hash });
  d.log.warn("settled_but_booking_changed", { bookingId, state });
  return "settled";
}

/** The hold for H is dead and nothing is locked. H is retired; a new payment needs a new secret. */
function resolveReleased(d: ReconcileDeps, bookingId: string, hash: string): ReconcileOutcome {
  const cur = stillConsuming(d, bookingId, hash, true);
  if (!cur) return "unchanged";
  const at = d.clock();
  if (cur.b.state === "mandated") {
    if (!d.store.casMandate(retireHash(cur.m), "consuming")) return "unchanged";
    transitionBooking(d.store, bookingId, "HASH_RETIRED", at, { paymentHash: null, invoice: null });
    d.store.audit(at, "hold_released_reapproval_needed", { bookingId, paymentHash: hash });
    return "reapproval_needed";
  }
  if (!d.store.casMandate(revokeMandate(cur.m), "consuming")) return "unchanged";
  d.store.audit(at, "hold_released_mandate_closed", { bookingId, state: cur.b.state, paymentHash: hash });
  return "revoked";
}

/** Plan B: the guide's wallet reports the regular invoice settled, so the payment landed. */
function resolvePaidPlanB(d: ReconcileDeps, bookingId: string, hash: string): ReconcileOutcome {
  const cur = stillConsuming(d, bookingId, hash, false);
  if (!cur || !d.store.casMandate(completeSpend(cur.m), "consuming")) return "unchanged";
  const at = d.clock();
  if (transitionBooking(d.store, bookingId, "PAY_ON_COMPLETION", at)) {
    d.store.audit(at, "paid_on_completion", { bookingId, amountSats: cur.b.priceSats, paymentHash: hash });
    return "paid";
  }
  const state = d.store.getBooking(bookingId)?.state;
  d.store.audit(at, "paid_but_booking_changed", { bookingId, state, amountSats: cur.b.priceSats, paymentHash: hash });
  d.log.warn("paid_but_booking_changed", { bookingId, state });
  return "paid";
}
