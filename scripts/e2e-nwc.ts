// `npm run e2e:nwc`: the run over Nostr Wallet Connect on two test wallets (opt-in).
// It refuses to start unless .env holds NWC_TRAVELLER_URL, NWC_GUIDE_URL and NWC_NETWORK.
// It never prints a connection string or the preimage. Amount: 10 sats per step, NWC_E2E_MAX_SATS
// (default 100) or less in total. The steps are in scripts/e2e-nwc-flow.ts.
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
const { bytesToHex } = await import("@noble/hashes/utils.js");
const { nwcBackendFromEnv } = await import("../src/ln/nwc");
const { makeLogger } = await import("../src/log/redact");
const { runNwcFlow } = await import("./e2e-nwc-flow");

const log = makeLogger();
const max = Math.min(Number(process.env.NWC_E2E_MAX_SATS || 100), 1000);
const AMOUNT = Math.min(10, Math.floor(max / 2)); // two locks per run
if (!(AMOUNT >= 1)) refuse("NWC_E2E_MAX_SATS must allow at least 2 sats");
const be = await nwcBackendFromEnv(process.env, { traveller: "traveller", guide: "guide" });

try {
  await runNwcFlow({
    payer: be.payer("traveller"),
    receiver: be.receiver("guide"),
    network: be.network,
    payeeProof: be.payeeProof,
    log,
    amountSats: AMOUNT,
    newSecret: () => bytesToHex(randomBytes(32)),
  });
} finally {
  be.close();
}
