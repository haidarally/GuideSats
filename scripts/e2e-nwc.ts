// `npm run e2e:nwc`: the REAL run on two Nostr Wallet Connect test wallets (opt-in).
// It refuses to start unless .env holds NWC_TRAVELLER_URL, NWC_GUIDE_URL and NWC_NETWORK.
// It never prints a connection string or the preimage. Amount: NWC_E2E_MAX_SATS (default 100) or less.
//
// Steps: (0) gate: guide wallet lists the hold methods; record get_budget and settle_deadline
//        (1) lock 10 sats with a hold invoice, then settle with P
//        (2) lock 10 sats again with a new P, then cancel: the traveller is refunded
import { existsSync } from "node:fs";

const REQUIRED = ["NWC_TRAVELLER_URL", "NWC_GUIDE_URL", "NWC_NETWORK"] as const;

function refuse(msg: string): never {
  process.stderr.write(`e2e:nwc refused: ${msg}\nCopy .env.example to .env and fill the values for two TEST wallets (never commit .env).\n`);
  process.exit(2);
}

if (!existsSync(".env")) refuse("no .env file in the repo root");
try {
  process.loadEnvFile(".env");
} catch {
  refuse(".env could not be read");
}
const missing = REQUIRED.filter((k) => !(process.env[k] ?? "").trim());
if (missing.length > 0) refuse(`missing values: ${missing.join(", ")}`);

// Only now load the SDK and the adapter.
const { randomBytes } = await import("node:crypto");
const { sha256 } = await import("@noble/hashes/sha2.js");
const { bytesToHex, hexToBytes } = await import("@noble/hashes/utils.js");
const { nwcBackendFromEnv, assertHoldSupport } = await import("../src/ln/nwc");
const { checkInvoice } = await import("../src/ln/invoiceCheck");
const { makeLogger } = await import("../src/log/redact");

const log = makeLogger();
const max = Math.min(Number(process.env.NWC_E2E_MAX_SATS || 100), 1000);
const AMOUNT = Math.min(10, max);
const be = await nwcBackendFromEnv(process.env, { traveller: "traveller", guide: "guide" });
const traveller = be.payer("traveller");
const guide = be.receiver("guide");

try {
  const gInfo = await guide.getInfo();
  assertHoldSupport(gInfo);
  log.info("gate_hold_methods_ok", { methods: gInfo.methods });
  log.info("gate_budget", { budget: await traveller.getBudget() });

  for (const ending of ["settle", "cancel"] as const) {
    const p = bytesToHex(randomBytes(32));
    const h = bytesToHex(sha256(hexToBytes(p)));
    const made = await guide.makeHoldInvoice({ amountSats: AMOUNT, paymentHash: h, description: `GuideSats e2e ${ending}`, expirySecs: 600 });
    const ci = checkInvoice(made.invoice, { network: be.network, amountSats: AMOUNT, paymentHash: h, payeePubkey: gInfo.pubkey, now: Date.now(), payeeProof: "signature" });
    if (!ci.ok) throw new Error(`invoice check refused: ${ci.reason}`);
    const before = await traveller.getBalance();
    const final = traveller.payInvoice(made.invoice);
    let state = "open";
    for (let i = 0; i < 60 && state !== "accepted"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const l = await guide.lookupInvoice(h);
      state = l.state;
      if (state === "accepted") log.info("hold_accepted", { paymentHash: h, settleDeadline: l.settleDeadline });
    }
    if (state !== "accepted") throw new Error(`hold never accepted (state ${state})`);
    if (ending === "settle") await guide.settleHoldInvoice(p);
    else await guide.cancelHoldInvoice(h);
    const o = await final;
    const after = await traveller.getBalance();
    log.info(`e2e_${ending}_done`, { outcome: o.status, travellerDeltaSats: after - before });
  }
} finally {
  be.close();
}
