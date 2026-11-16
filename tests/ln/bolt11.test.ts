import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decode } from "light-bolt11-decoder";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeSignedInvoice, encodeSimInvoice, recoverPayee, wordsToBytesPadded } from "../../src/ln/bolt11";
import { checkInvoice } from "../../src/ln/invoiceCheck";

const spec2 = readFileSync(new URL("../../fixtures/bolt11/spec-example-2.txt", import.meta.url), "utf8").trim();
const SPEC_PAYEE = "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad";

describe("bolt11 helpers", () => {
  it("recovers the payee of BOLT11 spec example 2 from its signature", () => {
    expect(recoverPayee(spec2)).toBe(SPEC_PAYEE);
  });
  it("a single flipped character breaks the checksum (no recovery)", () => {
    const bad = spec2.slice(0, 60) + (spec2[60] === "q" ? "p" : "q") + spec2.slice(61);
    expect(recoverPayee(bad)).toBeNull();
  });
  it("pads 5-bit words to bytes the BOLT11 way", () => {
    expect(Array.from(wordsToBytesPadded([31, 31, 31]))).toEqual([0xff, 0xfe]);
  });
  it("encodes SIMULATED invoices that light-bolt11-decoder reads back", () => {
    const inv = encodeSimInvoice({ network: "regtest", amountSats: 21_000, paymentHash: "ab".repeat(32), description: "Le Morne hike", timestamp: 1_763_236_800, expirySecs: 43_200, payeeNodeId: "02" + "11".repeat(32) });
    expect(inv.startsWith("lnbcrt210000n1")).toBe(true);
    const d = decode(inv);
    const get = (n: string) => (d.sections as { name: string; value?: unknown }[]).find((s) => s.name === n)?.value;
    expect(get("amount")).toBe("21000000");
    expect((get("coin_network") as { bech32: string }).bech32).toBe("bcrt");
    expect(get("payment_hash")).toBe("ab".repeat(32));
    expect(get("payee")).toBe("02" + "11".repeat(32));
    expect(get("description")).toBe("Le Morne hike");
    expect(get("expiry")).toBe(43_200); // relative seconds (the `x` tag)
    expect(recoverPayee(inv)).toBeNull(); // zero signature: nobody signed it
  });
  it("signs an invoice with a throwaway key: the payee recovered from the signature is that key", () => {
    const sk = secp256k1.utils.randomSecretKey();
    const pub = bytesToHex(secp256k1.getPublicKey(sk, true));
    const p = { network: "mainnet" as const, amountSats: 210, paymentHash: "cd".repeat(32), description: "forged", timestamp: 1_763_236_800, expirySecs: 600 };
    const inv = encodeSignedInvoice(p, sk);
    expect(inv.startsWith("lnbc2100n1")).toBe(true);
    expect(recoverPayee(inv)).toBe(pub);
    const exp = { network: "mainnet" as const, amountSats: 210, paymentHash: "cd".repeat(32), now: 1_763_236_800_000, payeeProof: "signature" as const };
    expect(checkInvoice(inv, { ...exp, payeePubkey: pub })).toMatchObject({ ok: true });
    expect(checkInvoice(inv, { ...exp, payeePubkey: SPEC_PAYEE })).toEqual({ ok: false, reason: "wrong_payee" });
  });
  it("refuses bad simulator inputs", () => {
    const ok = { network: "regtest" as const, amountSats: 1, paymentHash: "ab".repeat(32), description: "", timestamp: 1, expirySecs: 60, payeeNodeId: "02" + "11".repeat(32) };
    expect(() => encodeSimInvoice({ ...ok, amountSats: 0 })).toThrow();
    expect(() => encodeSimInvoice({ ...ok, paymentHash: "zz" })).toThrow();
    expect(() => encodeSimInvoice({ ...ok, payeeNodeId: "04" })).toThrow();
  });
});
