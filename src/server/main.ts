// `npm run demo`: the SIMULATED world, the API and the PWA on http://127.0.0.1:8787
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { buildSimWorld, type SimWorld } from "../app/world";
import { makeLogger } from "../log/redact";
import { fetchLive } from "../feeds/gdacs";
import { createApp } from "./app";

const HOST = "127.0.0.1"; // never 0.0.0.0: this demo is for this machine only
const PORT = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("PORT must be 1024-65535");

const log = makeLogger();
let world: SimWorld = await buildSimWorld({ log });
const reset = async () => {
  world.store.close();
  world = await buildSimWorld({ log });
};

if (process.env.GDACS_LIVE === "1") {
  // Optional: read the live public GDACS feed once at start (read only, no key).
  try {
    const live = await fetchLive();
    world.svc.setFeed(() => live);
    log.info("gdacs_live_loaded", { events: live.features.length });
  } catch (e) {
    log.warn("gdacs_live_failed", { err: e });
  }
}

const app = createApp({ world: () => world, reset, allowedHosts: [`${HOST}:${PORT}`, `localhost:${PORT}`] });
if (!existsSync("web/dist/index.html")) throw new Error("web/dist is missing: run `npm run build:web` (npm run demo does it for you)");
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log.info("demo_started", { url: `http://${HOST}:${info.port}`, backend: "SIMULATED", network: "regtest" });
  process.stdout.write(`\n  GuideSats demo (SIMULATED Lightning, seed data): http://${HOST}:${info.port}\n  Ctrl+C to stop.\n\n`);
});
