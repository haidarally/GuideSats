// Persistence on node:sqlite (built into Node 22). One JSON column per row keeps it small;
// the mandate status is also a real column so single use is an atomic compare-and-set.
import { createRequire } from "node:module";
import type { Booking, BookingState } from "../domain/booking";
import type { Mandate, MandateStatus } from "../domain/mandate";
import { redact } from "../log/redact";

// Loaded through createRequire so bundlers/test runners that do not know the
// "node:sqlite" builtin yet still resolve it at runtime.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface AuditEntry {
  seq: number;
  at: number;
  event: string;
  fields: Record<string, unknown>;
}

export class Store {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, json TEXT NOT NULL);
    `);
  }

  putBooking(b: Booking): void {
    this.db.prepare("INSERT INTO bookings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(b.id, JSON.stringify(b));
  }
  getBooking(id: string): Booking | null {
    const r = this.db.prepare("SELECT json FROM bookings WHERE id = ?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Booking) : null;
  }
  listBookings(): Booking[] {
    return (this.db.prepare("SELECT json FROM bookings ORDER BY rowid").all() as { json: string }[]).map((r) => JSON.parse(r.json) as Booking);
  }
  /** Atomic compare-and-set on the booking state: returns false if someone else moved the booking first. */
  casBooking(next: Booking, expected: BookingState): boolean {
    const r = this.db.prepare("UPDATE bookings SET json = ? WHERE id = ? AND json_extract(json, '$.state') = ?").run(JSON.stringify(next), next.id, expected);
    return Number(r.changes) === 1;
  }

  insertMandate(m: Mandate): void {
    this.db.prepare("INSERT INTO mandates (id, booking_id, status, json) VALUES (?, ?, ?, ?)").run(m.id, m.bookingId, m.status, JSON.stringify(m));
  }
  getMandate(id: string): Mandate | null {
    const r = this.db.prepare("SELECT json FROM mandates WHERE id = ?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Mandate) : null;
  }
  mandateForBooking(bookingId: string): Mandate | null {
    const r = this.db.prepare("SELECT json FROM mandates WHERE booking_id = ?").get(bookingId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Mandate) : null;
  }
  /** Atomic compare-and-set on the status: returns false if someone else moved it first. */
  casMandate(next: Mandate, expected: MandateStatus): boolean {
    const r = this.db.prepare("UPDATE mandates SET status = ?, json = ? WHERE id = ? AND status = ?").run(next.status, JSON.stringify(next), next.id, expected);
    return Number(r.changes) === 1;
  }

  /** Audit trail. Fields are redacted before they are stored. */
  audit(at: number, event: string, fields: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO audit (at, event, json) VALUES (?, ?, ?)").run(at, event, JSON.stringify(redact(fields)));
  }
  listAudit(limit = 100): AuditEntry[] {
    const rows = this.db.prepare("SELECT seq, at, event, json FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as { seq: number; at: number; event: string; json: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, event: r.event, fields: JSON.parse(r.json) as Record<string, unknown> }));
  }

  close(): void {
    this.db.close();
  }
}
