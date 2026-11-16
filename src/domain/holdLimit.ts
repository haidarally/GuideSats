// The hold limit: how long the guide's wallet lets an accepted hold wait before it cancels it by itself
// (and the traveller is refunded). NWC reports it on lookup_invoice as `settle_deadline`.
//
// Measured on Alby's NWC Faucet test wallets on 16 Nov 2026: settle_deadline 976121 while get_info's
// block_height was 976097, so the deadline is a BLOCK HEIGHT, 24 blocks ahead (about 4 h at the
// 10-minute target), not a clock time. Whether a wallet already keeps its own safety buffer inside that
// figure is not documented, so the app keeps its own margin, in blocks.
//
// Pure functions: the lock window is derived from these numbers, and every accepted hold is checked
// against the deadline its wallet actually reports (app/reconcile.ts).

/** As in Bitcoin's nLockTime: values below this are block heights, values at or above it are unix seconds. */
export const UNIX_TIME_THRESHOLD = 500_000_000;
/** Unix seconds at or above this (the year 2286) cannot be a hold deadline: most likely milliseconds. Refused. */
export const UNIX_SECONDS_MAX = 10_000_000_000;
/** Bitcoin's 10-minute target. Only an estimate, used only where a clock time is unavoidable. */
export const BLOCK_MS = 10 * 60_000;
/** The hold limit measured on the faucet wallets (see above). */
export const MEASURED_HOLD_LIMIT_BLOCKS = 24;
/**
 * Chosen margin: the planned settle moment must come at least 6 blocks (about 1 h) before the deadline.
 * Blocks do not come every 10 minutes: they arrive at random, so more blocks than expected can come while
 * the hold waits. The margin absorbs such bursts, and the time the guide's settle takes to reach the wallet.
 */
export const SAFETY_MARGIN_BLOCKS = 6;
/** The guide may settle up to this long after the tour start (the traveller and the guide meet a little late). */
export const MEETING_BUFFER_MS = 2 * 3_600_000;
/**
 * One block of slack in the window, so a lock at its earliest moment still fits with a block to spare if a
 * block lands between the accept and the check (without it, that lock fits with exactly 0 spare blocks).
 */
export const WINDOW_SLACK_BLOCKS = 1;

/**
 * How long before the tour the agent may lock: (hold limit - margin - slack) blocks at 10 minutes, minus the
 * meeting buffer. With the measured 24 blocks: (24 - 6 - 1) x 10 min - 2 h = 50 min.
 */
export function lockLeadMs(holdLimitBlocks = MEASURED_HOLD_LIMIT_BLOCKS, marginBlocks = SAFETY_MARGIN_BLOCKS, meetingBufferMs = MEETING_BUFFER_MS, slackBlocks = WINDOW_SLACK_BLOCKS): number {
  const lead = (holdLimitBlocks - marginBlocks - slackBlocks) * BLOCK_MS - meetingBufferMs;
  if (!(lead > 0)) throw new RangeError("the hold limit is too short for the margin and the meeting buffer");
  return lead;
}

export type SettleDeadline = { kind: "height"; height: number } | { kind: "unix"; atMs: number };

export function parseSettleDeadline(v: unknown): SettleDeadline | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v >= UNIX_SECONDS_MAX) return null;
  return v >= UNIX_TIME_THRESHOLD ? { kind: "unix", atMs: v * 1000 } : { kind: "height", height: v };
}

export type HoldFit =
  | { ok: true; deadline: SettleDeadline; spareBlocks: number }
  | { ok: false; reason: "no_settle_deadline" | "no_block_height"; deadline: SettleDeadline | null }
  | { ok: false; reason: "too_short"; deadline: SettleDeadline; spareBlocks: number };

/**
 * Can an accepted hold wait until `settleBy` (the latest moment the guide may settle) with the margin to spare?
 * Block-height deadlines are compared in blocks: the wait is converted to blocks at 10 minutes each, rounded
 * up. Fails closed: no deadline, or a height deadline without the wallet's current height, is "no".
 */
export function holdFits(i: { settleDeadline: unknown; blockHeight: number | undefined; now: number; settleBy: number; marginBlocks?: number }): HoldFit {
  const deadline = parseSettleDeadline(i.settleDeadline);
  if (!deadline) return { ok: false, reason: "no_settle_deadline", deadline: null };
  const margin = i.marginBlocks ?? SAFETY_MARGIN_BLOCKS;
  if (deadline.kind === "height") {
    if (typeof i.blockHeight !== "number" || !Number.isSafeInteger(i.blockHeight) || i.blockHeight <= 0) return { ok: false, reason: "no_block_height", deadline };
    const blocksNeeded = Math.max(0, Math.ceil((i.settleBy - i.now) / BLOCK_MS));
    const spareBlocks = deadline.height - margin - (i.blockHeight + blocksNeeded);
    return spareBlocks >= 0 ? { ok: true, deadline, spareBlocks } : { ok: false, reason: "too_short", deadline, spareBlocks };
  }
  const spareMs = deadline.atMs - margin * BLOCK_MS - i.settleBy;
  const spareBlocks = Math.floor(spareMs / BLOCK_MS);
  return spareMs >= 0 ? { ok: true, deadline, spareBlocks } : { ok: false, reason: "too_short", deadline, spareBlocks };
}
