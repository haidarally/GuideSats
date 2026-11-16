// Tiny API client + the traveller's secret. P is made and kept on this phone;
// only H = SHA-256(P) is ever sent to the server before the meeting.
export interface Tx { at: number; direction: "in" | "out"; amountSats: number; paymentHash: string; state: string; description: string }
export interface Tour { id: string; guideId: string; title: { en: string; fr: string }; meetingPoint: { en: string; fr: string }; priceSats: number; startAt: number; durationHours: number }
export interface Guide { id: string; displayName: string; area: string; languages: string[]; payeePubkey: string; balanceSats: number | null; transactions: Tx[] }
export interface Booking {
  id: string; tourId: string; guideId: string; priceSats: number; tourStart: number; tourEnd: number; state: string; paymentHash: string | null; invoice: string | null;
  mode: "hold" | "on_completion"; confirmedAt?: number | null;
  mandate: { status: string; capSats: number; payeePubkey: string; notBefore: number; notAfter: number } | null;
}
export interface State {
  simulated: boolean; backend: string; network: string; blockHeight: number | null; now: number;
  controls: { cyclone: boolean; attack: boolean; expireInvoice: boolean; advance: boolean; reset: boolean };
  cyclone: { active: boolean; event?: { name: string; alertlevel: string }; source: string };
  traveller: { id: string; balanceSats: number | null; budget: { totalSats: number; usedSats: number; renewal: string } | null; transactions: Tx[] };
  guides: Guide[]; tours: Tour[]; bookings: Booking[];
}

export async function getState(): Promise<State> {
  const r = await fetch("/api/state");
  if (!r.ok) throw new Error(`state ${r.status}`);
  return (await r.json()) as State;
}

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const KEY = (bookingId: string) => `guidesats:p:${bookingId}`;

/** Makes P with the browser's CSPRNG, stores it on this device, returns H. */
export async function makeSecret(bookingId: string): Promise<string> {
  const p = crypto.getRandomValues(new Uint8Array(32));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", p));
  try {
    localStorage.setItem(KEY(bookingId), hex(p));
  } catch {
    /* private mode: the code then lives only in memory for this page */
    memory.set(bookingId, hex(p));
  }
  return hex(h);
}
const memory = new Map<string, string>();

export function readSecret(bookingId: string): string | null {
  try {
    return localStorage.getItem(KEY(bookingId)) ?? memory.get(bookingId) ?? null;
  } catch {
    return memory.get(bookingId) ?? null;
  }
}

/** A wallet read that failed comes as null: shown as "…" until the next read. */
export const fmtSats = (n: number | null) => (n === null ? "…" : n.toLocaleString("en-US").replace(/,/g, " "));
export const short = (s: string, n = 8) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
export const fmtTime = (ms: number, lang: string) =>
  new Date(ms).toLocaleString(lang === "fr" ? "fr-FR" : "en-GB", { timeZone: "Indian/Mauritius", weekday: "short", hour: "2-digit", minute: "2-digit" });
