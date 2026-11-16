// The steps of `npm run e2e:nwc`, written against the Lightning interface so they also run offline
// against the SIMULATED backend (tests/scripts/e2e-nwc-flow.test.ts). Never logs a preimage or a node key.
//
//   (0) gate: the guide's wallet lists the hold methods; record get_budget and the chain tip (block_height)
//   (1) lock `amountSats` with a hold invoice, then settle it with P
//   (2) lock `amountSats` again with a new P, then cancel it: the traveller is refunded
// After each ending the outcome is read back from the guide's wallet (lookup_invoice) and resolved
// with the same mapping the app's reconcile step uses, whatever the pay call itself returned.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { holdResolution } from "../src/app/reconcile";
import { holdFits, lockLeadMs, MEETING_BUFFER_MS, parseSettleDeadline } from "../src/domain/holdLimit";
import type { HoldState, PayerWallet, PayOutcome, ReceiverWallet } from "../src/ln/backend";
import type { Network } from "../src/ln/bolt11";
import { checkInvoice, type PayeeProof } from "../src/ln/invoiceCheck";
import { assertHoldSupport } from "../src/ln/nwc";
import type { Logger } from "../src/log/redact";

export interface NwcFlowDeps {
  payer: PayerWallet;
  receiver: ReceiverWallet;
  network: Network;
  payeeProof: PayeeProof;
  log: Logger;
  amountSats: number;
  newSecret: () => string; // 32-byte hex P
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number; // between lookups (default 1 s)
  maxPolls?: number; // per wait (default 60)
  payReplyMs?: number; // how long to wait for the pay call's own answer after the ending (default 60 s)
}

export interface EndingReport {
  payOutcome: PayOutcome["status"];
  walletState: HoldState;
  reconciled: ReturnType<typeof holdResolution>;
  travellerDeltaSats: number;
}

export async function runNwcFlow(d: NwcFlowDeps): Promise<Record<"settle" | "cancel", EndingReport>> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = d.pollMs ?? 1000;
  const maxPolls = d.maxPolls ?? 60;
  const g = d.receiver;

  const gInfo = await g.getInfo();
  assertHoldSupport(gInfo);
  d.log.info("gate_hold_methods_ok", { methods: gInfo.methods, network: gInfo.network });
  d.log.info("gate_budget", { budget: await d.payer.getBudget() });
  d.log.info("gate_chain", { blockHeight: gInfo.blockHeight ?? null });

  const out = {} as Record<"settle" | "cancel", EndingReport>;
  let open: string | null = null; // the hash of a hold this run may still have to cancel
  try {
    for (const ending of ["settle", "cancel"] as const) {
      const p = d.newSecret();
      const h = bytesToHex(sha256(hexToBytes(p)));
      const made = await g.makeHoldInvoice({ amountSats: d.amountSats, paymentHash: h, description: `GuideSats e2e ${ending}`, expirySecs: 600 });
      open = h;
      const ci = checkInvoice(made.invoice, { network: d.network, amountSats: d.amountSats, paymentHash: h, payeePubkey: gInfo.pubkey, now: now(), payeeProof: d.payeeProof });
      if (!ci.ok) throw new Error(`invoice check refused: ${ci.reason}`);
      const before = await d.payer.getBalance();
      const final = d.payer.payInvoice(made.invoice).catch((): PayOutcome => ({ status: "unknown", error: "THROWN" }));

      let state: HoldState = "open";
      for (let i = 0; i < maxPolls && state !== "accepted"; i++) {
        await sleep(pollMs);
        const l = await g.lookupInvoice(h);
        state = l.state;
        if (state === "accepted") {
          // The hold limit, as the app reads it: block height or unix seconds, and whether a lock made at the
          // earliest moment of the window (50 min before a tour) could wait for a settle 2 h after the tour start.
          const blockHeight = (await g.getInfo()).blockHeight;
          const deadline = parseSettleDeadline(l.settleDeadline);
          const t = now();
          const fit = holdFits({ settleDeadline: l.settleDeadline, blockHeight, now: t, settleBy: t + lockLeadMs() + MEETING_BUFFER_MS });
          d.log.info("hold_accepted", {
            ending,
            paymentHash: h,
            settleDeadline: l.settleDeadline ?? null,
            blockHeight: blockHeight ?? null,
            deadlineKind: deadline?.kind ?? null,
            blocksAhead: deadline?.kind === "height" && blockHeight ? deadline.height - blockHeight : null,
            windowFits: fit.ok,
            spareBlocks: "spareBlocks" in fit ? fit.spareBlocks : null,
          });
        }
      }
      if (state !== "accepted") throw new Error(`hold never accepted (state ${state})`);

      if (ending === "settle") await g.settleHoldInvoice(p);
      else await g.cancelHoldInvoice(h);
      const o = await Promise.race([final, sleep(d.payReplyMs ?? 60_000).then((): PayOutcome => ({ status: "unknown", error: "NO_REPLY" }))]);

      // The reconcile step: what does the guide's wallet say now?
      let walletState: HoldState = state;
      for (let i = 0; i < maxPolls && (walletState === "accepted" || walletState === "open"); i++) {
        walletState = (await g.lookupInvoice(h)).state;
        if (walletState === "accepted" || walletState === "open") await sleep(pollMs);
      }
      if (walletState === "accepted") throw new Error(`hold still accepted after the ${ending}`); // the finally cancels it
      open = null;
      const after = await d.payer.getBalance();
      out[ending] = { payOutcome: o.status, walletState, reconciled: holdResolution(walletState), travellerDeltaSats: after - before };
      d.log.info(`e2e_${ending}_done`, { ...out[ending] });
    }
  } finally {
    if (open) {
      // Never leave this run's sats in a hold: cancel whatever is still accepted, and an invoice still open,
      // so that a payment still on its way cannot be accepted after the run.
      try {
        const left = (await g.lookupInvoice(open)).state;
        if (left === "accepted" || left === "open") {
          await g.cancelHoldInvoice(open);
          d.log.warn("cleanup_hold_cancelled", { paymentHash: open });
        }
      } catch (e) {
        d.log.warn("cleanup_failed", { paymentHash: open, err: e });
      }
    }
  }
  return out;
}
