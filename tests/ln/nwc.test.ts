// The NWC adapter, exercised offline through a fake client. No relay, no wallet, no keys.
import { describe, it, expect } from "vitest";
import { assertHoldSupport, mapHoldState, NwcBackend, parseNetwork, requireNwcEnv, type NwcClientLike, type NwcTx } from "../../src/ln/nwc";
import { HoldsUnsupportedError } from "../../src/ln/backend";

const NOW = 1_763_236_800_000;
const H = "ab".repeat(32);

function tx(over: Partial<NwcTx> = {}): NwcTx {
  return { type: "incoming", state: "pending", invoice: "lnbcrt1fake", description: "tour", payment_hash: H, amount: 21_000_000, created_at: NOW / 1000, expires_at: NOW / 1000 + 600, ...over };
}

function fake(over: Partial<NwcClientLike> = {}, methods = ["get_info", "pay_invoice", "make_hold_invoice", "settle_hold_invoice", "cancel_hold_invoice", "lookup_invoice"]) {
  const calls: string[] = [];
  const c: NwcClientLike = {
    getInfo: async () => (calls.push("getInfo"), { pubkey: "02" + "33".repeat(32), network: "regtest", methods }),
    getBudget: async () => (calls.push("getBudget"), { used_budget: 1_000_000, total_budget: 10_000_000, renewal_period: "monthly" }),
    getBalance: async () => (calls.push("getBalance"), { balance: 10_000_999 }),
    payInvoice: async () => (calls.push("payInvoice"), { preimage: "00".repeat(32), fees_paid: 0 }),
    makeHoldInvoice: async (r) => (calls.push(`makeHoldInvoice:${r.amount}`), tx({ payment_hash: r.payment_hash })),
    makeInvoice: async (r) => (calls.push(`makeInvoice:${r.amount}`), tx({ payment_hash: "cd".repeat(32) })),
    settleHoldInvoice: async () => (calls.push("settle"), {}),
    cancelHoldInvoice: async () => (calls.push("cancel"), {}),
    lookupInvoice: async () => (calls.push("lookup"), tx({ state: "accepted", settle_deadline: 123 })),
    listTransactions: async () => ({ transactions: [tx({ state: "settled" })] }),
    close: () => calls.push("close"),
    ...over,
  };
  return { c, calls };
}

describe("NWC adapter (fake client)", () => {
  it("converts msat to sats and reads the budget", async () => {
    const { c } = fake();
    const be = new NwcBackend("regtest", { t: c }, () => NOW);
    expect(await be.payer("t").getBalance()).toBe(10_000);
    expect(await be.payer("t").getBudget()).toEqual({ totalSats: 10_000, usedSats: 1_000, renewal: "monthly" });
    expect(be.simulated).toBe(false);
    expect(be.payeeProof).toBe("signature");
  });
  it("returns null when the wallet has no budget (empty object or error)", async () => {
    const empty = new NwcBackend("regtest", { t: fake({ getBudget: async () => ({}) }).c });
    expect(await empty.payer("t").getBudget()).toBeNull();
    const err = new NwcBackend("regtest", { t: fake({ getBudget: async () => Promise.reject(new Error("NOT_IMPLEMENTED")) }).c });
    expect(await err.payer("t").getBudget()).toBeNull();
  });
  it("asks for hold invoices in msat and refuses a hash swap", async () => {
    const { c, calls } = fake();
    const be = new NwcBackend("regtest", { g: c }, () => NOW);
    const r = await be.receiver("g").makeHoldInvoice({ amountSats: 21_000, paymentHash: H, description: "tour", expirySecs: 600 });
    expect(r.paymentHash).toBe(H);
    expect(calls).toContain("makeHoldInvoice:21000000");
    const swap = new NwcBackend("regtest", { g: fake({ makeHoldInvoice: async () => tx({ payment_hash: "cd".repeat(32) }) }).c });
    await expect(swap.receiver("g").makeHoldInvoice({ amountSats: 1, paymentHash: H, description: "", expirySecs: 60 })).rejects.toThrow("different hash");
  });
  it("gates on the hold methods", async () => {
    const { c } = fake({}, ["get_info", "pay_invoice", "make_invoice", "lookup_invoice"]);
    const be = new NwcBackend("regtest", { g: c });
    await expect(be.receiver("g").makeHoldInvoice({ amountSats: 1, paymentHash: H, description: "", expirySecs: 60 })).rejects.toBeInstanceOf(HoldsUnsupportedError);
    expect(() => assertHoldSupport({ methods: ["make_hold_invoice"] })).toThrow("settle_hold_invoice, cancel_hold_invoice");
  });
  it("reads the chain tip from get_info (block_height), when the wallet reports it", async () => {
    const withHeight = new NwcBackend("regtest", { g: fake({ getInfo: async () => ({ pubkey: "02" + "33".repeat(32), network: "regtest", methods: [], block_height: 976_097 }) }).c });
    expect((await withHeight.receiver("g").getInfo()).blockHeight).toBe(976_097);
    expect((await new NwcBackend("regtest", { g: fake().c }).receiver("g").getInfo()).blockHeight).toBeUndefined();
  });
  it("refuses a wallet on another network", async () => {
    const be = new NwcBackend("mainnet", { g: fake().c });
    await expect(be.receiver("g").getInfo()).rejects.toThrow("expected mainnet");
  });
  it("maps lookup states", async () => {
    const be = new NwcBackend("regtest", { g: fake().c }, () => NOW);
    expect(await be.receiver("g").lookupInvoice(H)).toEqual({ state: "accepted", amountSats: 21_000, settleDeadline: 123 });
    expect(mapHoldState(tx({ state: "pending" }), NOW)).toBe("open");
    expect(mapHoldState(tx({ state: "pending", expires_at: NOW / 1000 - 1 }), NOW)).toBe("expired");
    expect(mapHoldState(tx({ state: "failed" }), NOW)).toBe("cancelled");
    expect(mapHoldState(tx({ state: "settled" }), NOW)).toBe("settled");
  });
  it("maps pay errors: definite failure vs unknown (timeout)", async () => {
    const fail = new NwcBackend("regtest", { t: fake({ payInvoice: async () => Promise.reject(Object.assign(new Error("x"), { code: "INSUFFICIENT_BALANCE" })) }).c });
    expect(await fail.payer("t").payInvoice("ln")).toEqual({ status: "failed", error: "INSUFFICIENT_BALANCE" });
    const to = new NwcBackend("regtest", { t: fake({ payInvoice: async () => Promise.reject(Object.assign(new Error("x"), { name: "Nip47ReplyTimeoutError" })) }).c });
    expect(await to.payer("t").payInvoice("ln")).toEqual({ status: "unknown", error: "Nip47ReplyTimeoutError" });
  });
  it("fails closed on any pay error it cannot classify: only wallet-reported refusals are definite", async () => {
    const rejecting = (e: unknown) => new NwcBackend("regtest", { t: fake({ payInvoice: async () => Promise.reject(e) }).c }).payer("t");
    expect(await rejecting(new Error("socket closed")).payInvoice("ln")).toMatchObject({ status: "unknown" });
    expect(await rejecting(Object.assign(new Error("x"), { code: "OTHER" })).payInvoice("ln")).toMatchObject({ status: "unknown" });
    expect(await rejecting(Object.assign(new Error("x"), { code: "INTERNAL" })).payInvoice("ln")).toMatchObject({ status: "unknown" });
    expect(await rejecting("not even an Error").payInvoice("ln")).toMatchObject({ status: "unknown" });
    // What a cancelled hold looked like on the faucet wallets: the text is never read, only the code.
    const canceled = Object.assign(new Error("Hold invoice canceled"), { name: "Nip47WalletError", code: "INTERNAL" });
    expect(await rejecting(canceled).payInvoice("ln")).toEqual({ status: "unknown", error: "INTERNAL" });
    for (const code of ["PAYMENT_FAILED", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "RATE_LIMITED", "NOT_IMPLEMENTED"]) {
      expect(await rejecting(Object.assign(new Error("x"), { code })).payInvoice("ln")).toEqual({ status: "failed", error: code });
    }
  });
  it("parses networks", () => {
    expect(parseNetwork("bitcoin")).toBe("mainnet");
    expect(parseNetwork(" Signet ")).toBe("signet");
    expect(() => parseNetwork("liquid")).toThrow();
  });
});

describe("requireNwcEnv", () => {
  it("refuses empty env and never echoes values", () => {
    expect(() => requireNwcEnv({})).toThrow("missing env: NWC_TRAVELLER_URL, NWC_GUIDE_URL, NWC_NETWORK");
    try {
      requireNwcEnv({ NWC_TRAVELLER_URL: "http://example.invalid/not-nwc", NWC_GUIDE_URL: "x", NWC_NETWORK: "regtest" });
    } catch (e) {
      expect(String(e)).not.toContain("example.invalid");
      expect(String(e)).toContain("NWC_TRAVELLER_URL is not a nostr+walletconnect:// URL");
    }
  });
});
