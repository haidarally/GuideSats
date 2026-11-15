// Application service: bookings, mandates, the cyclone watcher and hold expiry.
// Three audiences call it, through three narrow doors:
//   traveller routes -> proposeBooking, approveMandate, cancelByTraveller
//   guide routes     -> settleWithPreimage
//   the agent        -> agentFacade() (read, propose, request invoice, pay within mandate)
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { applyEvent, isTerminal, type Booking } from "../domain/booking";
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

  /** Creates a booking and a DRAFT mandate. The cap and payee come from the catalogue, never from the caller. */
  proposeBooking(tourId: string): { booking: Booking; mandate: Mandate } {
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
      mode: "hold",
      state: "proposed",
      paymentHash: null,
      invoice: null,
      history: [],
    };
    const mandate = draftMandate({
      id: `md_${n}`,
      bookingId: booking.id,
      capSats: t.priceSats,
      payeePubkey: g.payeePubkey,
      notBefore: Math.min(now, t.startAt - this.cfg.lockLeadHours * 3_600_000),
      notAfter: t.startAt,
    });
    this.store.insertMandate(mandate);
    this.save(booking);
    this.store.audit(now, "booking_proposed", { bookingId: booking.id, tourId: t.id, capSats: mandate.capSats });
    return { booking, mandate };
  }

  /** The traveller approves the mandate and binds H = SHA-256(P). P stays on the traveller's phone. */
  approveMandate(bookingId: string, approval: TravellerApproval): Mandate {
    if (!HEX32.test(approval.paymentHash)) throw new ServiceError("bad_payment_hash");
    const b = this.booking(bookingId);
    const m = this.store.mandateForBooking(bookingId);
    if (!m) throw new ServiceError("no_mandate");
    const approved = approveMandate(m, approval);
    if (!this.store.casMandate(approved, "pending_approval")) throw new ServiceError("mandate_changed");
    this.save({ ...applyEvent(b, "APPROVE_MANDATE", approval.at), paymentHash: approval.paymentHash });
    this.store.audit(approval.at, "mandate_approved", { bookingId, capSats: approved.capSats, payeePubkey: approved.payeePubkey, paymentHash: approval.paymentHash });
    return approved;
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

  async requestHoldInvoice(bookingId: string): Promise<string> {
    const b = this.booking(bookingId);
    if (b.state !== "mandated") throw new ServiceError(`not_mandated:${b.state}`);
    const m = this.store.mandateForBooking(bookingId);
    if (!m || m.status !== "approved" || !m.paymentHash) throw new ServiceError("no_approved_mandate");
    if (b.invoice) return b.invoice;
    const t = this.tour(b.tourId);
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
