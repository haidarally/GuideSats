import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cycloneVerdict, parseGdacsDate, type GdacsFeed } from "../../src/domain/cyclone";

const load = (f: string): GdacsFeed => JSON.parse(readFileSync(new URL(`../../fixtures/gdacs/${f}`, import.meta.url), "utf8"));
const belal = load("tc-2024-01-belal.json");
const freddy = load("tc-2023-02-freddy.json");
const garance = load("tc-2025-02-garance-honde.json");
const gamane = load("tc-2024-03-gamane-filipo.json");
const H = 3_600_000;

// A tour in Mauritius on 15 Jan 2024, 09:00-13:00 MU (05:00-09:00 UTC), checked on 14 Jan.
const duringBelal = { now: Date.parse("2024-01-14T06:00:00Z"), tourStart: Date.parse("2024-01-15T05:00:00Z"), tourEnd: Date.parse("2024-01-15T09:00:00Z") };

describe("cyclone rule on recorded GDACS fixtures", () => {
  it("parses GDACS UTC dates without a zone suffix", () => {
    expect(parseGdacsDate("2024-01-12T16:00:00")).toBe(Date.parse("2024-01-12T16:00:00Z"));
  });
  it("BELAL-24 (Orange, Mauritius affected) cancels a tour during the storm", () => {
    const v = cycloneVerdict(belal, duringBelal);
    expect(v.cancel).toBe(true);
    expect(v.event?.name).toContain("BELAL");
    expect(v.event?.alertlevel).toBe("Orange");
  });
  it("BELAL-24 does not cancel a tour three weeks after it ended", () => {
    const later = { now: Date.parse("2024-02-08T06:00:00Z"), tourStart: Date.parse("2024-02-09T05:00:00Z"), tourEnd: Date.parse("2024-02-09T09:00:00Z") };
    expect(cycloneVerdict(belal, later).cancel).toBe(false);
  });
  it("BELAL-24 does not cancel a tour booked well before it formed", () => {
    const before = { now: Date.parse("2024-01-01T06:00:00Z"), tourStart: Date.parse("2024-01-02T05:00:00Z"), tourEnd: Date.parse("2024-01-02T09:00:00Z") };
    expect(cycloneVerdict(belal, before).cancel).toBe(false);
  });
  it("FREDDY-23 (Red, Mozambique and Madagascar) does not cancel a Mauritius tour", () => {
    const w = { now: Date.parse("2023-02-20T06:00:00Z"), tourStart: Date.parse("2023-02-21T05:00:00Z"), tourEnd: Date.parse("2023-02-21T09:00:00Z") };
    expect(cycloneVerdict(freddy, w).cancel).toBe(false);
  });
  it("GARANCE-25 (Red, Reunion only in GDACS) and HONDE-25 (Orange, Madagascar) do not cancel", () => {
    const w = { now: Date.parse("2025-02-27T06:00:00Z"), tourStart: Date.parse("2025-02-28T05:00:00Z"), tourEnd: Date.parse("2025-02-28T09:00:00Z") };
    expect(cycloneVerdict(garance, w).cancel).toBe(false);
  });
  it("GAMANE-24 and FILIPO-24 (Orange, elsewhere) do not cancel", () => {
    const w = { now: Date.parse("2024-03-26T06:00:00Z"), tourStart: Date.parse("2024-03-27T05:00:00Z"), tourEnd: Date.parse("2024-03-27T09:00:00Z") };
    expect(cycloneVerdict(gamane, w).cancel).toBe(false);
  });
  it("an empty feed does not cancel", () => {
    expect(cycloneVerdict({ features: [] }, duringBelal)).toEqual({ cancel: false, reason: "no_matching_alert" });
  });
});

describe("cyclone rule on SYNTHETIC variants of the BELAL record", () => {
  const variant = (over: Record<string, unknown>): GdacsFeed => ({
    ...belal,
    features: belal.features.map((f) => ({ ...f, properties: { ...f.properties, ...over } })),
  });
  it("SYNTHETIC: a Green alert does not cancel", () => {
    expect(cycloneVerdict(variant({ alertlevel: "Green" }), duringBelal).cancel).toBe(false);
  });
  it("SYNTHETIC: a non-cyclone event (earthquake) does not cancel", () => {
    expect(cycloneVerdict(variant({ eventtype: "EQ" }), duringBelal).cancel).toBe(false);
  });
  it("SYNTHETIC: a Red alert cancels", () => {
    expect(cycloneVerdict(variant({ alertlevel: "Red" }), duringBelal).cancel).toBe(true);
  });
  it("SYNTHETIC: a still-current storm counts as active for 3 more days", () => {
    const now = Date.parse("2024-01-25T06:00:00Z");
    const w = { now, tourStart: now + 24 * H, tourEnd: now + 28 * H };
    expect(cycloneVerdict(variant({ iscurrent: "true" }), w).cancel).toBe(true);
    expect(cycloneVerdict(variant({ iscurrent: "false" }), w).cancel).toBe(false);
  });
  it("SYNTHETIC: matching by country name when the iso3 list is missing", () => {
    expect(cycloneVerdict(variant({ affectedcountries: null, iso3: "REU" }), duringBelal).cancel).toBe(true);
    expect(cycloneVerdict(variant({ affectedcountries: null, iso3: "REU", country: "Reunion" }), duringBelal).cancel).toBe(false);
  });
});
