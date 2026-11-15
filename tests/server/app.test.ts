import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld, type SimWorld } from "../../src/app/world";
import { createApp } from "../../src/server/app";

const HOST = "127.0.0.1:8787";
const T0 = Date.parse("2026-11-20T02:00:00Z");

async function setup() {
  let w: SimWorld = await buildSimWorld({ clock: () => T0 });
  const app = createApp({ world: () => w, reset: async () => void (w = await buildSimWorld({ clock: () => T0 })), allowedHosts: [HOST] });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://${HOST}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { host: HOST, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, call, w: () => w };
}

const pair = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

describe("HTTP API", () => {
  it("state says SIMULATED and lists the seed tours", async () => {
    const { call } = await setup();
    const s = (await (await call("/api/state")).json()) as { simulated: boolean; network: string; tours: unknown[] };
    expect(s.simulated).toBe(true);
    expect(s.network).toBe("regtest");
    expect(s.tours).toHaveLength(3);
  });

  it("full flow: propose, approve with H, agent locks, guide settles with P", async () => {
    const { call, w } = await setup();
    const { bookingId } = (await (await call("/api/traveller/bookings", { tourId: "tour_lemorne" })).json()) as { bookingId: string };
    const { p, h } = pair();
    expect((await call(`/api/traveller/bookings/${bookingId}/approve`, { paymentHash: h })).status).toBe(200);
    const run = (await (await call("/api/agent/run", { bookingId })).json()) as { outcome: string };
    expect(run.outcome).toBe("locked");
    expect((await call(`/api/guide/bookings/${bookingId}/settle`, { preimage: "11".repeat(32) })).status).toBe(409);
    const ok = await call(`/api/guide/bookings/${bookingId}/settle`, { preimage: p });
    expect(await ok.json()).toEqual({ ok: true, state: "settled" });
    expect(w().ledger.balance("guide_lemorne")).toBe(21_000);
  });

  it("cyclone demo control refunds a locked booking", async () => {
    const { call, w } = await setup();
    const { bookingId } = (await (await call("/api/traveller/bookings", { tourId: "tour_lagoon" })).json()) as { bookingId: string };
    await call(`/api/traveller/bookings/${bookingId}/approve`, { paymentHash: pair().h });
    await call("/api/agent/run", { bookingId });
    expect(w().ledger.balance("traveller")).toBe(108_000);
    const r = (await (await call("/api/demo/cyclone", { on: true })).json()) as { affected: string[] };
    expect(r.affected).toEqual([bookingId]);
    expect(w().ledger.balance("traveller")).toBe(120_000);
  });

  it("the agent can propose by text but cannot approve", async () => {
    const { call } = await setup();
    const r = (await (await call("/api/agent/run", { text: "boat in the lagoon" })).json()) as { outcome: string };
    expect(r.outcome).toBe("proposed_waiting_for_traveller_approval");
    const s = (await (await call("/api/state")).json()) as { bookings: { state: string; mandate: { status: string } }[] };
    expect(s.bookings[0]).toMatchObject({ state: "proposed", mandate: { status: "pending_approval" } });
  });

  it("rejects foreign hosts, foreign origins, non-JSON, bad input and big bodies", async () => {
    const { call } = await setup();
    expect((await call("/api/state", undefined, { host: "evil.example:8787" })).status).toBe(403);
    expect((await call("/api/traveller/bookings", { tourId: "tour_lemorne" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await call("/api/traveller/bookings", "tourId=x", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await call("/api/traveller/bookings", { tourId: "../../etc" })).status).toBe(400);
    expect((await call("/api/traveller/bookings/bk_1/approve", { paymentHash: "zz" })).status).toBe(400);
    expect((await call("/api/traveller/bookings", "{not json")).status).toBe(400);
    expect((await call("/api/agent/run", { text: "x".repeat(20_000) })).status).toBe(413);
    expect((await call("/api/traveller/bookings", { tourId: "tour_nope" })).status).toBe(409);
  });

  it("sends security headers", async () => {
    const { call } = await setup();
    const r = await call("/api/state");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("plan B over HTTP: book after, approve without a hash, confirm, agent pays", async () => {
    let now = T0;
    let w: SimWorld = await buildSimWorld({ clock: () => now });
    const app = createApp({ world: () => w, reset: async () => void (w = await buildSimWorld({ clock: () => now })), allowedHosts: [HOST] });
    const post = (path: string, body: unknown) => app.request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: JSON.stringify(body) });
    const { bookingId } = (await (await post("/api/traveller/bookings", { tourId: "tour_lagoon", mode: "on_completion" })).json()) as { bookingId: string };
    expect((await post(`/api/traveller/bookings/${bookingId}/approve`, { paymentHash: "ab".repeat(32) })).status).toBe(400);
    expect((await post(`/api/traveller/bookings/${bookingId}/approve`, {})).status).toBe(200);
    expect((await post(`/api/traveller/bookings/${bookingId}/confirm`, {})).status).toBe(409); // tour not started
    now += 9 * 3_600_000;
    expect((await post(`/api/traveller/bookings/${bookingId}/confirm`, {})).status).toBe(200);
    const run = (await (await post("/api/agent/run", { bookingId })).json()) as { outcome: string };
    expect(run.outcome).toBe("paid");
    expect(w.ledger.balance("guide_lagoon")).toBe(12_000);
    expect((await post("/api/traveller/bookings", { tourId: "tour_lagoon", mode: "free" })).status).toBe(400);
  });
});
