// Wires a complete SIMULATED world from the seed file: sim ledger, store, service.
// Used by `npm run demo`, `npm run e2e:sim` and the tests. The NWC world (`npm run demo:nwc`) is in nwcWorld.ts.
import { readFileSync } from "node:fs";
import type { GdacsFeed } from "../domain/cyclone";
import { lockLeadMs } from "../domain/holdLimit";
import { SimBackend, SimLedger, type SimOptions } from "../ln/sim";
import { makeLogger, type Logger } from "../log/redact";
import { Store } from "../store/db";
import { BookingService, type Guide, type ServiceConfig, type Tour } from "./service";

export interface Seed {
  traveller: { id: string; walletSats: number; label: string };
  guides: { id: string; displayName: string; area: string; languages: string[]; walletSats: number }[];
  tours: { id: string; guideId: string; title: { en: string; fr: string }; meetingPoint: { en: string; fr: string }; priceSats: number; startInHours: number; durationHours: number }[];
}

export function loadSeed(): Seed {
  return JSON.parse(readFileSync(new URL("../../fixtures/seed.json", import.meta.url), "utf8")) as Seed;
}

/** The seed's tours, each starting `startInHours` after t0 (rounded down to the minute). Shared with the NWC world. */
export function toursFromSeed(seed: Seed, t0: number): Tour[] {
  return seed.tours.map((t) => ({
    id: t.id,
    guideId: t.guideId,
    title: t.title,
    meetingPoint: t.meetingPoint,
    priceSats: t.priceSats,
    startAt: Math.floor((t0 + t.startInHours * 3_600_000) / 60_000) * 60_000,
    durationHours: t.durationHours,
  }));
}

export interface SimWorldOptions {
  clock?: () => number;
  seed?: Seed;
  feed?: () => GdacsFeed;
  log?: Logger;
  dbPath?: string;
  /** How the simulated guide wallets limit holds (default: a 24-block settle_deadline, as measured). */
  hold?: Pick<SimOptions, "holdLimitBlocks" | "deadlineKind" | "holdMaxSecs">;
  config?: Partial<ServiceConfig>;
}

export async function buildSimWorld(opts: SimWorldOptions = {}) {
  let offset = 0;
  const base = opts.clock ?? Date.now;
  const clock = () => base() + offset;
  const seed = opts.seed ?? loadSeed();
  const balances: Record<string, number> = { [seed.traveller.id]: seed.traveller.walletSats };
  for (const g of seed.guides) balances[g.id] = g.walletSats;
  const ledger = new SimLedger({ clock, balances, ...opts.hold });
  const backend = new SimBackend(ledger);
  const guides: Guide[] = [];
  for (const g of seed.guides) {
    guides.push({ id: g.id, displayName: g.displayName, area: g.area, languages: g.languages, payeePubkey: (await backend.receiver(g.id).getInfo()).pubkey });
  }
  const tours = toursFromSeed(seed, clock());
  const store = new Store(opts.dbPath ?? ":memory:");
  const log = opts.log ?? makeLogger(() => {});
  const svc = new BookingService(store, backend, clock, opts.feed ?? (() => ({ type: "FeatureCollection", features: [] })), log, tours, guides, {
    travellerWalletId: seed.traveller.id,
    // The app does not know a wallet's hold limit in advance: the window comes from the measured one
    // (50 min before the tour), and each accepted hold is checked against the deadline its wallet reports.
    lockLeadHours: lockLeadMs() / 3_600_000,
    invoiceExpirySecs: 600,
    acceptTimeoutMs: 2000,
    pollMs: 20,
    ...opts.config,
  });
  return {
    svc,
    ledger,
    backend,
    store,
    seed,
    clock,
    /** Move the simulated clock forward (the demo's "skip ahead" button, and the tests). */
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

export type SimWorld = Awaited<ReturnType<typeof buildSimWorld>>;
