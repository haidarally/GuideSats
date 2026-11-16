// `npm run e2e:nwc-app`: the app itself over Nostr Wallet Connect on two TEST wallets (opt-in).
// It starts the same world, watcher and API as `npm run demo:nwc` on 127.0.0.1, then drives two flows
// through the HTTP API (scripts/e2e-nwc-app-flow.ts): (a) lock and settle, (b) lock and refund on the
// synthetic cyclone replay. It refuses to start without .env, when the two tours together cost more than
// NWC_E2E_MAX_SATS (default 100 when empty, as for e2e:nwc; never more than 1 000), or when the traveller
// has under 2 000 sats.
// It never prints a connection string or the secret P. Whatever is still held at the end is cancelled.
import { once } from "node:events";
import { loadNwcEnvOrExit } from "../src/server/nwcEnv";

loadNwcEnvOrExit("e2e:nwc-app");

// Only now load the SDK and the app.
const { randomBytes } = await import("node:crypto");
const { bytesToHex } = await import("@noble/hashes/utils.js");
const { serve } = await import("@hono/node-server");
const { nwcBackendFromEnv } = await import("../src/ln/nwc");
const { buildNwcWorld, loadNwcSeed, releaseHolds } = await import("../src/app/nwcWorld");
const { createApp } = await import("../src/server/app");
const { startWatcher } = await import("../src/server/watcher");
const { makeLogger } = await import("../src/log/redact");
const { runAppFlows } = await import("./e2e-nwc-app-flow");

const MIN_BALANCE = 2000;
const log = makeLogger();
const refuse = (msg: string): never => {
  process.stderr.write(`e2e:nwc-app refused: ${msg}\n`);
  process.exit(2);
};

const seed = loadNwcSeed();
const [settleTour, refundTour] = seed.tours;
const guide = seed.guides[0];
if (!settleTour || !refundTour || !guide) refuse("the NWC seed needs one guide and two tours");
const max = Math.min(Number(process.env.NWC_E2E_MAX_SATS || 100), 1000);
const total = settleTour!.priceSats + refundTour!.priceSats;
if (!(total <= max)) refuse(`the two flows lock ${total} sats; NWC_E2E_MAX_SATS allows ${max}`);

const backend = await nwcBackendFromEnv(process.env, { traveller: seed.traveller.id, guide: guide!.id });
const balance = await backend.payer(seed.traveller.id).getBalance();
if (balance < MIN_BALANCE) {
  backend.close();
  refuse(`the traveller wallet has ${balance} sats, under ${MIN_BALANCE}: stop (no top-up from here)`);
}

const world = await buildNwcWorld({ backend, seed, log });
const watcher = startWatcher({ svc: () => world.svc, log });
await watcher.tick();
const allowedHosts: string[] = [];
const app = createApp({
  world: () => world,
  reset: async () => {
    throw new Error("no reset over NWC");
  },
  allowedHosts,
  log,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await once(server, "listening");
const port = (server.address() as { port: number }).port;
allowedHosts.push(`127.0.0.1:${port}`);
log.info("e2e_nwc_app_server", { url: `http://127.0.0.1:${port}`, network: backend.network, travellerSats: balance, maxSats: max });

const call = async (path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as unknown };
};

let code = 0;
try {
  const report = await runAppFlows({ call, log, newSecret: () => bytesToHex(randomBytes(32)), tours: { settle: settleTour!.id, refund: refundTour!.id }, minBalanceSats: MIN_BALANCE });
  log.info("e2e_nwc_app_passed", {
    settle: { priceSats: report.settle.priceSats, finalState: report.settle.finalState, travellerDeltaSats: report.settle.travellerDeltaSats, guideDeltaSats: report.settle.guideDeltaSats },
    refund: { priceSats: report.refund.priceSats, finalState: report.refund.finalState, travellerDeltaSats: report.refund.travellerDeltaSats, guideDeltaSats: report.refund.guideDeltaSats },
  });
} catch (e) {
  code = 1;
  log.warn("e2e_nwc_app_failed", { err: e });
} finally {
  // Never leave this run's sats in a hold: cancel whatever is still locked or open at the guide's wallet.
  await releaseHolds(world.svc, log);
  watcher.stop();
  server.close();
  backend.close();
}
process.exit(code);
