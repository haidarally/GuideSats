// The watcher, the same for both backends: every 30 s it applies the cyclone rule (cancel locked holds =
// refund), then the reconcile step (src/app/reconcile.ts) resolves every unresolved payment from the
// guide's wallet. Optionally it reads the live public GDACS feed (read only, no key) every 15 minutes.
import type { BookingService } from "../app/service";
import { fetchLive } from "../feeds/gdacs";
import type { Logger } from "../log/redact";

export interface WatcherOptions {
  svc: () => BookingService; // the current world's service (the simulator's reset swaps it)
  log: Logger;
  liveGdacs?: boolean;
  intervalMs?: number;
}

export function startWatcher(o: WatcherOptions): { tick: () => Promise<void>; stop: () => void } {
  let lastFetch = 0;
  async function refreshLive() {
    if (!o.liveGdacs || Date.now() - lastFetch < 15 * 60_000) return;
    lastFetch = Date.now();
    try {
      const live = await fetchLive();
      o.svc().setFeed(() => live);
      o.log.info("gdacs_live_loaded", { events: live.features.length });
    } catch (e) {
      o.log.warn("gdacs_live_failed", { err: e });
    }
  }
  let running = false;
  async function tick() {
    if (running) return; // a slow wallet must not stack ticks
    running = true;
    try {
      await step();
    } finally {
      running = false;
    }
  }
  async function step() {
    await refreshLive();
    try {
      await o.svc().applyCycloneRule();
    } catch (e) {
      o.log.warn("cyclone_rule_failed", { err: e });
    }
    try {
      await o.svc().reconcile();
    } catch (e) {
      o.log.warn("reconcile_failed", { err: e });
    }
  }
  const timer = setInterval(() => void tick(), o.intervalMs ?? 30_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
