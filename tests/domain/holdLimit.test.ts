import { describe, it, expect } from "vitest";
import { BLOCK_MS, holdFits, lockLeadMs, MEASURED_HOLD_LIMIT_BLOCKS, parseSettleDeadline, SAFETY_MARGIN_BLOCKS, UNIX_TIME_THRESHOLD } from "../../src/domain/holdLimit";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-16T09:07:00Z");

describe("settle_deadline: block height or unix seconds", () => {
  it("values below 500 000 000 are block heights, the rest unix seconds (the nLockTime rule)", () => {
    expect(parseSettleDeadline(976_121)).toEqual({ kind: "height", height: 976_121 }); // as measured on the faucet wallets
    expect(parseSettleDeadline(UNIX_TIME_THRESHOLD - 1)).toEqual({ kind: "height", height: 499_999_999 });
    expect(parseSettleDeadline(UNIX_TIME_THRESHOLD)).toEqual({ kind: "unix", atMs: 500_000_000_000 });
    expect(parseSettleDeadline(1_763_300_000)).toEqual({ kind: "unix", atMs: 1_763_300_000_000 });
  });
  it("anything else is no deadline", () => {
    for (const v of [undefined, null, 0, -5, 1.5, "976121", Number.NaN, Infinity]) expect(parseSettleDeadline(v)).toBeNull();
  });
});

describe("the lock window from the measured hold limit", () => {
  it("(24 - 6) blocks x 10 min - 2 h meeting buffer = the window opens 1 h before the tour", () => {
    expect(MEASURED_HOLD_LIMIT_BLOCKS).toBe(24);
    expect(SAFETY_MARGIN_BLOCKS).toBe(6);
    expect(lockLeadMs()).toBe(HOUR);
    expect(lockLeadMs(144, 6, 2 * HOUR)).toBe(21 * HOUR); // a wallet with a 1-day limit would allow more
    expect(() => lockLeadMs(18)).toThrow(RangeError); // 12 blocks left cannot cover a 2 h buffer plus any lead
  });
});

describe("holdFits", () => {
  const height = 976_097;
  const fits = (deadline: unknown, settleIn: number, blockHeight: number | undefined = height) => holdFits({ settleDeadline: deadline, blockHeight, now: NOW, settleBy: NOW + settleIn });
  it("the measured 24-block hold fits a settle up to 3 h away (18 blocks) with 6 to spare, and not one block more", () => {
    expect(fits(height + 24, 3 * HOUR)).toMatchObject({ ok: true, spareBlocks: 0 });
    expect(fits(height + 24, 1 * HOUR)).toMatchObject({ ok: true, spareBlocks: 12 });
    expect(fits(height + 24, 3 * HOUR + 1)).toMatchObject({ ok: false, reason: "too_short", spareBlocks: -1 });
    expect(fits(height + 24, 10 * HOUR)).toMatchObject({ ok: false, reason: "too_short" }); // the old 10 h window
  });
  it("compares heights directly: the time estimate only converts the wait into blocks (rounded up)", () => {
    expect(fits(height + 24, 2 * HOUR + 50 * 60_000, height + 1)).toMatchObject({ ok: true, spareBlocks: 0 }); // 17 blocks needed
    expect(fits(height + 24, 2 * HOUR + 50 * 60_000 + 1, height + 1)).toMatchObject({ ok: false, spareBlocks: -1 });
    expect(fits(height + 24, -HOUR)).toMatchObject({ ok: true, spareBlocks: 18 }); // settle moment already passed
  });
  it("unix-seconds deadlines: margin of 6 x 10 min", () => {
    const at = (ms: number) => Math.floor((NOW + ms) / 1000);
    expect(fits(at(4 * HOUR), 3 * HOUR)).toMatchObject({ ok: true, spareBlocks: 0 });
    expect(fits(at(4 * HOUR), 3 * HOUR + BLOCK_MS)).toMatchObject({ ok: false, reason: "too_short" });
  });
  it("fails closed without a deadline, or without the wallet's block height for a height deadline", () => {
    expect(fits(undefined, HOUR)).toEqual({ ok: false, reason: "no_settle_deadline", deadline: null });
    expect(holdFits({ settleDeadline: height + 24, blockHeight: undefined, now: NOW, settleBy: NOW + HOUR })).toMatchObject({ ok: false, reason: "no_block_height" });
    expect(fits(height + 24, HOUR, 0)).toMatchObject({ ok: false, reason: "no_block_height" });
  });
});
