// Application service: bookings, mandates, the cyclone watcher and hold expiry.
// Three audiences call it, through three narrow doors:
//   traveller routes -> proposeBooking, approveMandate, cancelByTraveller
//   guide routes     -> settleWithPreimage
//   the agent        -> agentFacade() (read, propose, request invoice, pay within mandate)
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { applyEvent, isTerminal, type Booking, type PaymentMode } from "../domain/booking";
import { cycloneVerdict, type CycloneVerdict, type GdacsFeed } from "../domain/cyclone";
import { approveMandate, draftMandate, revokeMandate, type Mandate, type TravellerApproval } from "../domain/mandate";
import type { LightningBackend, PayOutcome } from "../ln/backend";
import type { Logger } from "../log/redact";
import type { Store } from "../store/db";
import { payWithinMandate, type PayResult } from "./payments";

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
  lockLeadHours: number; // the agent may lock funds from this many hours before the tour
  invoiceExpirySecs: number;
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
      notBefore: mode === "hold" ? Math.min(now, t.startAt - this.cfg.lockLeadHours * 3_600_000) : t.startAt,
      notAfter: mode === "hold" ? t.startAt : tourEnd + 48 * 3_600_000,
      requireHash: mode === "hold",
    });
    this.store.insertMandate(mandate);
    this.save(booking);
    this.store.audit(now, "booking_proposed", { bookingId: booking.id, tourId: t.id, capSats: mandate.capSats });
    return { booking, mandate };
  }

  /** The traveller approves the mandate and (hold mode) binds H = SHA-256(P). P stays on the traveller's phone. */
  approveMandate(bookingId: string, approval: TravellerApproval): Mandate {
    const b = this.booking(bookingId);
    if (b.mode === "hold" && (approval.paymentHash === null || !HEX32.test(approval.paymentHash))) throw new ServiceError("bad_payment_hash");
    if (b.mode === "on_completion" && approval.paymentHash !== null) throw new ServiceError("plan_b_takes_no_hash");
    const m = this.store.mandateForBooking(bookingId);
    if (!m) throw new ServiceError("no_mandate");
    const approved = approveMandate(m, approval);
    if (!this.store.casMandate(approved, "pending_approval")) throw new ServiceError("mandate_changed");
    this.save({ ...applyEvent(b, "APPROVE_MANDATE", approval.at), paymentHash: approval.paymentHash });
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
    const next = applyEvent(b, "TRAVELLER_CANCEL", this.clock());
    const m = this.store.mandateForBooking(bookingId);
    if (m && (m.status === "approved" || m.status === "pending_approval")) this.store.casMandate(revokeMandate(m), m.status);
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
    return this.save(applyEvent(this.booking(bookingId), "SETTLE", at));
  }

  // ---------- system: cyclone watcher + expiry ----------

  async applyCycloneRule(): Promise<{ verdicts: { bookingId: string; verdict: CycloneVerdict }[] }> {
    const feed = this.feed();
    const now = this.clock();
    const out: { bookingId: string; verdict: CycloneVerdict }[] = [];
    for (const b of this.store.listBookings()) {
      if (isTerminal(b.state)) continue;
      const verdict = cycloneVerdict(feed, { now, tourStart: b.tourStart, tourEnd: b.tourEnd });
      if (!verdict.cancel) continue;
      out.push({ bookingId: b.id, verdict });
      const m = this.store.mandateForBooking(b.id);
      if (b.state === "locked" && b.paymentHash) {
        await this.backend.receiver(b.guideId).cancelHoldInvoice(b.paymentHash);
        this.store.audit(now, "refunded_cyclone", { bookingId: b.id, amountSats: b.priceSats, eventid: verdict.event?.eventid });
        this.save(applyEvent(b, "CYCLONE_CANCEL", now));
      } else {
        if (m && (m.status === "approved" || m.status === "pending_approval")) this.store.casMandate(revokeMandate(m), m.status);
        this.store.audit(now, "skipped_cyclone", { bookingId: b.id, eventid: verdict.event?.eventid });
        this.save(applyEvent(b, "CYCLONE_CANCEL", now));
      }
    }
    if (out.length > 0) this.emit({ type: "cyclone", verdict: out[0]!.verdict, affected: out.map((o) => o.bookingId) });
    return { verdicts: out };
  }

  /** Locked bookings whose hold timed out are marked refunded (the wallet already returned the sats). */
  async reconcileHolds(): Promise<string[]> {
    const changed: string[] = [];
    for (const b of this.store.listBookings()) {
      if (b.state !== "locked" || !b.paymentHash) continue;
      const s = await this.backend.receiver(b.guideId).lookupInvoice(b.paymentHash);
      if (s.state === "expired" || s.state === "cancelled") {
        this.save(applyEvent(b, "HOLD_EXPIRED", this.clock()));
        this.store.audit(this.clock(), "refunded_expired", { bookingId: b.id });
        changed.push(b.id);
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
    if (b.invoice) return b.invoice;
    const t = this.tour(b.tourId);
    if (b.mode === "on_completion") {
      if (!b.confirmedAt) throw new ServiceError("not_confirmed_by_traveller");
      const made = await this.backend.receiver(b.guideId).makeInvoice({ amountSats: b.priceSats, description: t.title.en, expirySecs: 600 });
      this.save({ ...this.booking(bookingId), invoice: made.invoice, paymentHash: made.paymentHash });
      return made.invoice;
    }
    if (!m.paymentHash) throw new ServiceError("no_approved_mandate");
    const expirySecs = Math.max(60, Math.min(this.cfg.invoiceExpirySecs, Math.floor((b.tourStart - this.clock()) / 1000)));
    const made = await this.backend.receiver(b.guideId).makeHoldInvoice({ amountSats: b.priceSats, paymentHash: m.paymentHash, description: t.title.en, expirySecs });
    this.save({ ...this.booking(bookingId), invoice: made.invoice });
    return made.invoice;
  }

  payWithinMandate(bookingId: string, invoice: string): Promise<PayResult> {
    return payWithinMandate(
      {
        store: this.store,
        backend: this.backend,
        clock: this.clock,
        feed: this.feed,
        log: this.log,
        travellerWalletId: this.cfg.travellerWalletId,
        guideWalletOf: (b) => b.guideId,
        acceptTimeoutMs: this.cfg.acceptTimeoutMs,
        pollMs: this.cfg.pollMs,
        onFinal: (id: string, o: PayOutcome) => {
          this.log.info("payment_final", { bookingId: id, status: o.status });
          this.emit({ type: "wallet" });
        },
      },
      bookingId,
      invoice,
    ).then((r) => {
      const b = this.store.getBooking(bookingId);
      if (b) this.emit({ type: "booking", booking: b });
      return r;
    });
  }
}
