import { describe, it, expect } from "vitest";
import { fetchLive, isSyntheticReplay, loadFixture, replayShifted, GDACS_LIVE_URL } from "../../src/feeds/gdacs";
import { cycloneVerdict, parseGdacsDate } from "../../src/domain/cyclone";

const fakeFetch = (status: number, body: unknown) =>
  (async (url: string) => {
    expect(url).toBe(GDACS_LIVE_URL);
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe("GDACS feed sources", () => {
  it("loads a recorded fixture", () => {
    expect(loadFixture("tc-2024-01-belal.json").features[0]?.properties.name).toContain("BELAL");
  });
  it("replayShifted keeps the duration, marks the name SYNTHETIC and makes it current", () => {
    const f = loadFixture("tc-2024-01-belal.json");
    const at = Date.parse("2026-11-20T00:00:00Z");
    const r = replayShifted(f, at).features[0]!.properties;
    const o = f.features[0]!.properties;
    expect(parseGdacsDate(r.fromdate)).toBe(at);
    expect(parseGdacsDate(r.todate) - parseGdacsDate(r.fromdate)).toBe(parseGdacsDate(o.todate) - parseGdacsDate(o.fromdate));
    expect(r.name).toContain("SYNTHETIC REPLAY");
    expect(isSyntheticReplay(replayShifted(f, at).features[0]!)).toBe(true);
    expect(isSyntheticReplay(f.features[0]!)).toBe(false); // the recorded (or a live) event is never marked
    expect(cycloneVerdict(replayShifted(f, at), { now: at + 3_600_000, tourStart: at + 86_400_000, tourEnd: at + 90_000_000 }).cancel).toBe(true);
  });
  it("fetchLive: 204 means no events", async () => {
    expect(await fetchLive(fakeFetch(204, null))).toEqual({ type: "FeatureCollection", features: [] });
  });
  it("fetchLive: a non-OK answer or a body without features is an error", async () => {
    await expect(fetchLive(fakeFetch(503, {}))).rejects.toThrow("503");
    await expect(fetchLive(fakeFetch(200, { hello: 1 }))).rejects.toThrow("no features");
  });
  it("fetchLive: a valid body passes through", async () => {
    const body = loadFixture("tc-2024-01-belal.json");
    expect((await fetchLive(fakeFetch(200, body))).features).toHaveLength(body.features.length);
  });
});
