// A dry run of `npm run e2e:nwc` against the SIMULATED backend, with a payer that behaves like the
// NWC adapter on the measured faucet wallets: a cancelled hold makes pay_invoice fail ("unknown").
// The reported outcome must still come from the guide's wallet: refunded, not unknown.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { runNwcFlow } from "../../scripts/e2e-nwc-flow";
import { SimBackend, SimLedger } from "../../src/ln/sim";
import { makeLogger } from "../../src/log/redact";
import type { PayerWallet } from "../../src/ln/backend";

describe("e2e:nwc flow (offline, SIMULATED wallets)", () => {
  it("settles one hold, cancels another, and reports both endings from lookup_invoice", async () => {
    const ledger = new SimLedger({ clock: Date.now, balances: { traveller: 1000, guide: 0 } });
    const be = new SimBackend(ledger);
    const p = be.payer("traveller");
    const nwcLike: PayerWallet = {
      ...p,
      payInvoice: async (inv) => {
        const o = await p.payInvoice(inv);
        return o.status === "refunded" ? { status: "unknown", error: "INTERNAL" } : o;
      },
    };
    const lines: string[] = [];
    const secrets: string[] = [];
    const r = await runNwcFlow({
      payer: nwcLike,
      receiver: be.receiver("guide"),
      network: be.network,
      payeeProof: be.payeeProof,
      log: makeLogger((l) => lines.push(l)),
      amountSats: 10,
      newSecret: () => {
        const s = bytesToHex(randomBytes(32));
        secrets.push(s);
        return s;
      },
      pollMs: 1,
      payReplyMs: 50,
    });
    expect(r.settle).toEqual({ payOutcome: "settled", walletState: "settled", reconciled: "settled", travellerDeltaSats: -10 });
    expect(r.cancel).toEqual({ payOutcome: "unknown", walletState: "cancelled", reconciled: "released", travellerDeltaSats: 0 });
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["gate_hold_methods_ok", "gate_budget", "gate_chain", "hold_accepted", "e2e_settle_done", "hold_accepted", "e2e_cancel_done"]);
    expect(JSON.parse(lines[3]!)).toMatchObject({ deadlineKind: "height", blocksAhead: 24, windowFits: true, spareBlocks: 0 });
    const all = lines.join("\n");
    for (const s of secrets) expect(all).not.toContain(s);
    expect(all).not.toContain((await be.receiver("guide").getInfo()).pubkey);
    expect(ledger.allHolds().filter((h) => h.state === "accepted")).toEqual([]); // nothing left in a hold
  });

  it("a hold that was never accepted is cancelled before the run gives up, so a late payment cannot lock sats", async () => {
    const ledger = new SimLedger({ clock: Date.now, balances: { traveller: 1000, guide: 0 } });
    const be = new SimBackend(ledger);
    const stuck: PayerWallet = { ...be.payer("traveller"), payInvoice: () => new Promise(() => {}) }; // the payment is still on its way
    const secrets: string[] = [];
    await expect(
      runNwcFlow({
        payer: stuck,
        receiver: be.receiver("guide"),
        network: be.network,
        payeeProof: be.payeeProof,
        log: makeLogger(() => {}),
        amountSats: 10,
        newSecret: () => {
          const s = bytesToHex(randomBytes(32));
          secrets.push(s);
          return s;
        },
        pollMs: 1,
        maxPolls: 3,
        payReplyMs: 10,
      }),
    ).rejects.toThrow("hold never accepted");
    const h = bytesToHex(sha256(hexToBytes(secrets[0]!)));
    expect(ledger.holdState("guide", h)).toBe("cancelled");
  });
});
