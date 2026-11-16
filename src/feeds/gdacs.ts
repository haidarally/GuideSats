// GDACS feed sources: recorded fixtures (default), a time-shifted replay for the demo,
// and an optional live read of the public GDACS event API (no key; off by default).
import { readFileSync } from "node:fs";
import { parseGdacsDate, type GdacsFeature, type GdacsFeed } from "../domain/cyclone";

export const GDACS_LIVE_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC";

export function loadFixture(name: string): GdacsFeed {
  const url = new URL(`../../fixtures/gdacs/${name}`, import.meta.url);
  const feed = JSON.parse(readFileSync(url, "utf8")) as GdacsFeed;
  if (!Array.isArray(feed.features)) throw new Error(`fixture ${name} has no features array`);
  return feed;
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19); // GDACS style: UTC, no suffix

/**
 * SYNTHETIC replay for the demo: the recorded event, moved in time so that it starts
 * at `startAt` (keeping its duration). The name is marked so nobody mistakes it for live data,
 * and each feature carries `synthetic: true` so the demo control can remove exactly what it added.
 */
export function replayShifted(feed: GdacsFeed, startAt: number): GdacsFeed {
  return {
    ...feed,
    features: feed.features.map((f) => {
      const from = parseGdacsDate(f.properties.fromdate);
      const to = parseGdacsDate(f.properties.todate);
      return {
        ...f,
        properties: { ...f.properties, name: `${f.properties.name ?? ""} (SYNTHETIC REPLAY)`, fromdate: fmt(startAt), todate: fmt(startAt + (to - from)), iscurrent: "true", synthetic: true },
      };
    }),
  };
}

/** True for a feature that replayShifted made (never for live or recorded GDACS data). */
export function isSyntheticReplay(f: GdacsFeature): boolean {
  return f.properties.synthetic === true;
}

/** Optional live read (only when the demo is started with GDACS_LIVE=1). */
export async function fetchLive(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<GdacsFeed> {
  const r = await fetchImpl(GDACS_LIVE_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 204) return { type: "FeatureCollection", features: [] };
  if (!r.ok) throw new Error(`GDACS answered ${r.status}`);
  const feed = (await r.json()) as GdacsFeed;
  if (!Array.isArray(feed.features)) throw new Error("GDACS answer has no features array");
  return feed;
}
