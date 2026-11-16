// `npm run demo`: the SIMULATED world, the API and the PWA on http://127.0.0.1:8787
// `npm run demo:nwc` (--nwc, opt-in): the same API and PWA over Nostr Wallet Connect on the two TEST wallets
// in .env (traveller and guide), with the real clock and the guide wallet's real block height. Only the
// wiring differs: the same service, reconcile step, hold-limit check and watcher run on both backends.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { BookingService } from "../app/service";
import { makeLogger } from "../log/redact";
import { createApp, type AppWorld } from "./app";
import { loadNwcEnvOrExit } from "./nwcEnv";
import { startWatcher } from "./watcher";

const HOST = "127.0.0.1"; // never 0.0.0.0: this demo is for this machine only
const PORT = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("PORT must be 1024-65535");
const NWC = process.argv.includes("--nwc");

const log = makeLogger();
let world: AppWorld & { svc: BookingService };
let reset: () => Promise<void>;
let label: string;

if (NWC) {
  // Only on this explicit path: .env is read and the wallet SDK is loaded.
  loadNwcEnvOrExit("demo:nwc");
  const { nwcBackendFromEnv } = await import("../ln/nwc");
  const { buildNwcWorld, loadNwcSeed, releaseHolds } = await import("../app/nwcWorld");
  const seed = loadNwcSeed();
  const guide = seed.guides[0];
  if (!guide || seed.guides.length !== 1) throw new Error("the NWC seed has exactly one guide (one guide wallet in .env)");
  const backend = await nwcBackendFromEnv(process.env, { traveller: seed.traveller.id, guide: guide.id });
  const nwcWorld = await buildNwcWorld({ backend, seed, log });
  world = nwcWorld;
  reset = async () => {
    throw new Error("no reset over NWC: restart demo:nwc for fresh tour times");
  };
  label = `GuideSats demo over Nostr Wallet Connect (the two TEST wallets in .env, network ${backend.network})`;
  const [travellerSats, guideSats, info] = await Promise.all([backend.payer(seed.traveller.id).getBalance(), backend.receiver(guide.id).getBalance(), backend.receiver(guide.id).getInfo()]);
  log.info("nwc_wallets", { travellerSats, guideSats, blockHeight: info.blockHeight ?? null, network: backend.network });
  // The store is in memory: on Ctrl+C (or when a test runner stops the server) every hold still open is
  // cancelled at the guide's wallet first, so no test sats stay locked behind a booking nobody remembers.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("demo_stopping", { signal });
    const timeout = new Promise((r) => setTimeout(r, 15_000).unref());
    void Promise.race([releaseHolds(nwcWorld.svc, log), timeout])
      .catch(() => undefined)
      .finally(() => {
        backend.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
} else {
  const { buildSimWorld } = await import("../app/world");
  let sim = await buildSimWorld({ log });
  world = sim;
  reset = async () => {
    sim.store.close();
    sim = await buildSimWorld({ log });
    world = sim;
  };
  label = "GuideSats demo (SIMULATED Lightning, seed data)";
}

const watcher = startWatcher({ svc: () => world.svc, log, liveGdacs: process.env.GDACS_LIVE === "1" });
await watcher.tick();

const app = createApp({ world: () => world, reset, allowedHosts: [`${HOST}:${PORT}`, `localhost:${PORT}`] });
if (!existsSync("web/dist/index.html")) throw new Error("web/dist is missing: run `npm run build:web` (npm run demo does it for you)");
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log.info("demo_started", { url: `http://${HOST}:${info.port}`, backend: NWC ? "NWC" : "SIMULATED", network: world.svc.backend.network });
  process.stdout.write(`\n  ${label}: http://${HOST}:${info.port}\n  Ctrl+C to stop.\n\n`);
});
