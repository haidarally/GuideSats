import { describe, it, expect } from "vitest";
import { makeLogger, redact } from "../../src/log/redact";
import { encodeSimInvoice } from "../../src/ln/bolt11";

// Every value below is obviously fake test data.
const FAKE_PREIMAGE = "00".repeat(31) + "07";
const FAKE_HASH = "ab".repeat(32);
const FAKE_NWC = "nostr+walletconnect://" + "0".repeat(64) + "?relay=wss://relay.example.invalid&secret=" + "0".repeat(64);
const FAKE_INVOICE = encodeSimInvoice({ network: "regtest", amountSats: 21_000, paymentHash: FAKE_HASH, description: "Le Morne hike for Jane", timestamp: 1_763_236_800, expirySecs: 600, payeeNodeId: "02" + "11".repeat(32) });

const record = {
  bookingId: "bk_1",
  paymentHash: FAKE_HASH,
  payeePubkey: "02" + "11".repeat(32),
  preimage: FAKE_PREIMAGE,
  nwcUrl: FAKE_NWC,
  travellerName: "Jane Example",
  email: "jane@example.invalid",
  note: `call me on +230 5 123 4567, P is ${FAKE_PREIMAGE}, wallet ${FAKE_NWC}`,
  invoice: FAKE_INVOICE,
  nested: { secret: "s3cr3t", list: [{ preimage: FAKE_PREIMAGE }, "mail jane@example.invalid"] },
  amountSats: 21_000,
};

describe("redact", () => {
  it("matches the snapshot (no secret, preimage or PII survives)", () => {
    expect(redact(record)).toMatchSnapshot();
  });
  it("never lets a preimage, NWC string, name, email or phone through", () => {
    const out = JSON.stringify(redact(record));
    for (const leak of [FAKE_PREIMAGE, "nostr+walletconnect", "Jane Example", "jane@example.invalid", "123 4567", "s3cr3t", "Le Morne hike for Jane"]) {
      expect(out).not.toContain(leak);
    }
  });
  it("keeps public, useful fields", () => {
    const out = redact(record) as Record<string, unknown>;
    expect(out.paymentHash).toBe(FAKE_HASH);
    expect(out.amountSats).toBe(21_000);
    expect(out.bookingId).toBe("bk_1");
  });
  it("the logger redacts before writing", () => {
    const lines: string[] = [];
    const log = makeLogger((l) => lines.push(l), () => 0);
    log.info("settle", { preimage: FAKE_PREIMAGE, hash: FAKE_HASH });
    log.warn(`oops ${FAKE_PREIMAGE}`, { err: new Error(`bad ${FAKE_NWC}`) });
    expect(lines.join("\n")).not.toContain(FAKE_PREIMAGE);
    expect(lines.join("\n")).not.toContain("walletconnect://");
    expect(JSON.parse(lines[0]!)).toEqual({ t: "1970-01-01T00:00:00.000Z", level: "info", event: "settle", preimage: "[REDACTED]", hash: FAKE_HASH });
  });
});
