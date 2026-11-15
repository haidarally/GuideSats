import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkInvoice, type InvoiceExpectation } from "../../src/ln/invoiceCheck";
import { encodeSimInvoice, type SimInvoiceParams } from "../../src/ln/bolt11";

// BOLT11 spec example 2: 250,000 sat, "1 cup coffee", expiry 60 s, signed by SPEC_PAYEE.
const spec2 = readFileSync(new URL("../../fixtures/bolt11/spec-example-2.txt", import.meta.url), "utf8").trim();
const SPEC_PAYEE = "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad";
const SPEC_HASH = "0001020304050607080900010203040506070809000102030405060708090102";
const SPEC_TS = 1_496_314_658;

const real: InvoiceExpectation = { network: "mainnet", amountSats: 250_000, paymentHash: SPEC_HASH, payeePubkey: SPEC_PAYEE, now: SPEC_TS * 1000, minSecondsLeft: 10, payeeProof: "signature" };

describe("checkInvoice on the BOLT11 spec vector (signature payee)", () => {
  it("accepts the invoice when everything matches", () => {
    const r = checkInvoice(spec2, real);
    expect(r).toMatchObject({ ok: true, invoice: { amountSats: 250_000, paymentHash: SPEC_HASH, payeePubkey: SPEC_PAYEE, description: "1 cup coffee" } });
  });
  it.each<[Partial<InvoiceExpectation>, string]>([
    [{ network: "regtest" }, "wrong_network"],
    [{ network: "testnet" }, "wrong_network"],
    [{ amountSats: 249_999 }, "wrong_amount"],
    [{ amountSats: 250_001 }, "wrong_amount"],
    [{ paymentHash: "ff".repeat(32) }, "wrong_hash"],
    [{ now: (SPEC_TS + 55) * 1000 }, "expired"],
    [{ now: (SPEC_TS + 3600) * 1000 }, "expired"],
    [{ payeePubkey: "02" + "11".repeat(32) }, "wrong_payee"],
  ])("refuses %o -> %s", (over, reason) => {
    expect(checkInvoice(spec2, { ...real, ...over })).toEqual({ ok: false, reason });
  });
  it("refuses garbage, a tampered string, and oversize input", () => {
    expect(checkInvoice("hello", real)).toEqual({ ok: false, reason: "undecodable" });
    expect(checkInvoice(spec2.slice(0, -3) + "qqq", real)).toEqual({ ok: false, reason: "undecodable" });
    expect(checkInvoice("ln" + "q".repeat(5000), real)).toEqual({ ok: false, reason: "undecodable" });
  });
  it("cannot use the simulator shortcut on mainnet (fails closed)", () => {
    expect(checkInvoice(spec2, { ...real, payeeProof: "sim_n_tag" })).toEqual({ ok: false, reason: "unverifiable_payee" });
  });
});

describe("checkInvoice on SIMULATED invoices", () => {
  const PAYEE = "02" + "11".repeat(32);
  const H = "ab".repeat(32);
  const now = 1_763_236_800_000;
  const mk = (over: Partial<SimInvoiceParams> = {}) =>
    encodeSimInvoice({ network: "regtest", amountSats: 21_000, paymentHash: H, description: "[SIMULATED] tour", timestamp: now / 1000, expirySecs: 3600, payeeNodeId: PAYEE, ...over });
  const sim: InvoiceExpectation = { network: "regtest", amountSats: 21_000, paymentHash: H, payeePubkey: PAYEE, now, payeeProof: "sim_n_tag" };

  it("accepts a matching sim invoice via its n tag", () => {
    expect(checkInvoice(mk(), sim).ok).toBe(true);
  });
  it("refuses a sim invoice when real signature proof is required", () => {
    expect(checkInvoice(mk(), { ...sim, payeeProof: "signature" })).toEqual({ ok: false, reason: "unverifiable_payee" });
  });
  it("refuses an unsigned invoice that claims mainnet", () => {
    expect(checkInvoice(mk({ network: "mainnet" }), { ...sim, network: "mainnet", payeeProof: "signature" })).toEqual({ ok: false, reason: "unverifiable_payee" });
  });
  it.each<[Partial<SimInvoiceParams>, string]>([
    [{ amountSats: 21_001 }, "wrong_amount"],
    [{ paymentHash: "cd".repeat(32) }, "wrong_hash"],
    [{ payeeNodeId: "03" + "22".repeat(32) }, "wrong_payee"],
    [{ expirySecs: 30 }, "expired"],
    [{ network: "testnet" }, "wrong_network"],
  ])("refuses a sim invoice with %o -> %s", (over, reason) => {
    expect(checkInvoice(mk(over), sim)).toEqual({ ok: false, reason });
  });
});
