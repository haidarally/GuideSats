import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSimWorld } from "../../src/app/world";
import { agentFacade, runTool, TOOL_NAMES } from "../../src/agent/tools";
import { runAgent } from "../../src/agent/planner";
import { encodeSimInvoice } from "../../src/ln/bolt11";
import { simNodeId } from "../../src/ln/sim";

const T0 = Date.parse("2026-11-20T02:00:00Z");
const H = "ab".repeat(32);

describe("agent tools: structure", () => {
  it("no tool can approve, raise, re-arm or revoke a mandate", () => {
    for (const name of TOOL_NAMES) expect(name).not.toMatch(/approve|raise|increase|cap|set_|update|revoke|rearm|release|settle|cancel|preimage/i);
  });
  it("the facade exposes no approval or wallet handle", async () => {
    const w = await buildSimWorld({ clock: () => T0 });
    const f = agentFacade(w.svc) as unknown as Record<string, unknown>;
    expect(Object.keys(f).sort()).toEqual(["checkCyclone", "getBooking", "getMandate", "listTours", "now", "payInvoice", "proposeBooking", "requestInvoice"]);
    for (const v of Object.values(f)) expect(typeof v).toBe("function");
  });
  it("tools.ts and planner.ts never import the approval function, the backend or the store", () => {
    for (const file of ["tools.ts", "planner.ts"]) {
      const src = readFileSync(new URL(`../../src/agent/${file}`, import.meta.url), "utf8");
      const imports = src.split("\n").filter((l) => l.startsWith("import"));
      expect(imports.join("\n")).not.toMatch(/approveMandate|domain\/mandate|\/ln\/|store\/|nwc/);
    }
  });
  it("unknown tools are refused", async () => {
    const w = await buildSimWorld({ clock: () => T0 });
    expect(await runTool(agentFacade(w.svc), { tool: "approve_mandate" as never, args: {} })).toEqual({ ok: false, error: "unknown tool: approve_mandate" });
  });
});

describe("rule-based planner", () => {
  it("books by text, then waits for the traveller", async () => {
    const w = await buildSimWorld({ clock: () => T0 });
    const r = await runAgent(agentFacade(w.svc), { kind: "book", text: "a sunrise hike at Le Morne please" });
    expect(r.outcome).toBe("proposed_waiting_for_traveller_approval");
    expect(r.steps.map((s) => s.call.tool)).toEqual(["list_tours", "propose_booking"]);
    expect(w.svc.bookings()[0]?.tourId).toBe("tour_lemorne");
    expect(w.svc.bookings()[0]?.state).toBe("proposed");
  });
  it("French text works too", async () => {
    const w = await buildSimWorld({ clock: () => T0 });
    const r = await runAgent(agentFacade(w.svc), { kind: "book", text: "Je veux voir la cascade de Chamarel" });
    expect(r.outcome).toBe("proposed_waiting_for_traveller_approval");
    expect(w.svc.bookings()[0]?.tourId).toBe("tour_chamarel");
  });
  it("locks funds once the traveller approved", async () => {
    const w = await buildSimWorld({ clock: () => T0 });
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    expect((await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id })).outcome).toBe("waiting_for_traveller_approval");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: H, at: T0 });
    const r = await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id });
    expect(r.outcome).toBe("locked");
    expect(r.steps.map((s) => s.call.tool)).toEqual(["get_booking", "check_cyclone", "get_mandate", "request_invoice", "pay_invoice"]);
    expect(w.ledger.balance("traveller")).toBe(99_000);
  });
  it("an over-mandate invoice is refused even if the agent is told to pay it", async () => {
    const w = await buildSimWorld({ clock: () => T0 });
    const { booking } = w.svc.proposeBooking("tour_lemorne");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: H, at: T0 });
    const f = agentFacade(w.svc);
    const greedy = encodeSimInvoice({ network: "regtest", amountSats: 99_000, paymentHash: H, description: "more", timestamp: T0 / 1000, expirySecs: 600, payeeNodeId: simNodeId("guide_lemorne") });
    expect(await runTool(f, { tool: "pay_invoice", args: { bookingId: booking.id, invoice: greedy } })).toEqual({ ok: false, error: "invoice_wrong_amount" });
    const stranger = encodeSimInvoice({ network: "regtest", amountSats: 21_000, paymentHash: H, description: "x", timestamp: T0 / 1000, expirySecs: 600, payeeNodeId: simNodeId("guide_lagoon") });
    expect(await runTool(f, { tool: "pay_invoice", args: { bookingId: booking.id, invoice: stranger } })).toEqual({ ok: false, error: "invoice_wrong_payee" });
    expect(w.ledger.balance("traveller")).toBe(120_000);
  });

  it("plan B: waits for the traveller's confirmation, then pays", async () => {
    let now = T0;
    const w = await buildSimWorld({ clock: () => now });
    const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
    w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: T0 });
    expect((await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id })).outcome).toBe("waiting_for_traveller_to_confirm_the_tour");
    now += 9 * 3_600_000;
    w.svc.confirmTourHappened(booking.id);
    const r = await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id });
    expect(r.outcome).toBe("paid");
    expect(w.ledger.balance("guide_lagoon")).toBe(12_000);
  });
});
