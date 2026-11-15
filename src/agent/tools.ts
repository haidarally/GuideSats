// The agent's tools. This file is the agent's whole world: it never sees the Lightning
// backend, the store, wallet connection strings or the preimage P, and no tool can
// approve, widen, re-arm or revoke a mandate. The only tool that moves money,
// pay_invoice, goes through payWithinMandate (src/app/payments.ts).
import { cycloneVerdict } from "../domain/cyclone";
import type { BookingService } from "../app/service";

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export const TOOL_NAMES = ["list_tours", "propose_booking", "get_booking", "get_mandate", "check_cyclone", "request_hold_invoice", "pay_invoice"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/** A closure-only facade: the agent gets functions, not the service object. */
export interface AgentFacade {
  listTours(): { id: string; title: string; area: string; priceSats: number; startAt: number }[];
  proposeBooking(tourId: string): { bookingId: string; capSats: number };
  getBooking(id: string): { id: string; state: string; tourId: string; priceSats: number; tourStart: number; hasInvoice: boolean };
  getMandate(bookingId: string): { status: string; capSats: number; payeePubkey: string; notBefore: number; notAfter: number } | null;
  checkCyclone(bookingId: string): { cancel: boolean; event?: string };
  requestHoldInvoice(bookingId: string): Promise<string>;
  payInvoice(bookingId: string, invoice: string): Promise<{ ok: boolean; reason?: string; state?: string }>;
  now(): number;
}

export function agentFacade(svc: BookingService): AgentFacade {
  return {
    listTours: () =>
      svc.tours.map((t) => ({ id: t.id, title: t.title.en, area: svc.guide(t.guideId).area, priceSats: t.priceSats, startAt: t.startAt })),
    proposeBooking: (tourId) => {
      const { booking, mandate } = svc.proposeBooking(tourId);
      return { bookingId: booking.id, capSats: mandate.capSats };
    },
    getBooking: (id) => {
      const b = svc.booking(id);
      return { id: b.id, state: b.state, tourId: b.tourId, priceSats: b.priceSats, tourStart: b.tourStart, hasInvoice: b.invoice !== null };
    },
    getMandate: (bookingId) => {
      const m = svc.mandate(bookingId);
      return m ? { status: m.status, capSats: m.capSats, payeePubkey: m.payeePubkey, notBefore: m.notBefore, notAfter: m.notAfter } : null;
    },
    checkCyclone: (bookingId) => {
      const b = svc.booking(bookingId);
      const v = cycloneVerdict(svc.currentFeed(), { now: svc.now(), tourStart: b.tourStart, tourEnd: b.tourEnd });
      return v.cancel ? { cancel: true, event: `${v.event?.name} (${v.event?.alertlevel})` } : { cancel: false };
    },
    requestHoldInvoice: (bookingId) => svc.requestHoldInvoice(bookingId),
    payInvoice: async (bookingId, invoice) => {
      const r = await svc.payWithinMandate(bookingId, invoice);
      return r.ok ? { ok: true, state: r.state } : { ok: false, reason: r.reason };
    },
    now: () => svc.now(),
  };
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) throw new Error(`argument ${name} must be a non-empty string`);
  return v;
};

/** Executes one tool call with validated arguments. Unknown tools are refused. */
export async function runTool(f: AgentFacade, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "list_tours":
        return { ok: true, data: f.listTours() };
      case "propose_booking":
        return { ok: true, data: f.proposeBooking(str(call.args.tourId, "tourId")) };
      case "get_booking":
        return { ok: true, data: f.getBooking(str(call.args.bookingId, "bookingId")) };
      case "get_mandate":
        return { ok: true, data: f.getMandate(str(call.args.bookingId, "bookingId")) };
      case "check_cyclone":
        return { ok: true, data: f.checkCyclone(str(call.args.bookingId, "bookingId")) };
      case "request_hold_invoice":
        return { ok: true, data: { invoice: await f.requestHoldInvoice(str(call.args.bookingId, "bookingId")) } };
      case "pay_invoice": {
        const r = await f.payInvoice(str(call.args.bookingId, "bookingId"), str(call.args.invoice, "invoice"));
        return r.ok ? { ok: true, data: r } : { ok: false, error: r.reason ?? "refused" };
      }
      default:
        return { ok: false, error: `unknown tool: ${String((call as { tool: unknown }).tool)}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? (e as { code?: string }).code ?? e.message : "error" };
  }
}
