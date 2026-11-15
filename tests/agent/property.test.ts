// Property test: whatever sequence of tool calls the agent makes (legit, forged, replayed,
// cross-booking, garbage, with clock jumps and cyclone flips in between), the SIMULATED
// ledger never shows the traveller paying above a mandate's cap, paying a payee that is
// not in the mandate, paying one mandate twice, or paying an unapproved booking.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld } from "../../src/app/world";
import { agentFacade, runTool } from "../../src/agent/tools";
import { encodeSimInvoice } from "../../src/ln/bolt11";
import { simNodeId } from "../../src/ln/sim";
import { loadFixture, replayShifted } from "../../src/feeds/gdacs";
import type { GdacsFeed } from "../../src/domain/cyclone";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const HOUR = 3_600_000;
const GUIDES = ["guide_lemorne", "guide_chamarel", "guide_lagoon", "stranger"];
const P = ["00".repeat(31) + "01", "00".repeat(31) + "02", "00".repeat(31) + "03"]; // fake test preimages
const H = P.map((p) => bytesToHex(sha256(hexToBytes(p))));

type Cmd =
  | { k: "legit"; b: number }
  | { k: "forged"; b: number; guide: number; amount: number; hash: number; expiry: number; onLedger: boolean; plain: boolean }
  | { k: "replay"; b: number; i: number }
  | { k: "garbage"; b: number; s: string }
  | { k: "advance"; ms: number }
  | { k: "cyclone"; on: boolean }
  | { k: "settle"; b: number }
  | { k: "propose"; tour: number }
  | { k: "reconcile" }
  | { k: "confirm" }
  | { k: "request"; b: number }
  | { k: "swap"; b: number; plain: boolean };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ k: fc.constant("legit" as const), b: fc.integer({ min: 0, max: 3 }) }),
  fc.record({
    k: fc.constant("forged" as const),
    b: fc.integer({ min: 0, max: 3 }),
    guide: fc.integer({ min: 0, max: 3 }),
    amount: fc.oneof(fc.constantFrom(12_000, 15_000, 21_000, 21_001, 36_000), fc.integer({ min: 1, max: 200_000 })),
    hash: fc.integer({ min: 0, max: 3 }), // 3 = a hash nobody approved
    expiry: fc.constantFrom(30, 600, 3600),
    onLedger: fc.boolean(),
    plain: fc.boolean(), // a regular invoice made by the guide's wallet (plan B shape)
  }),
  fc.record({ k: fc.constant("replay" as const), b: fc.integer({ min: 0, max: 3 }), i: fc.nat() }),
  fc.record({ k: fc.constant("garbage" as const), b: fc.integer({ min: 0, max: 3 }), s: fc.string({ maxLength: 40 }) }),
  fc.record({ k: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 14 * HOUR }) }),
  fc.record({ k: fc.constant("cyclone" as const), on: fc.boolean() }),
  fc.record({ k: fc.constant("settle" as const), b: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ k: fc.constant("propose" as const), tour: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ k: fc.constant("reconcile" as const) }),
  fc.record({ k: fc.constant("confirm" as const) }),
  fc.record({ k: fc.constant("request" as const), b: fc.integer({ min: 0, max: 3 }) }),
  // Invoice swap: the RIGHT guide's wallet, the RIGHT amount, but an invoice the app never asked for.
  fc.record({ k: fc.constant("swap" as const), b: fc.integer({ min: 0, max: 3 }), plain: fc.boolean() }),
);

describe("property: no tool-call sequence pays above the cap or outside the payee", () => {
  it("holds for random sequences", async () => {
    let runsWithALock = 0;
    let refusals = 0;
    let plansBPaid = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { maxLength: 30 }), async (cmds) => {
        let now = T0;
        let feed: GdacsFeed = { features: [] };
        const w = await buildSimWorld({ clock: () => now, feed: () => feed, config: { acceptTimeoutMs: 50, pollMs: 5 } });
        const f = agentFacade(w.svc);
        const total0 = w.ledger.totalSats();
        const tours = ["tour_lemorne", "tour_chamarel", "tour_lagoon"];
        // B0, B1: hold mode, approved. B2: hold mode, proposed but never approved.
        // B3: plan B (pay on completion) for the lagoon guide, approved; pays only after "confirm".
        const ids = tours.map((t) => w.svc.proposeBooking(t).booking.id);
        ids.push(w.svc.proposeBooking("tour_lagoon", "on_completion").booking.id);
        w.svc.approveMandate(ids[0]!, { actor: "traveller", paymentHash: H[0]!, at: now });
        w.svc.approveMandate(ids[1]!, { actor: "traveller", paymentHash: H[1]!, at: now });
        w.svc.approveMandate(ids[3]!, { actor: "traveller", paymentHash: null, at: now });
        const seen: string[] = [];
        const rand = () => bytesToHex(sha256(new TextEncoder().encode(`r${seen.length}:${now}`)));

        for (const c of cmds) {
          switch (c.k) {
            case "legit": {
              const r = await runTool(f, { tool: "request_invoice", args: { bookingId: ids[c.b]! } });
              if (r.ok) {
                const inv = (r.data as { invoice: string }).invoice;
                seen.push(inv);
                await runTool(f, { tool: "pay_invoice", args: { bookingId: ids[c.b]!, invoice: inv } });
              }
              break;
            }
            case "forged": {
              const hash = c.hash < 3 ? H[c.hash]! : rand();
              const g = GUIDES[c.guide]!;
              let inv: string;
              if (c.onLedger && g !== "stranger") {
                try {
                  const r = w.backend.receiver(g);
                  inv = c.plain
                    ? (await r.makeInvoice({ amountSats: c.amount, description: "forged", expirySecs: c.expiry })).invoice
                    : (await r.makeHoldInvoice({ amountSats: c.amount, paymentHash: hash, description: "forged", expirySecs: c.expiry })).invoice;
                } catch {
                  break; // that guide already has a hold for this hash
                }
              } else {
                inv = encodeSimInvoice({ network: "regtest", amountSats: c.amount, paymentHash: hash, description: "forged", timestamp: Math.floor(now / 1000), expirySecs: c.expiry, payeeNodeId: simNodeId(g) });
              }
              seen.push(inv);
              await runTool(f, { tool: "pay_invoice", args: { bookingId: ids[c.b]!, invoice: inv } });
              break;
            }
            case "replay":
              if (seen.length > 0) await runTool(f, { tool: "pay_invoice", args: { bookingId: ids[c.b]!, invoice: seen[c.i % seen.length]! } });
              break;
            case "garbage":
              await runTool(f, { tool: "pay_invoice", args: { bookingId: ids[c.b]!, invoice: c.s || "x" } });
              break;
            case "advance":
              now += c.ms;
              break;
            case "cyclone":
              feed = c.on ? replayShifted(loadFixture("tc-2024-01-belal.json"), now - 6 * HOUR) : { features: [] };
              await w.svc.applyCycloneRule();
              break;
            case "settle":
              await w.svc.settleWithPreimage(ids[c.b % 3]!, P[c.b % 3]!).catch(() => undefined);
              break;
            case "propose":
              await runTool(f, { tool: "propose_booking", args: { tourId: tours[c.tour]! } });
              break;
            case "reconcile":
              await w.svc.reconcileHolds();
              break;
            case "request":
              await runTool(f, { tool: "request_invoice", args: { bookingId: ids[c.b]! } });
              break;
            case "swap": {
              const b = w.svc.booking(ids[c.b]!);
              const r = w.backend.receiver(b.guideId);
              try {
                const inv = c.plain
                  ? (await r.makeInvoice({ amountSats: b.priceSats, description: "swap", expirySecs: 600 })).invoice
                  : (await r.makeHoldInvoice({ amountSats: b.priceSats, paymentHash: rand(), description: "swap", expirySecs: 600 })).invoice;
                seen.push(inv);
                await runTool(f, { tool: "pay_invoice", args: { bookingId: b.id, invoice: inv } });
              } catch {
                /* ignore */
              }
              break;
            }
            case "confirm":
              // The traveller confirms the lagoon tour happened (jumping the clock past its start if needed).
              now = Math.max(now, w.svc.booking(ids[3]!).tourStart + HOUR);
              try {
                w.svc.confirmTourHappened(ids[3]!);
              } catch {
                /* too early, or not payable any more */
              }
              break;
          }
        }

        // ---- invariants, read from the ledger itself ----
        // Plan B's hash is whatever the guide's wallet picked when the app asked it (or none).
        const caps: Record<string, { cap: number; payee: string; hash: string | null }> = {
          guide_lemorne: { cap: 21_000, payee: simNodeId("guide_lemorne"), hash: H[0]! },
          guide_chamarel: { cap: 15_000, payee: simNodeId("guide_chamarel"), hash: H[1]! },
          guide_lagoon: { cap: 12_000, payee: simNodeId("guide_lagoon"), hash: w.svc.booking(ids[3]!).paymentHash },
        };
        expect(w.ledger.totalSats()).toBe(total0);
        const fromTraveller = w.ledger.allHolds().filter((h) => h.payer === "traveller" && (h.state === "accepted" || h.state === "settled"));
        const perHash = new Map<string, number>();
        for (const h of fromTraveller) {
          const rule = caps[h.receiver];
          expect(rule, `paid a guide with no approved mandate: ${h.receiver}`).toBeDefined();
          expect(h.paymentHash).toBe(rule!.hash);
          expect(h.amountSats).toBeLessThanOrEqual(rule!.cap);
          perHash.set(h.paymentHash, (perHash.get(h.paymentHash) ?? 0) + 1);
        }
        for (const n of perHash.values()) expect(n).toBe(1);
        if (w.ledger.allHolds().some((h) => h.payer === "traveller")) runsWithALock++;
        refusals += w.svc.audit(1000).filter((a) => a.event === "pay_refused").length;
        expect(w.ledger.balance("guide_lagoon")).toBeLessThanOrEqual(12_000);
        expect(w.ledger.balance("traveller")).toBeGreaterThanOrEqual(120_000 - 21_000 - 15_000 - 12_000);
        if (w.svc.booking(ids[3]!).state === "paid") plansBPaid++;
        // Every hold that ever took the traveller's money (even if later refunded) matched a mandate.
        for (const h of w.ledger.allHolds().filter((x) => x.payer === "traveller")) {
          expect(caps[h.receiver]?.hash).toBe(h.paymentHash);
          expect(h.amountSats).toBeLessThanOrEqual(caps[h.receiver]!.cap);
        }
      }),
      { numRuns: 200 },
    );
    // The property is not vacuous: real locks happened, and many attacks were refused.
    expect(runsWithALock).toBeGreaterThan(20);
    expect(refusals).toBeGreaterThan(100);
    expect(plansBPaid).toBeGreaterThan(0);
  }, 120_000);
});
