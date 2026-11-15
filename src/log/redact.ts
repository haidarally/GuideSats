// Log redaction: no secrets, no preimages, no PII in logs.
// Rules (applied recursively to every log record):
//  - keys that name a secret or personal field are replaced, whatever their value;
//  - NWC connection strings, emails and phone numbers are replaced wherever they appear;
//  - BOLT11 invoices are shortened (they can carry a free-text description);
//  - any other 64-hex value is replaced unless its key is on the public allow-list
//    (payment hashes and node pubkeys are public by design).

const SECRET_KEYS = /(preimage|secret|password|passwd|token|apikey|api_key|authorization|cookie|nwc|connection|seed|mnemonic|privkey|private)/i;
const PII_KEYS = /(name|email|phone|mobile|address|passport|dob|birthdate)$/i;
const PUBLIC_HEX_KEYS = /^(paymenthash|payment_hash|hash|payeepubkey|payee_pubkey|pubkey|nodeid|node_id|eventid)$/i;

const NWC_URL = /nostr\+walletconnect:\/\/[^\s"']+/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(\+\d[\d\s().-]{6,}\d)|(\b5\d{3}[\s-]?\d{4}\b)/g; // international "+..." or a Mauritian mobile
const BOLT11 = /\bln(bc|tb|tbs|bcrt)[0-9a-z]{20,}\b/gi;
const HEX64 = /\b[0-9a-f]{64}\b/gi;

export const REDACTED = "[REDACTED]";

function redactString(s: string, allowHex: boolean): string {
  let out = s
    .replace(NWC_URL, "[REDACTED_NWC_URL]")
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(BOLT11, (m) => `${m.slice(0, 12)}…(${m.length} chars)`)
    .replace(PHONE, "[REDACTED_PHONE]");
  if (!allowHex) out = out.replace(HEX64, "[REDACTED_HEX]");
  return out;
}

export function redact(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[DEPTH]";
  if (key && SECRET_KEYS.test(key)) return REDACTED;
  if (key && PII_KEYS.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value, PUBLIC_HEX_KEYS.test(key));
  if (Array.isArray(value)) return value.map((v) => redact(v, key, depth + 1));
  if (value instanceof Error) return { error: value.name, message: redactString(value.message, false) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return value;
}

export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** JSON-lines logger. Every record goes through redact() before it reaches the sink. */
export function makeLogger(sink: LogSink = (l) => process.stdout.write(l + "\n"), clock: () => number = Date.now): Logger {
  const emit = (level: string, event: string, fields: Record<string, unknown> = {}) =>
    sink(JSON.stringify({ t: new Date(clock()).toISOString(), level, event: redactString(event, false), ...(redact(fields) as object) }));
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f) };
}
