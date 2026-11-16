// The app in NWC mode (`npm run demo:nwc`), offline: the NWC wiring over the simulator dressed as a real
// backend. Controls that fake time or the chain are refused; the synthetic cyclone replay stays.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildNwcWorld, loadNwcSeed, NWC_SEED_MAX_SATS, releaseHolds } from "../../src/app/nwcWorld";
import { buildSimWorld } from "../../src/app/world";
import { lockLeadMs } from "../../src/domain/holdLimit";
import { createApp } from "../../src/server/app";
import { makeLogger } from "../../src/log/redact";
import { nonSimBackend } from "../helpers/nonSimBackend";

const HOST = "127.0.0.1:8787";

async function setup() {
  const nb = nonSimBackend({ traveller: 10_000, guide_lemorne: 0 });
  const w = await buildNwcWorld({ backend: nb.backend, config: { acceptTimeoutMs: 2000, pollMs: 20 } });
  const app = createApp({ world: () => w, reset: async () => {}, allowedHosts: [HOST] });
  const call = (path: string, body?: unknown) =>
    app.request(`http://${HOST}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { host: HOST, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...nb, w, call };
}

const lockOne = async (call: (p: string, b?: unknown) => Response | Promise<Response>, tourId: string) => {
  const { bookingId } = (await (await call("/api/traveller/bookings", { tourId })).json()) as { bookingId: string };
  const h = bytesToHex(sha256(hexToBytes(bytesToHex(randomBytes(32)))));
  await call(`/api/traveller/bookings/${bookingId}/approve`, { paymentHash: h });
  const run = (await (await call("/api/agent/run", { bookingId })).json()) as { outcome: string };
  return { bookingId, outcome: run.outcome };
};

describe("NWC mode", () => {
  it("state says not simulated, lists the controls, the block height and the small NWC tours inside the lock window", async () => {
    const { call, w } = await setup();
    const s = (await (await call("/api/state")).json()) as {
      simulated: boolean;
      backend: string;
      blockHeight: number | null;
      controls: Record<string, boolean>;
      traveller: { balanceSats: number };
      tours: { priceSats: number; startAt: number }[];
      guides: unknown[];
    };
    expect(s.simulated).toBe(false);
    expect(s.backend).toBe("nwc");
    expect(typeof s.blockHeight).toBe("number");
    expect(s.controls).toEqual({ cyclone: true, attack: true, expireInvoice: false, advance: false, reset: false });
    expect(s.traveller.balanceSats).toBe(10_000);
    expect(s.guides).toHaveLength(1);
    const now = w.clock();
    for (const t of s.tours) {
      expect(t.startAt - lockLeadMs()).toBeLessThanOrEqual(now);
      expect(t.startAt).toBeGreaterThan(now);
    }
    expect(s.tours.reduce((a, t) => a + t.priceSats, 0)).toBeLessThanOrEqual(NWC_SEED_MAX_SATS);
  });

  it("refuses every control that fakes time or the chain, and reset", async () => {
    const { call, w } = await setup();
    const { bookingId } = (await (await call("/api/traveller/bookings", { tourId: "tour_lemorne" })).json()) as { bookingId: string };
    await call(`/api/traveller/bookings/${bookingId}/approve`, { paymentHash: "ab".repeat(32) });
    for (const [path, body] of [["/api/demo/advance", { hours: 13 }], ["/api/demo/expire-invoice", {}]] as const) {
      const r = await call(path, body);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "this demo control fakes time: SIMULATED backend only" });
    }
    expect((await call("/api/demo/reset", {})).status).toBe(403);
    expect(w.svc.booking(bookingId)).toMatchObject({ state: "mandated", invoice: null }); // no invoice was asked for
  });

  it("the synthetic cyclone replay refunds a locked booking over the real-backend wiring", async () => {
    const { call, ledger } = await setup();
    const { bookingId, outcome } = await lockOne(call, "tour_lemorne_heritage");
    expect(outcome).toBe("locked");
    expect(ledger.balance("traveller")).toBe(10_000 - 21);
    const r = (await (await call("/api/demo/cyclone", { on: true })).json()) as { affected: string[] };
    expect(r.affected).toEqual([bookingId]);
    const s = (await (await call("/api/state")).json()) as { cyclone: { event?: { name: string } }; bookings: { state: string }[] };
    expect(s.cyclone.event?.name).toContain("SYNTHETIC REPLAY");
    expect(s.bookings[0]!.state).toBe("refunded_cyclone");
    expect(ledger.balance("traveller")).toBe(10_000);
  });

  it("releaseHolds (on stop) cancels a locked hold and an open hold invoice at the guide's wallet", async () => {
    const { call, ledger, w } = await setup();
    const locked = await lockOne(call, "tour_lemorne");
    expect(locked.outcome).toBe("locked");
    const { bookingId } = (await (await call("/api/traveller/bookings", { tourId: "tour_lemorne_heritage" })).json()) as { bookingId: string };
    await call(`/api/traveller/bookings/${bookingId}/approve`, { paymentHash: "cd".repeat(32) });
    await w.svc.requestInvoice(bookingId); // asked for, not paid
    const released = await releaseHolds(w.svc, makeLogger(() => {}));
    expect(released).toEqual([
      { bookingId: locked.bookingId, cancelled: true },
      { bookingId, cancelled: true },
    ]);
    expect(ledger.balance("traveller")).toBe(10_000);
    expect(ledger.allHolds().map((h) => h.state)).toEqual(["cancelled", "cancelled"]);
  });

  it("buildNwcWorld refuses the simulator, a seed over the sats limit, and a tour outside the lock window", async () => {
    const sim = await buildSimWorld();
    await expect(buildNwcWorld({ backend: sim.backend })).rejects.toThrow("real backend");
    const seed = loadNwcSeed();
    const { backend } = nonSimBackend({ traveller: 10_000, guide_lemorne: 0 });
    await expect(buildNwcWorld({ backend, seed: { ...seed, tours: seed.tours.map((t) => ({ ...t, priceSats: 600 })) } })).rejects.toThrow("the limit is 1000");
    await expect(buildNwcWorld({ backend, seed: { ...seed, tours: seed.tours.map((t) => ({ ...t, startInHours: 2 })) } })).rejects.toThrow("lock window");
  });
});
