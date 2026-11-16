// Wires the world for `npm run demo:nwc` and `npm run e2e:nwc-app`: the same booking service, reconcile step,
// hold-limit check and watcher as the SIMULATED world; only the wiring differs. The wallets are a real
// (non-simulated) backend: in practice NwcBackend on two NWC test wallets, one traveller and one guide.
// The clock is the real one and the block height is the one the guide's wallet reports (get_info).
// There is no clock control: nothing here can fake time or the chain.
import { readFileSync } from "node:fs";
import type { GdacsFeed } from "../domain/cyclone";
import { lockLeadMs } from "../domain/holdLimit";
import type { LightningBackend } from "../ln/backend";
import { assertHoldSupport } from "../ln/nwc";
import { makeLogger, type Logger } from "../log/redact";
import { Store } from "../store/db";
import { BookingService, type Guide, type ServiceConfig } from "./service";
import { toursFromSeed, type Seed } from "./world";

/** All seed tours together may cost at most this much: every NWC run stays small. */
export const NWC_SEED_MAX_SATS = 1000;

export function loadNwcSeed(): Seed {
  return JSON.parse(readFileSync(new URL("../../fixtures/seed-nwc.json", import.meta.url), "utf8")) as Seed;
}

export interface NwcWorldOptions {
  backend: LightningBackend;
  seed?: Seed;
  clock?: () => number;
  feed?: () => GdacsFeed;
  log?: Logger;
  config?: Partial<ServiceConfig>;
}

export async function buildNwcWorld(o: NwcWorldOptions) {
  if (o.backend.simulated) throw new Error("buildNwcWorld takes a real backend; the SIMULATED one is wired by buildSimWorld");
  const clock = o.clock ?? Date.now;
  const seed = o.seed ?? loadNwcSeed();
  const total = seed.tours.reduce((s, t) => s + t.priceSats, 0);
  if (total > NWC_SEED_MAX_SATS) throw new Error(`the NWC seed tours cost ${total} sats together; the limit is ${NWC_SEED_MAX_SATS}`);
  const guides: Guide[] = [];
  for (const g of seed.guides) {
    // Also checks the wallet's network against NWC_NETWORK (NwcBackend) and that it can make hold invoices.
    const info = await o.backend.receiver(g.id).getInfo();
    assertHoldSupport(info);
    guides.push({ id: g.id, displayName: g.displayName, area: g.area, languages: g.languages, payeePubkey: info.pubkey });
  }
  const now = clock();
  const lead = lockLeadMs();
  const tours = toursFromSeed(seed, now);
  // With the real clock the agent may lock only from 50 min before a tour: every seed tour must already be inside.
  for (const t of tours) if (t.startAt - lead > now || t.startAt <= now) throw new Error(`seed tour ${t.id} does not start inside the lock window`);
  const store = new Store(":memory:");
  const log = o.log ?? makeLogger(() => {});
  const svc = new BookingService(store, o.backend, clock, o.feed ?? (() => ({ type: "FeatureCollection", features: [] })), log, tours, guides, {
    travellerWalletId: seed.traveller.id,
    lockLeadHours: lead / 3_600_000,
    invoiceExpirySecs: 600,
    // A wallet call takes about 0.35 s over NWC: wait up to 20 s for the hold to be accepted, polling every 0.5 s.
    acceptTimeoutMs: 20_000,
    pollMs: 500,
    ...o.config,
  });
  return { svc, store, backend: o.backend, seed, clock };
}

export type NwcWorld = Awaited<ReturnType<typeof buildNwcWorld>>;

/**
 * Before the server stops (or after a failed run): the store is in memory and forgets, so every hold this
 * server may still have open at the guide's wallet is cancelled there. An accepted hold refunds the traveller;
 * an open hold invoice can then no longer be paid. One failing call never stops the others.
 */
export async function releaseHolds(svc: BookingService, log: Logger): Promise<{ bookingId: string; cancelled: boolean }[]> {
  const out: { bookingId: string; cancelled: boolean }[] = [];
  for (const b of svc.bookings()) {
    if (b.mode !== "hold") continue;
    const m = svc.mandate(b.id);
    const hash = b.state === "locked" ? b.paymentHash : m?.status === "consuming" || (b.state === "mandated" && b.invoice) ? m?.paymentHash : null;
    if (!hash) continue;
    try {
      await svc.backend.receiver(b.guideId).cancelHoldInvoice(hash);
      out.push({ bookingId: b.id, cancelled: true });
      log.info("hold_released_on_stop", { bookingId: b.id, state: b.state, paymentHash: hash });
    } catch (e) {
      out.push({ bookingId: b.id, cancelled: false });
      log.warn("hold_release_failed", { bookingId: b.id, err: e });
    }
  }
  return out;
}
