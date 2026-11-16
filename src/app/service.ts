// Application service: bookings, mandates, the cyclone watcher and hold expiry.
// Three audiences call it, through three narrow doors:
//   traveller routes -> proposeBooking, approveMandate, cancelByTraveller
//   guide routes     -> settleWithPreimage
//   the agent        -> agentFacade() (read, propose, request invoice, pay within mandate)
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { applyEvent, isTerminal, type Booking, type BookingEvent, type PaymentMode } from "../domain/booking";
import { cycloneVerdict, type CycloneVerdict, type GdacsFeed } from "../domain/cyclone";
import { approveMandate, draftMandate, revokeMandate, type Mandate, type TravellerApproval } from "../domain/mandate";
import type { LightningBackend, PayOutcome } from "../ln/backend";
import { invoiceExpiresAt, MIN_SECONDS_LEFT } from "../ln/invoiceCheck";
import type { Logger } from "../log/redact";
import type { Store } from "../store/db";
import { payWithinMandate, type PaymentDeps, type PayResult } from "./payments";
import { reconcileBooking, retireDeadInvoice, transitionBooking, type ReconcileOutcome } from "./reconcile";

export interface Tour {
  id: string;
  guideId: string;
  title: { en: string; fr: string };
  meetingPoint: { en: string; fr: string };
  priceSats: number;
  startAt: number; // ms epoch
  durationHours: number;
}

export interface Guide {
  id: string; // also the guide's wallet id
  displayName: string;
  area: string;
  languages: string[];
  payeePubkey: string; // resolved from the guide wallet's get_info at startup
}

export interface ServiceConfig {
  travellerWalletId: string;
  lockLeadHours: number; // the agent may lock funds from this many hours before the tour (domain/holdLimit.ts)
  invoiceExpirySecs: number;
  meetingBufferMs?: number; // the guide may settle until the tour start + this (default 2 h)
  holdMarginBlocks?: number; // spare blocks required before the wallet's settle deadline (default 6)
  acceptTimeoutMs?: number;
  pollMs?: number;
}

export type AppEvent =
  | { type: "booking"; booking: Booking }
  | { type: "cyclone"; verdict: CycloneVerdict; affected: string[] }
  | { type: "agent"; step: unknown }
  | { type: "wallet" };

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const HEX32 = /^[0-9a-f]{64}$/;

export class BookingService {
  private seq = 0;
  private listeners: ((e: AppEvent) => void)[] = [];

  constructor(
    private readonly store: Store,
    readonly backend: LightningBackend,
    private readonly clock: () => number,
    private feed: () => GdacsFeed,
    private readonly log: Logger,
    readonly tours: Tour[],
    readonly guides: Guide[],
    private readonly cfg: ServiceConfig,
  ) {}

  on(fn: (e: AppEvent) => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }
  emit(e: AppEvent): void {
    for (const l of this.listeners) l(e);
  }
  now(): number {
    return this.clock();
  }
  get travellerWalletId(): string {
    return this.cfg.travellerWalletId;
  }
  setFeed(feed: () => GdacsFeed): void {
    this.feed = feed;
  }
  currentFeed(): GdacsFeed {
    return this.feed();
  }

  tour(id: string): Tour {
    const t = this.tours.find((x) => x.id === id);
    if (!t) throw new ServiceError("unknown_tour");
    return t;
  }
  guide(id: string): Guide {
    const g = this.guides.find((x) => x.id === id);
    if (!g) throw new ServiceError("unknown_guide");
    return g;
  }
  booking(id: string): Booking {
    const b = this.store.getBooking(id);
    if (!b) throw new ServiceError("unknown_booking");
    return b;
  }
  mandate(bookingId: string): Mandate | null {
    return this.store.mandateForBooking(bookingId);
  }
  bookings(): Booking[] {
    return this.store.listBookings();
  }
  audit(limit = 50) {
    return this.store.listAudit(limit);
  }

  private save(b: Booking): Booking {
    this.store.putBooking(b);
    this.emit({ type: "booking", booking: b });
    return b;
  }

  /** After an await: apply `event` to the booking as it is now, with a compare-and-set on its state. Null if it moved on. */
  private transition(id: string, event: BookingEvent, at: number, patch: Partial<Booking> = {}): Booking | null {
    const next = transitionBooking(this.store, id, event, at, patch);
    if (next) this.emit({ type: "booking", booking: next });
    return next;
  }

  /** The cyclone rule closes a booking: CYCLONE_CANCEL from whatever state it is in now, and an unspent mandate is revoked. */
  private closeForCyclone(id: string, at: number): Booking | null {
    const next = this.transition(id, "CYCLONE_CANCEL", at);
    const m = this.store.mandateForBooking(id);
    const b = this.store.getBooking(id);
    if (b && isTerminal(b.state) && m && (m.status === "approved" || m.status === "pending_approval")) this.store.casMandate(revokeMandate(m), m.status);
    return next;
  }

  // ---------- traveller door ----------

  /**
   * Creates a booking and a DRAFT mandate. The cap and payee come from the catalogue, never from the caller.
   * mode "hold": the agent may lock the sats from lockLeadHours before the tour until it starts.
   * mode "on_completion" (plan B, wallets without holds): the agent may pay only after the tour,
   * once the traveller confirms it happened (up to 48 h after the end).
   */
  proposeBooking(tourId: string, mode: PaymentMode = "hold"): { booking: Booking; mandate: Mandate } {
    const t = this.tour(tourId);
    const g = this.guide(t.guideId);
    const n = ++this.seq;
    const now = this.clock();
    const booking: Booking = {
      id: `bk_${n}`,
      tourId: t.id,
      guideId: g.id,
      travellerId: this.cfg.travellerWalletId,
      priceSats: t.priceSats,
      tourStart: t.startAt,
      tourEnd: t.startAt + t.durationHours * 3_600_000,
      mode,
      state: "proposed",
      paymentHash: null,
      invoice: null,
      confirmedAt: null,
      history: [],
    };
    const tourEnd = t.startAt + t.durationHours * 3_600_000;
    const mandate = draftMandate({
      id: `md_${n}`,
      bookingId: booking.id,
      capSats: t.priceSats,
      payeePubkey: g.payeePubkey,
      // Hold mode: never earlier than lockLeadHours before the tour, so an accepted hold does not time out
      // (settle_deadline) before the meeting. Each accepted hold is also checked against the deadline its
      // wallet reports (app/reconcile.ts, checkHoldFit).
      notBefore: mode === "hold" ? t.startAt - this.cfg.lockLeadHours * 3_600_000 : t.startAt,
      notAfter: mode === "hold" ? t.startAt : tourEnd + 48 * 3_600_000,
      requireHash: mode === "hold",
    });
    this.store.insertMandate(mandate);
    this.save(booking);
    this.store.audit(now, "booking_proposed", { bookingId: booking.id, tourId: t.id, capSats: mandate.capSats });
    return { booking, mandate };
  }

  /**
   * The traveller approves the mandate and (hold mode) binds H = SHA-256(P). P stays on the traveller's phone.
   * Also the re-approval after a hold invoice died unpaid (booking "reapproval_needed"): the phone makes a NEW
   * secret, and an H used before is refused, so the old secret and the old invoice stay dead.
   */
  approveMandate(bookingId: string, approval: TravellerApproval): Mandate {
    const b = this.booking(bookingId);
    if (b.mode === "hold" && (approval.paymentHash === null || !HEX32.test(approval.paymentHash))) throw new ServiceError("bad_payment_hash");
    if (b.mode === "on_completion" && approval.paymentHash !== null) throw new ServiceError("plan_b_takes_no_hash");
    const m = this.store.mandateForBooking(bookingId);
    if (!m) throw new ServiceError("no_mandate");
    if (approval.paymentHash !== null && (m.retiredHashes ?? []).includes(approval.paymentHash)) throw new ServiceError("payment_hash_reused");
    const approved = approveMandate(m, approval);
    if (!this.store.casMandate(approved, "pending_approval")) throw new ServiceError("mandate_changed");
    this.save({ ...applyEvent(b, "APPROVE_MANDATE", approval.at), paymentHash: approval.paymentHash, invoice: null });
    this.store.audit(approval.at, "mandate_approved", { bookingId, capSats: approved.capSats, payeePubkey: approved.payeePubkey, paymentHash: approval.paymentHash });
    return approved;
  }

  /** Plan B: the traveller confirms the tour happened; only then may the agent pay. */
  confirmTourHappened(bookingId: string): Booking {
    const b = this.booking(bookingId);
    if (b.mode !== "on_completion") throw new ServiceError("not_plan_b");
    if (b.state !== "mandated") throw new ServiceError(`not_mandated:${b.state}`);
    const now = this.clock();
    if (now < b.tourStart) throw new ServiceError("tour_not_started");
    this.store.audit(now, "tour_confirmed", { bookingId });
    return this.save({ ...b, confirmedAt: now });
  }

  cancelByTraveller(bookingId: string): Booking {
    const b = this.booking(bookingId);
    const m = this.store.mandateForBooking(bookingId);
    // A payment is in flight (or its outcome is unknown): cancelling now would leave the sats in a hold
    // (or, in plan B, paid) under a booking that says "cancelled". Refuse; the payment completes or fails first.
    if (m?.status === "consuming") throw new ServiceError("payment_in_flight");
    const next = applyEvent(b, "TRAVELLER_CANCEL", this.clock());
    if (m && (m.status === "approved" || m.status === "pending_approval") && !this.store.casMandate(revokeMandate(m), m.status)) {
      throw new ServiceError("mandate_changed");
    }
    return this.save(next);
  }

  // ---------- guide door ----------

  /** At the meeting point the guide scans P from the traveller's QR and settles the hold. */
  async settleWithPreimage(bookingId: string, preimage: string): Promise<Booking> {
    const p = preimage.trim().toLowerCase();
    if (!HEX32.test(p)) throw new ServiceError("bad_preimage");
    const b = this.booking(bookingId);
    if (b.state !== "locked") throw new ServiceError(`not_locked:${b.state}`);
    if (bytesToHex(sha256(hexToBytes(p))) !== b.paymentHash) throw new ServiceError("preimage_mismatch");
    await this.backend.receiver(b.guideId).settleHoldInvoice(p);
    const at = this.clock();
    this.store.audit(at, "settled", { bookingId, amountSats: b.priceSats, paymentHash: b.paymentHash });
    const next = this.transition(bookingId, "SETTLE", at);
    if (next) return next;
    // The money moved, so never throw a generic error here: the reconcile step may have seen the settlement first.
    const now = this.booking(bookingId);
    if (now.state === "settled") return now;
    this.store.audit(at, "settled_but_booking_changed", { bookingId, state: now.state });
    this.log.warn("settled_but_booking_changed", { bookingId, state: now.state });
    throw new ServiceError(`settled_but_booking_changed:${now.state}`);
  }

  // ---------- system: cyclone watcher + expiry ----------

  /**
   * The watcher. Every booking is re-read from the store at each step (a payment may land between two
   * awaits), and one failing wallet call never stops the refunds of the other bookings.
   */
  async applyCycloneRule(): Promise<{ verdicts: { bookingId: string; verdict: CycloneVerdict }[] }> {
    const feed = this.feed();
    const now = this.clock();
    const out: { bookingId: string; verdict: CycloneVerdict }[] = [];
    for (const { id } of this.store.listBookings()) {
      const b = this.store.getBooking(id);
      if (!b || isTerminal(b.state)) continue;
      const verdict = cycloneVerdict(feed, { now, tourStart: b.tourStart, tourEnd: b.tourEnd });
      if (!verdict.cancel) continue;
      out.push({ bookingId: b.id, verdict });
      const eventid = verdict.event?.eventid;
      try {
        const m = this.store.mandateForBooking(b.id);
        if (b.state === "locked" && b.paymentHash) {
          await this.backend.receiver(b.guideId).cancelHoldInvoice(b.paymentHash);
          this.store.audit(now, "refunded_cyclone", { bookingId: b.id, amountSats: b.priceSats, eventid });
          this.closeForCyclone(b.id, now);
        } else if (m?.status === "consuming") {
          if (b.mode === "hold" && b.paymentHash) {
            // A lock is in flight, or its outcome is unknown. Cancel the hold invoice at the guide's wallet:
            // an accepted hold is refunded at once, and a payment that has not landed yet can no longer land.
            await this.backend.receiver(b.guideId).cancelHoldInvoice(b.paymentHash);
            this.store.audit(now, "cancelled_in_flight_hold", { bookingId: b.id, eventid });
            this.closeForCyclone(b.id, now); // the reserved mandate is closed by the reconcile step
          } else {
            // Plan B: a plain payment in flight cannot be undone. Leave it to finish; the next tick sees "paid".
            this.store.audit(now, "cyclone_deferred_payment_in_flight", { bookingId: b.id, eventid });
          }
        } else {
          this.store.audit(now, "skipped_cyclone", { bookingId: b.id, eventid });
          this.closeForCyclone(b.id, now);
        }
      } catch (e) {
        // Not refunded yet: say so, and let the next tick retry. Never mark a booking refunded on a failed call.
        this.store.audit(now, "cyclone_cancel_failed", { bookingId: b.id, eventid });
        this.log.warn("cyclone_cancel_failed", { bookingId: b.id, err: e });
      }
    }
    if (out.length > 0) this.emit({ type: "cyclone", verdict: out[0]!.verdict, affected: out.map((o) => o.bookingId) });
    return { verdicts: out };
  }

  /**
   * The reconcile step, on the watcher's tick: every unresolved payment (a reserved mandate, a locked hold)
   * is resolved from what the guide's wallet reports. Idempotent; one failing wallet call never stops the others.
   */
  async reconcile(): Promise<{ bookingId: string; outcome: ReconcileOutcome }[]> {
    const changed: { bookingId: string; outcome: ReconcileOutcome }[] = [];
    for (const { id } of this.store.listBookings()) {
      try {
        const outcome = await reconcileBooking(this.paymentDeps(), id);
        if (outcome === "unchanged" || outcome === "pending") continue;
        changed.push({ bookingId: id, outcome });
        this.emit({ type: "booking", booking: this.booking(id) });
      } catch (e) {
        this.log.warn("reconcile_failed", { bookingId: id, err: e });
      }
    }
    return changed;
  }

  // ---------- agent door ----------

  async requestInvoice(bookingId: string): Promise<string> {
    const b = this.booking(bookingId);
    if (b.state !== "mandated") throw new ServiceError(`not_mandated:${b.state}`);
    const m = this.store.mandateForBooking(bookingId);
    if (!m || m.status !== "approved") throw new ServiceError("no_approved_mandate");
    // A cached invoice is reused while it is still payable. Plan B asks the guide's wallet for a fresh one
    // once it has expired (e.g. a failed payment retried later). A hold invoice is bound to the traveller's
    // H and cannot be re-made: once it has expired, H is retired and the traveller must approve again
    // with a new secret (the agent cannot do that).
    if (b.invoice && (invoiceExpiresAt(b.invoice) ?? 0) - this.clock() > MIN_SECONDS_LEFT * 1000) return b.invoice;
    if (b.invoice && b.mode === "hold") {
      await retireDeadInvoice(this.paymentDeps(), bookingId);
      this.emit({ type: "booking", booking: this.booking(bookingId) });
      throw new ServiceError("reapproval_needed");
    }
    const t = this.tour(b.tourId);
    if (b.mode === "on_completion") {
      if (!b.confirmedAt) throw new ServiceError("not_confirmed_by_traveller");
      const made = await this.backend.receiver(b.guideId).makeInvoice({ amountSats: b.priceSats, description: t.title.en, expirySecs: 600 });
      // A payment may have started on an earlier invoice while the wallet answered (two agent runs at once).
      // Its hash is pinned on the booking, and the reconcile step looks it up: never move it under that payment.
      const fresh = this.booking(bookingId);
      const status = this.store.mandateForBooking(bookingId)?.status;
      if (fresh.state !== "mandated" || status !== "approved") throw new ServiceError(status === "consuming" ? "payment_in_flight" : `not_mandated:${fresh.state}`);
      this.save({ ...fresh, invoice: made.invoice, paymentHash: made.paymentHash });
      return made.invoice;
    }
    if (!m.paymentHash) throw new ServiceError("no_approved_mandate");
    // Not before the window opens: the hold invoice (expiry <= invoiceExpirySecs) would expire before
    // the agent may pay it, and a hold invoice for H cannot be made twice.
    if (this.clock() < m.notBefore) throw new ServiceError("lock_window_not_open");
    if (this.clock() >= Math.min(b.tourStart, m.notAfter)) throw new ServiceError("lock_window_closed");
    const expirySecs = Math.max(120, Math.min(this.cfg.invoiceExpirySecs, Math.floor((b.tourStart - this.clock()) / 1000)));
    const made = await this.backend.receiver(b.guideId).makeHoldInvoice({ amountSats: b.priceSats, paymentHash: m.paymentHash, description: t.title.en, expirySecs });
    this.save({ ...this.booking(bookingId), invoice: made.invoice });
    return made.invoice;
  }

  private paymentDeps(): PaymentDeps {
    return {
      store: this.store,
      backend: this.backend,
      clock: this.clock,
      feed: this.feed,
      log: this.log,
      travellerWalletId: this.cfg.travellerWalletId,
      guideWalletOf: (b) => b.guideId,
      acceptTimeoutMs: this.cfg.acceptTimeoutMs,
      pollMs: this.cfg.pollMs,
      meetingBufferMs: this.cfg.meetingBufferMs,
      holdMarginBlocks: this.cfg.holdMarginBlocks,
      onFinal: (id: string, o: PayOutcome) => {
        this.log.info("payment_final", { bookingId: id, status: o.status });
        this.emit({ type: "wallet" });
      },
    };
  }

  payWithinMandate(bookingId: string, invoice: string): Promise<PayResult> {
    return payWithinMandate(this.paymentDeps(), bookingId, invoice).then((r) => {
      const b = this.store.getBooking(bookingId);
      if (b) this.emit({ type: "booking", booking: b });
      return r;
    });
  }
}
