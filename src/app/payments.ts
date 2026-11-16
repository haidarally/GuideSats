// THE money path. payWithinMandate is the only code in the app that calls payer.payInvoice.
// Order of checks: booking state -> mandate exists -> cyclone rule -> invoice decode and
// check (network, exact amount, hash = H, expiry, payee) -> mandate (cap, payee, window,
// single use) -> atomic reserve of the mandate -> pay -> wait until the guide's wallet
// reports the hold as accepted. Anything short of a clear answer goes to the reconcile step
// (app/reconcile.ts), which decides from the guide's wallet, never from error text.
import { cycloneVerdict, type GdacsFeed } from "../domain/cyclone";
import type { Booking } from "../domain/booking";
import { beginSpend, checkSpend, completeSpend, releaseSpend, revokeMandate } from "../domain/mandate";
import { checkInvoice } from "../ln/invoiceCheck";
import type { LightningBackend, PayOutcome, ReceiverWallet } from "../ln/backend";
import type { Store } from "../store/db";
import type { Logger } from "../log/redact";
import { reconcileBooking, resolveAccepted, transitionBooking } from "./reconcile";

export interface PaymentDeps {
  store: Store;
  backend: LightningBackend;
  clock: () => number;
  feed: () => GdacsFeed;
  log: Logger;
  travellerWalletId: string;
  guideWalletOf: (b: Booking) => string;
  acceptTimeoutMs?: number;
  pollMs?: number;
  meetingBufferMs?: number; // the guide may settle until tourStart + this (default 2 h)
  holdMarginBlocks?: number; // spare blocks required before the wallet's settle deadline (default 6)
  onFinal?: (bookingId: string, outcome: PayOutcome) => void;
}

export type PayResult = { ok: true; state: "locked" | "settled" | "paid"; amountSats: number } | { ok: false; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitAccepted(receiver: ReceiverWallet, hash: string, outcome: () => PayOutcome | null, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await receiver.lookupInvoice(hash)).state === "accepted") return true;
    } catch {
      /* lookup failures are retried until the deadline */
    }
    const o = outcome();
    if (o && o.status !== "settled") return false;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Nothing left the wallet: re-arm the single use if the booking is still payable, else close the mandate.
 * Only if the reservation is still THIS payment's (same hash): a late reply must never undo a newer one,
 * e.g. after the reconcile step retired the hash and the traveller approved again with a new secret.
 */
function giveBack(d: PaymentDeps, bookingId: string, hash: string): boolean {
  const m = d.store.mandateForBooking(bookingId);
  const b = d.store.getBooking(bookingId);
  if (!m || !b || m.status !== "consuming" || (b.mode === "hold" ? m.paymentHash : b.paymentHash) !== hash) return false;
  return d.store.casMandate(b.state === "mandated" ? releaseSpend(m) : revokeMandate(m), "consuming");
}

/** What the caller is told, read from the store after the pay path or the reconcile step resolved (or not). */
function resultNow(d: PaymentDeps, bookingId: string, amountSats: number): PayResult {
  const b = d.store.getBooking(bookingId)!;
  if (b.state === "locked" || b.state === "settled" || b.state === "paid") return { ok: true, state: b.state, amountSats };
  if (d.store.mandateForBooking(bookingId)?.status === "consuming") return { ok: false, reason: "payment_unknown_needs_reconcile" };
  if (b.state === "reapproval_needed") return { ok: false, reason: "hold_cancelled_reapproval_needed" };
  if (b.state === "refunded_hold_limit") return { ok: false, reason: "hold_limit_too_short" };
  return { ok: false, reason: `booking_changed_during_payment:${b.state}` };
}

export async function payWithinMandate(d: PaymentDeps, bookingId: string, invoice: string): Promise<PayResult> {
  const now = d.clock();
  const refuse = (reason: string): PayResult => {
    d.store.audit(now, "pay_refused", { bookingId, reason });
    d.log.warn("pay_refused", { bookingId, reason });
    return { ok: false, reason };
  };

  const b = d.store.getBooking(bookingId);
  if (!b) return refuse("unknown_booking");
  if (b.state !== "mandated") return refuse(`booking_not_payable:${b.state}`);
  const m = d.store.mandateForBooking(b.id);
  if (!m || m.status !== "approved") return refuse("no_approved_mandate");
  // Hold mode: the hash is the H the traveller approved. Plan B: the hash of the invoice WE asked
  // the guide's own wallet for, after the traveller confirmed the tour happened.
  let expectedHash: string;
  if (b.mode === "hold") {
    if (m.paymentHash === null) return refuse("no_approved_mandate");
    expectedHash = m.paymentHash;
  } else {
    if (!b.confirmedAt) return refuse("not_confirmed_by_traveller");
    if (!b.paymentHash || b.invoice === null) return refuse("no_invoice_requested");
    expectedHash = b.paymentHash;
  }

  const cv = cycloneVerdict(d.feed(), { now, tourStart: b.tourStart, tourEnd: b.tourEnd });
  if (cv.cancel) return refuse("cyclone_alert");

  const ci = checkInvoice(invoice, {
    network: d.backend.network,
    amountSats: b.priceSats,
    paymentHash: expectedHash,
    payeePubkey: m.payeePubkey,
    now,
    payeeProof: d.backend.payeeProof,
  });
  if (!ci.ok) return refuse(`invoice_${ci.reason}`);

  const spend = { amountSats: ci.invoice.amountSats, payeePubkey: ci.invoice.payeePubkey, paymentHash: ci.invoice.paymentHash, now };
  const decision = checkSpend(m, spend);
  if (!decision.ok) return refuse(`mandate_${decision.reason}`);

  // Reserve the mandate atomically BEFORE the first await: a second call now sees "consuming".
  const consuming = beginSpend(m, spend);
  if (!d.store.casMandate(consuming, "approved")) return refuse("mandate_in_flight");
  d.store.audit(now, "pay_started", { bookingId, amountSats: spend.amountSats, paymentHash: spend.paymentHash, payeePubkey: spend.payeePubkey });

  const payer = d.backend.payer(d.travellerWalletId);
  const receiver = d.backend.receiver(d.guideWalletOf(b));

  if (b.mode === "on_completion") {
    // Plan B: a regular payment; the wallet answers when it is done.
    const o = await payer.payInvoice(invoice);
    const at = d.clock();
    if (o.status === "settled") {
      d.onFinal?.(bookingId, o);
      if (!d.store.casMandate(completeSpend(consuming), "consuming")) return resultNow(d, bookingId, spend.amountSats); // the reconcile step was first
      if (!transitionBooking(d.store, bookingId, "PAY_ON_COMPLETION", at)) {
        // Cannot happen through the service (cancel and the cyclone rule wait for an in-flight payment),
        // but never throw after money moved: record it loudly instead.
        const state = d.store.getBooking(bookingId)?.state;
        d.store.audit(at, "paid_but_booking_changed", { bookingId, state, amountSats: spend.amountSats, paymentHash: spend.paymentHash });
        d.log.warn("paid_but_booking_changed", { bookingId, state });
        return { ok: false, reason: `paid_but_booking_changed:${state}` };
      }
      d.store.audit(at, "paid_on_completion", { bookingId, amountSats: spend.amountSats, paymentHash: spend.paymentHash });
      return { ok: true, state: "paid", amountSats: spend.amountSats };
    }
    if (o.status === "failed") {
      if (!giveBack(d, bookingId, spend.paymentHash)) return resultNow(d, bookingId, spend.amountSats);
      d.store.audit(at, "pay_failed", { bookingId, error: o.error });
      return { ok: false, reason: `payment_failed:${o.error}` };
    }
    d.store.audit(at, "pay_unknown", { bookingId });
    await reconcileBooking(d, bookingId); // once now; the watcher's tick keeps trying
    return resultNow(d, bookingId, spend.amountSats);
  }

  let outcome: PayOutcome | null = null;
  const final = payer.payInvoice(invoice).then((o) => {
    outcome = o;
    return o;
  });
  final.then((o) => d.onFinal?.(bookingId, o)).catch(() => undefined);

  const accepted = await waitAccepted(receiver, spend.paymentHash, () => outcome, d.acceptTimeoutMs ?? 15_000, d.pollMs ?? 250);
  if (accepted) {
    await resolveAccepted(d, bookingId, spend.paymentHash, invoice);
    return resultNow(d, bookingId, spend.amountSats);
  }
  const at = d.clock();
  const o = outcome as PayOutcome | null;
  if (o && o.status === "failed") {
    // Definite failure (a NIP-47 refusal code from the wallet): nothing left it, so the single use is given back.
    if (!giveBack(d, bookingId, spend.paymentHash)) return resultNow(d, bookingId, spend.amountSats);
    d.store.audit(at, "pay_failed", { bookingId, error: o.error });
    return { ok: false, reason: `payment_failed:${o.error}` };
  }
  // Refunded, unknown, or no answer in time: fail closed (the mandate stays reserved, nobody can pay twice)
  // and look the hold up once now. The watcher's 30 s tick keeps trying until the guide's wallet answers.
  d.store.audit(at, o?.status === "refunded" ? "pay_refunded" : "pay_unknown", { bookingId });
  await reconcileBooking(d, bookingId);
  return resultNow(d, bookingId, spend.amountSats);
}
