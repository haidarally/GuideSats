import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { SimBackend, SimLedger, simNodeId, type SimOptions } from "../../src/ln/sim";

const P = "00".repeat(31) + "01"; // test preimage, obviously fake
const H = bytesToHex(sha256(hexToBytes(P)));

function setup(over: Partial<SimOptions> = {}) {
  let now = 1_763_236_800_000;
  const ledger = new SimLedger({ clock: () => now, balances: { traveller: 50_000, guide: 0 }, ...over });
  const be = new SimBackend(ledger);
  return { ledger, be, advance: (ms: number) => (now += ms) };
}

describe("SIMULATED backend", () => {
  it("is labelled simulated and regtest-only", async () => {
    const { be } = setup();
    expect(be.simulated).toBe(true);
    expect(be.network).toBe("regtest");
    const inv = await be.receiver("guide").makeHoldInvoice({ amountSats: 1000, paymentHash: H, description: "x", expirySecs: 600 });
    expect(inv.invoice.startsWith("lnbcrt")).toBe(true);
    expect((await be.receiver("guide").getInfo()).pubkey).toBe(simNodeId("guide"));
  });

  it("lock then settle moves the sats to the guide", async () => {
    const { be, ledger } = setup();
    const g = be.receiver("guide");
    const { invoice } = await g.makeHoldInvoice({ amountSats: 21_000, paymentHash: H, description: "tour", expirySecs: 600 });
    const total = ledger.totalSats();
    const done = be.payer("traveller").payInvoice(invoice);
    expect((await g.lookupInvoice(H)).state).toBe("accepted");
    expect(ledger.balance("traveller")).toBe(29_000);
    expect(ledger.totalSats()).toBe(total);
    await g.settleHoldInvoice(P);
    expect(await done).toEqual({ status: "settled", preimage: P });
    expect(ledger.balance("guide")).toBe(21_000);
    expect(ledger.totalSats()).toBe(total);
  });

  it("lock then cancel refunds the traveller", async () => {
    const { be, ledger } = setup();
    const g = be.receiver("guide");
    const { invoice } = await g.makeHoldInvoice({ amountSats: 21_000, paymentHash: H, description: "tour", expirySecs: 600 });
    const done = be.payer("traveller").payInvoice(invoice);
    await g.cancelHoldInvoice(H);
    expect(await done).toEqual({ status: "refunded" });
    expect(ledger.balance("traveller")).toBe(50_000);
    expect(ledger.balance("guide")).toBe(0);
    await expect(g.settleHoldInvoice(P)).rejects.toThrow("cancelled");
  });

  it("an accepted hold reports a block-height settle_deadline 24 blocks ahead and refunds by itself there", async () => {
    const { be, ledger, advance } = setup();
    const g = be.receiver("guide");
    const { invoice } = await g.makeHoldInvoice({ amountSats: 21_000, paymentHash: H, description: "tour", expirySecs: 600 });
    const done = be.payer("traveller").payInvoice(invoice);
    const height = (await g.getInfo()).blockHeight!;
    expect((await g.lookupInvoice(H)).settleDeadline).toBe(height + 24);
    advance(23 * 600_000 + 599_000); // 23 blocks later: still held
    expect((await g.getInfo()).blockHeight).toBe(height + 23);
    expect((await g.lookupInvoice(H)).state).toBe("accepted");
    advance(1000); // block 24
    expect((await g.lookupInvoice(H)).state).toBe("expired");
    expect(await done).toEqual({ status: "refunded" });
    expect(ledger.balance("traveller")).toBe(50_000);
  });

  it("blocks that come faster than average bring the deadline sooner; a unix-seconds deadline is also modelled", async () => {
    const fast = setup();
    const g = fast.be.receiver("guide");
    const { invoice } = await g.makeHoldInvoice({ amountSats: 1000, paymentHash: H, description: "x", expirySecs: 600 });
    void fast.be.payer("traveller").payInvoice(invoice);
    fast.ledger.mine(24);
    expect((await g.lookupInvoice(H)).state).toBe("expired");

    const unix = setup({ deadlineKind: "unix", holdMaxSecs: 3600 });
    const u = unix.be.receiver("guide");
    const made = await u.makeHoldInvoice({ amountSats: 1000, paymentHash: H, description: "x", expirySecs: 600 });
    void unix.be.payer("traveller").payInvoice(made.invoice);
    expect((await u.lookupInvoice(H)).settleDeadline).toBe(1_763_236_800 + 3600);
    unix.advance(3600_000);
    expect((await u.lookupInvoice(H)).state).toBe("expired");
  });

  it("refuses: insufficient balance, wallet budget, garbage, wrong preimage, expired invoice", async () => {
    const { be, advance } = setup({ balances: { traveller: 500, rich: 100_000, guide: 0 }, budgets: { rich: { totalSats: 1000, usedSats: 0, renewal: "never" } } });
    const g = be.receiver("guide");
    const { invoice } = await g.makeHoldInvoice({ amountSats: 21_000, paymentHash: H, description: "tour", expirySecs: 600 });
    expect(await be.payer("traveller").payInvoice(invoice)).toEqual({ status: "failed", error: "insufficient balance" });
    expect(await be.payer("rich").payInvoice(invoice)).toEqual({ status: "failed", error: "wallet budget exceeded" });
    expect(await be.payer("traveller").payInvoice("lnbcrt1garbage")).toMatchObject({ status: "failed" });
    await expect(g.settleHoldInvoice("11".repeat(32))).rejects.toThrow();
    advance(601_000);
    expect(await be.payer("rich").payInvoice(invoice)).toEqual({ status: "failed", error: "invoice is expired" });
  });

  it("plan B: a regular invoice pays at once and cannot be settled or replayed", async () => {
    const { be, ledger } = setup();
    const g = be.receiver("guide");
    const made = await g.makeInvoice({ amountSats: 12_000, description: "boat", expirySecs: 600 });
    const total = ledger.totalSats();
    const o = await be.payer("traveller").payInvoice(made.invoice);
    expect(o.status).toBe("settled");
    expect(ledger.balance("guide")).toBe(12_000);
    expect(ledger.balance("traveller")).toBe(38_000);
    expect(ledger.totalSats()).toBe(total);
    expect(await be.payer("traveller").payInvoice(made.invoice)).toEqual({ status: "failed", error: "invoice is settled" });
    if (o.status === "settled") await expect(g.settleHoldInvoice(o.preimage!)).rejects.toThrow();
  });
});

describe("SIMULATED backend: cancel is idempotent on a dead hold", () => {
  it("cancelling a cancelled or expired hold is a no-op; a settled one cannot be cancelled", async () => {
    const { be, advance } = setup();
    const g = be.receiver("guide");
    await g.makeHoldInvoice({ amountSats: 1000, paymentHash: H, description: "x", expirySecs: 600 });
    advance(601_000);
    await g.cancelHoldInvoice(H); // expired
    expect((await g.lookupInvoice(H)).state).toBe("expired");
    const P2 = "00".repeat(31) + "02";
    const H2 = bytesToHex(sha256(hexToBytes(P2)));
    const { invoice } = await g.makeHoldInvoice({ amountSats: 1000, paymentHash: H2, description: "x", expirySecs: 600 });
    void be.payer("traveller").payInvoice(invoice);
    await g.settleHoldInvoice(P2);
    await expect(g.cancelHoldInvoice(H2)).rejects.toThrow("settled");
  });
});
