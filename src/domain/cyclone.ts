// The cyclone rule: cancel (or never lock) a tour when GDACS reports a tropical cyclone
// with an Orange or Red alert whose affected countries include Mauritius, and whose
// time span reaches the tour. Input is GDACS event-list GeoJSON (see fixtures/gdacs).

export interface GdacsFeature {
  type?: string;
  geometry?: { type: string; coordinates: unknown } | null;
  properties: {
    eventtype: string;
    eventid: number;
    episodeid?: number;
    name?: string;
    eventname?: string;
    alertlevel: string;
    country?: string;
    iso3?: string;
    fromdate: string; // UTC, no zone suffix, e.g. "2024-01-12T16:00:00"
    todate: string;
    iscurrent?: string | boolean;
    affectedcountries?: { iso3?: string; countryname?: string }[] | null;
    [k: string]: unknown;
  };
}

export interface GdacsFeed {
  type?: string;
  features: GdacsFeature[];
}

export interface CycloneRuleConfig {
  iso3: string; // "MUS"
  countryName: string; // "Mauritius"
  alertLevels: readonly string[]; // ["Orange", "Red"]
  graceHours: number; // an event counts as active until todate + grace
}

export const MAURITIUS: CycloneRuleConfig = {
  iso3: "MUS",
  countryName: "Mauritius",
  alertLevels: ["Orange", "Red"],
  graceHours: 24,
};

export interface CycloneVerdict {
  cancel: boolean;
  reason: "cyclone_alert" | "no_matching_alert";
  event?: { eventid: number; name: string; alertlevel: string; fromdate: string; todate: string; synthetic?: true }; // synthetic: the demo replay
}

/** GDACS timestamps are UTC without a zone suffix. */
export function parseGdacsDate(s: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`bad GDACS date: ${s}`);
  return t;
}

export function affectsCountry(f: GdacsFeature, cfg: CycloneRuleConfig): boolean {
  const p = f.properties;
  if (p.iso3 === cfg.iso3) return true;
  if ((p.affectedcountries ?? []).some((c) => c.iso3 === cfg.iso3)) return true;
  return (p.country ?? "").split(",").some((c) => c.trim().toLowerCase() === cfg.countryName.toLowerCase());
}

export interface TourWindow {
  now: number;
  tourStart: number;
  tourEnd: number;
}

export function cycloneVerdict(feed: GdacsFeed, w: TourWindow, cfg: CycloneRuleConfig = MAURITIUS): CycloneVerdict {
  for (const f of feed.features ?? []) {
    const p = f.properties;
    if (p.eventtype !== "TC") continue;
    if (!cfg.alertLevels.includes(p.alertlevel)) continue;
    if (!affectsCountry(f, cfg)) continue;
    const grace = cfg.graceHours * 3_600_000;
    const from = parseGdacsDate(p.fromdate);
    const current = p.iscurrent === true || p.iscurrent === "true";
    // A current storm's todate is only its latest update: assume it lasts at least 3 more days.
    const to = Math.max(parseGdacsDate(p.todate) + grace, current ? w.now + 3 * 86_400_000 : 0);
    const stillActive = to >= w.now;
    const reachesTour = from <= w.tourEnd && to >= w.tourStart - grace;
    if (stillActive && reachesTour) {
      return {
        cancel: true,
        reason: "cyclone_alert",
        event: { eventid: p.eventid, name: p.name ?? p.eventname ?? "", alertlevel: p.alertlevel, fromdate: p.fromdate, todate: p.todate, ...(p.synthetic === true ? { synthetic: true as const } : {}) },
      };
    }
  }
  return { cancel: false, reason: "no_matching_alert" };
}
