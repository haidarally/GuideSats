// THE money path. payWithinMandate is the only code in the app that calls payer.payInvoice.
// Order of checks: booking state -> mandate exists -> cyclone rule -> invoice decode and
// check (network, exact amount, hash = H, expiry, payee) -> mandate (cap, payee, window,
// single use) -> atomic reserve of the mandate -> pay -> wait until the guide's wallet
// reports the hold as accepted.
import { cycloneVerdict, type GdacsFeed } from "../domain/cyclone";
import { applyEvent, type Booking } from "../domain/booking";
import { beginSpend, checkSpend, completeSpend, releaseSpend } from "../domain/mandate";
import { checkInvoice } from "../ln/invoiceCheck";
import type { LightningBackend, PayOutcome, ReceiverWallet } from "../ln/backend";
import type { Store } from "../store/db";
import type { Logger } from "../log/redact";

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
  onFinal?: (bookingId: string, outcome: PayOutcome) => void;
}

export type PayResult = { ok: true; state: "locked" | "paid"; amountSats: number } | { ok: false; reason: string };

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
      d.store.casMandate(completeSpend(consuming), "consuming");
      d.store.putBooking(applyEvent(d.store.getBooking(bookingId)!, "PAY_ON_COMPLETION", at));
      d.store.audit(at, "paid_on_completion", { bookingId, amountSats: spend.amountSats, paymentHash: spend.paymentHash });
      d.onFinal?.(bookingId, o);
      return { ok: true, state: "paid", amountSats: spend.amountSats };
    }
    if (o.status === "failed") {
      d.store.casMandate(releaseSpend(consuming), "consuming");
      d.store.audit(at, "pay_failed", { bookingId, error: o.error });
      return { ok: false, reason: `payment_failed:${o.error}` };
    }
    d.store.audit(at, "pay_unknown", { bookingId });
    return { ok: false, reason: "payment_unknown_needs_reconcile" };
  }

  let outcome: PayOutcome | null = null;
  const final = payer.payInvoice(invoice).then((o) => {
    outcome = o;
    return o;
  });
  final.then((o) => d.onFinal?.(bookingId, o)).catch(() => undefined);

  const accepted = await waitAccepted(receiver, spend.paymentHash, () => outcome, d.acceptTimeoutMs ?? 15_000, d.pollMs ?? 250);
  const at = d.clock();
  if (accepted) {
    d.store.casMandate(completeSpend(consuming), "consuming");
    const fresh = d.store.getBooking(bookingId)!;
    d.store.putBooking({ ...applyEvent(fresh, "LOCK", at), invoice });
    d.store.audit(at, "locked", { bookingId, amountSats: spend.amountSats, paymentHash: spend.paymentHash });
    d.log.info("locked", { bookingId, amountSats: spend.amountSats, paymentHash: spend.paymentHash });
    return { ok: true, state: "locked", amountSats: spend.amountSats };
  }
  const o = outcome as PayOutcome | null;
  if (o && o.status === "failed") {
    // Definite failure: nothing left the wallet, so the traveller's single use is given back.
    d.store.casMandate(releaseSpend(consuming), "consuming");
    d.store.audit(at, "pay_failed", { bookingId, error: o.error });
    return { ok: false, reason: `payment_failed:${o.error}` };
  }
  // Unknown (timeout): fail closed. The mandate stays reserved; nobody can pay twice.
  d.store.audit(at, "pay_unknown", { bookingId });
  return { ok: false, reason: "payment_unknown_needs_reconcile" };
}
