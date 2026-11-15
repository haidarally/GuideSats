// Rule-based planner (the default; no LLM, no API key). It decides the next tool call
// from what it has seen so far. An LLM planner could implement the same `Planner`
// interface later; it would get the same tools and nothing more, so the money path
// never depends on a model.
import { runTool, type AgentFacade, type ToolCall, type ToolResult } from "./tools";

export type Goal = { kind: "book"; text: string } | { kind: "lock"; bookingId: string };

export interface Step {
  call: ToolCall;
  result: ToolResult;
}

export interface Planner {
  next(goal: Goal, steps: Step[], now: number): ToolCall | { done: string };
}

const lastData = <T>(steps: Step[], tool: ToolCall["tool"]): T | null => {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.call.tool === tool) return s.result.ok ? (s.result.data as T) : null;
  }
  return null;
};
const lastResult = (steps: Step[], tool: ToolCall["tool"]) => [...steps].reverse().find((s) => s.call.tool === tool)?.result ?? null;

function matchTour(text: string, tours: { id: string; title: string; area: string }[]): string | null {
  const words = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let best: { id: string; score: number } | null = null;
  for (const t of tours) {
    const hay = `${t.title} ${t.area}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: t.id, score };
  }
  return best?.id ?? null;
}

export class RuleBasedPlanner implements Planner {
  next(goal: Goal, steps: Step[], now: number): ToolCall | { done: string } {
    if (goal.kind === "book") {
      const tours = lastData<{ id: string; title: string; area: string }[]>(steps, "list_tours");
      if (!tours) return { tool: "list_tours", args: {} };
      const proposed = lastResult(steps, "propose_booking");
      if (!proposed) {
        const id = matchTour(goal.text, tours);
        if (!id) return { done: "no_matching_tour" };
        return { tool: "propose_booking", args: { tourId: id } };
      }
      return { done: proposed.ok ? "proposed_waiting_for_traveller_approval" : `propose_failed:${proposed.error}` };
    }

    const bookingId = goal.bookingId;
    const b = lastResult(steps, "get_booking");
    if (!b) return { tool: "get_booking", args: { bookingId } };
    if (!b.ok) return { done: `unknown_booking` };
    const booking = b.data as { state: string };
    if (booking.state === "proposed") return { done: "waiting_for_traveller_approval" };
    if (booking.state !== "mandated") return { done: `nothing_to_do:${booking.state}` };

    const cyc = lastResult(steps, "check_cyclone");
    if (!cyc) return { tool: "check_cyclone", args: { bookingId } };
    if (cyc.ok && (cyc.data as { cancel: boolean }).cancel) return { done: "cyclone_alert_not_locking" };

    const m = lastResult(steps, "get_mandate");
    if (!m) return { tool: "get_mandate", args: { bookingId } };
    const mandate = m.ok ? (m.data as { status: string; notBefore: number; notAfter: number } | null) : null;
    if (!mandate || mandate.status !== "approved") return { done: "no_approved_mandate" };
    if (now < mandate.notBefore) return { done: `too_early_lock_window_opens_at:${new Date(mandate.notBefore).toISOString()}` };
    if (now > mandate.notAfter) return { done: "lock_window_closed" };

    const inv = lastResult(steps, "request_hold_invoice");
    if (!inv) return { tool: "request_hold_invoice", args: { bookingId } };
    if (!inv.ok) return { done: `invoice_failed:${inv.error}` };

    const pay = lastResult(steps, "pay_invoice");
    if (!pay) return { tool: "pay_invoice", args: { bookingId, invoice: (inv.data as { invoice: string }).invoice } };
    return { done: pay.ok ? "locked" : `refused:${pay.error}` };
  }
}

/** Runs the planner until it is done (bounded), reporting every step. */
export async function runAgent(f: AgentFacade, goal: Goal, onStep: (s: Step) => void = () => {}, planner: Planner = new RuleBasedPlanner(), maxSteps = 12) {
  const steps: Step[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const n = planner.next(goal, steps, f.now());
    if ("done" in n) return { outcome: n.done, steps };
    const s = { call: n, result: await runTool(f, n) };
    steps.push(s);
    onStep(s);
  }
  return { outcome: "step_limit", steps };
}
