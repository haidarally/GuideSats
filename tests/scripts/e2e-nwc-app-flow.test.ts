// A dry run of `npm run e2e:nwc-app`: both flows through the HTTP API, on the NWC wiring (buildNwcWorld,
// the NWC seed) over the simulator dressed as a real backend. No relay, no wallet, no keys.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { runAppFlows } from "../../scripts/e2e-nwc-app-flow";
import { buildNwcWorld, type NwcWorld } from "../../src/app/nwcWorld";
import { createApp } from "../../src/server/app";
import { makeLogger } from "../../src/log/redact";
import { nonSimBackend } from "../helpers/nonSimBackend";

const HOST = "127.0.0.1:8799";

describe("e2e:nwc-app flows (offline, NWC wiring over the simulator)", () => {
  it("(a) settles and pays the guide; (b) refuses the overspend push, locks, and refunds on the synthetic cyclone replay", async () => {
    const { backend, ledger, pays } = nonSimBackend({ traveller: 10_000, guide_lemorne: 0 });
    const w: NwcWorld = await buildNwcWorld({ backend, config: { acceptTimeoutMs: 2000, pollMs: 20 } });
    const app = createApp({ world: () => w, reset: async () => {}, allowedHosts: [HOST] });
    const call = async (path: string, body?: unknown) => {
      const r = await app.request(`http://${HOST}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { host: HOST, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, json: await r.json() };
    };
    const lines: string[] = [];
    const secrets: string[] = [];
    const r = await runAppFlows({
      call,
      log: makeLogger((l) => lines.push(l)),
      newSecret: () => {
        const s = bytesToHex(randomBytes(32));
        secrets.push(s);
        return s;
      },
      tours: { settle: "tour_lemorne", refund: "tour_lemorne_heritage" },
      pollMs: 10,
      waitMs: 2000,
    });
    expect(r.settle).toMatchObject({ priceSats: 210, finalState: "settled", travellerDeltaSats: -210, guideDeltaSats: 210 });
    expect(r.settle.holdLimit).toMatchObject({ deadlineKind: "height", spareBlocks: 3 });
    expect(r.refund).toMatchObject({ priceSats: 120, finalState: "refunded_cyclone", travellerDeltaSats: 0, guideDeltaSats: 0 });
    expect(r.overspend.map((x) => x.refused)).toEqual(["invoice_wrong_amount", "invoice_wrong_payee", "unknown tool: approve_mandate", "unknown tool: raise_cap"]);
    expect(pays).toHaveLength(2); // the two real locks; the forged invoices never reached the wallet
    expect(ledger.balance("traveller")).toBe(10_000 - 210);
    expect(ledger.allHolds().filter((h) => h.state === "accepted")).toEqual([]);
    const events = lines.map((l) => JSON.parse(l).event as string);
    for (const e of ["e2e_app_start", "a_locked", "a_guide_settled", "audit:hold_limit_ok", "a_done", "b_overspend_refused", "b_locked", "b_cyclone_replay", "audit:refunded_cyclone", "b_done"]) expect(events).toContain(e);
    const all = lines.join("\n");
    for (const s of secrets) expect(all).not.toContain(s);
  });

  it("refuses to start under the minimum traveller balance, before any booking", async () => {
    const { backend, pays } = nonSimBackend({ traveller: 1_999, guide_lemorne: 0 });
    const w = await buildNwcWorld({ backend });
    const app = createApp({ world: () => w, reset: async () => {}, allowedHosts: [HOST] });
    const call = async (path: string, body?: unknown) => {
      const r = await app.request(`http://${HOST}${path}`, { method: body === undefined ? "GET" : "POST", headers: { host: HOST, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    await expect(runAppFlows({ call, log: makeLogger(() => {}), newSecret: () => "11".repeat(32), tours: { settle: "tour_lemorne", refund: "tour_lemorne_heritage" } })).rejects.toThrow("under 2000");
    expect(w.svc.bookings()).toEqual([]);
    expect(pays).toEqual([]);
  });
});
