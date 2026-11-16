// The two flows of `npm run e2e:nwc-app`, driven only through the app's HTTP API (the calls the PWA makes).
// Written against a `call` function, so they also run offline against the app on a non-simulated wrapper of
// the simulator (tests/scripts/e2e-nwc-app-flow.test.ts). Never logs the secret P (the meeting code).
//
//   (a) book -> the traveller approves (new secret) -> the agent locks (hold accepted, hold-limit check ok)
//       -> the traveller shows the meeting code -> the guide settles -> booking settled, traveller balance
//       down by the price
//   (b) book -> approve -> the overspend push (refused before any wallet call) -> the agent locks
//       -> synthetic cyclone replay -> hold cancelled -> booking refunded_cyclone, traveller balance back
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Logger } from "../src/log/redact";

export type Call = (path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

export interface AppFlowDeps {
  call: Call;
  log: Logger;
  newSecret: () => string; // 32-byte hex P, made the way the traveller's phone makes it
  tours: { settle: string; refund: string };
  minBalanceSats?: number; // refuse to start under this traveller balance (default 2 000)
  allowSimulated?: boolean; // the offline test only
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number; // between balance reads (default 2 s)
  waitMs?: number; // how long a balance may take to show the payment (default 90 s)
}

interface StateBooking {
  id: string;
  state: string;
  priceSats: number;
  holdCheckedAt?: number;
}
interface StateAudit {
  seq: number;
  event: string;
  fields: Record<string, unknown>;
}
interface AppState {
  simulated: boolean;
  backend: string;
  network: string;
  blockHeight: number | null;
  traveller: { balanceSats: number | null };
  guides: { id: string; balanceSats: number | null }[];
  tours: { id: string; priceSats: number; startAt: number }[];
  bookings: StateBooking[];
  audit: StateAudit[];
}

export interface FlowReport {
  bookingId: string;
  priceSats: number;
  agent: string[];
  holdLimit: { deadlineKind: unknown; settleDeadline: unknown; blockHeight: unknown; spareBlocks: unknown };
  finalState: string;
  travellerDeltaSats: number;
  guideDeltaSats: number;
}

/** Fields of the audit trail worth printing. Node keys and hashes stay out of the report. */
const AUDIT_FIELDS = ["amountSats", "capSats", "reason", "state", "spareBlocks", "deadlineKind", "settleDeadline", "blockHeight", "eventid", "error", "cancelled"];

export async function runAppFlows(d: AppFlowDeps): Promise<{ settle: FlowReport; refund: FlowReport; overspend: { tool: string; refused: string }[] }> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = d.pollMs ?? 2000;
  const waitMs = d.waitMs ?? 90_000;

  const ok = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await d.call(path, body);
    if (r.status !== 200) throw new Error(`${path} answered ${r.status}: ${JSON.stringify(r.json)}`);
    return r.json as T;
  };
  const state = () => ok<AppState>("/api/state");
  const booking = (s: AppState, id: string) => {
    const b = s.bookings.find((x) => x.id === id);
    if (!b) throw new Error(`booking ${id} missing from the state`);
    return b;
  };
  const balances = (s: AppState) => {
    const t = s.traveller.balanceSats;
    const g = s.guides[0]?.balanceSats ?? null;
    if (t === null || g === null) throw new Error("a wallet balance could not be read");
    return { t, g };
  };
  /** Polls until the traveller's balance is `want` (a payment can take a moment to show), else fails. */
  const waitBalance = async (want: number): Promise<AppState> => {
    const until = Date.now() + waitMs;
    for (;;) {
      const s = await state();
      if (s.traveller.balanceSats === want) return s;
      if (Date.now() >= until) throw new Error(`traveller balance ${s.traveller.balanceSats}, expected ${want}`);
      await sleep(pollMs);
    }
  };
  const printAudit = (s: AppState, id: string) => {
    for (const a of [...s.audit].sort((x, y) => x.seq - y.seq)) {
      if (a.fields.bookingId !== id) continue;
      const f: Record<string, unknown> = {};
      for (const k of AUDIT_FIELDS) if (k in a.fields) f[k] = a.fields[k];
      d.log.info(`audit:${a.event}`, { bookingId: id, ...f });
    }
  };

  const s0 = await state();
  if (s0.simulated && !d.allowSimulated) throw new Error("the app runs on the SIMULATED backend, not over NWC");
  const b0 = balances(s0);
  const min = d.minBalanceSats ?? 2000;
  if (b0.t < min) throw new Error(`traveller balance ${b0.t} sats is under ${min}: stop`);
  d.log.info("e2e_app_start", { backend: s0.backend, network: s0.network, blockHeight: s0.blockHeight, travellerSats: b0.t, guideSats: b0.g });

  /** book -> approve with a new secret -> the agent locks; checks the hold-limit check passed. */
  const bookApproveLock = async (tourId: string, flow: string, between?: (bookingId: string) => Promise<void>) => {
    const tour = s0.tours.find((t) => t.id === tourId);
    if (!tour) throw new Error(`unknown tour ${tourId}`);
    const proposed = await ok<{ bookingId: string; capSats: number; notBefore: number; notAfter: number }>("/api/traveller/bookings", { tourId });
    if (proposed.capSats !== tour.priceSats) throw new Error(`mandate cap ${proposed.capSats}, tour price ${tour.priceSats}`);
    d.log.info(`${flow}_booked`, { bookingId: proposed.bookingId, capSats: proposed.capSats, windowOpensMinBeforeTour: Math.round((tour.startAt - proposed.notBefore) / 60_000) });
    const p = d.newSecret();
    const h = bytesToHex(sha256(hexToBytes(p)));
    const approved = await ok<{ mandate: { status: string } }>(`/api/traveller/bookings/${proposed.bookingId}/approve`, { paymentHash: h });
    d.log.info(`${flow}_approved`, { bookingId: proposed.bookingId, mandate: approved.mandate.status, paymentHash: h });
    if (between) await between(proposed.bookingId);
    const run = await ok<{ outcome: string; steps: { call: { tool: string }; result: { ok: boolean; error?: string } }[] }>("/api/agent/run", { bookingId: proposed.bookingId });
    const agent = run.steps.map((s) => `${s.call.tool}:${s.result.ok ? "ok" : s.result.error}`);
    d.log.info(`${flow}_agent`, { bookingId: proposed.bookingId, outcome: run.outcome, steps: agent });
    if (run.outcome !== "locked") throw new Error(`agent outcome ${run.outcome}`);
    const s = await state();
    const b = booking(s, proposed.bookingId);
    const fit = s.audit.find((a) => a.event === "hold_limit_ok" && a.fields.bookingId === proposed.bookingId);
    if (b.state !== "locked" || !b.holdCheckedAt || !fit) throw new Error(`after the lock: state ${b.state}, hold-limit check ${fit ? "ok" : "missing"}`);
    const holdLimit = { deadlineKind: fit.fields.deadlineKind, settleDeadline: fit.fields.settleDeadline, blockHeight: fit.fields.blockHeight, spareBlocks: fit.fields.spareBlocks };
    d.log.info(`${flow}_locked`, { bookingId: proposed.bookingId, amountSats: b.priceSats, ...holdLimit });
    return { bookingId: proposed.bookingId, p, price: tour.priceSats, agent, holdLimit };
  };

  // (a) settle
  const a = await bookApproveLock(d.tours.settle, "a");
  d.log.info("a_meeting_code_shown", { bookingId: a.bookingId }); // P goes from the traveller to the guide; never logged
  const settled = await ok<{ state: string }>(`/api/guide/bookings/${a.bookingId}/settle`, { preimage: a.p });
  d.log.info("a_guide_settled", { bookingId: a.bookingId, state: settled.state });
  const sa = await waitBalance(b0.t - a.price);
  const ba = balances(sa);
  const settle: FlowReport = {
    bookingId: a.bookingId,
    priceSats: a.price,
    agent: a.agent,
    holdLimit: a.holdLimit,
    finalState: booking(sa, a.bookingId).state,
    travellerDeltaSats: ba.t - b0.t,
    guideDeltaSats: ba.g - b0.g,
  };
  if (settle.finalState !== "settled") throw new Error(`flow (a) ended ${settle.finalState}`);
  printAudit(sa, a.bookingId);
  d.log.info("a_done", { ...settle });

  // (b) refund on the synthetic cyclone replay
  const overspend: { tool: string; refused: string }[] = [];
  const b = await bookApproveLock(d.tours.refund, "b", async (bookingId) => {
    const r = await ok<{ bookingId: string; results: { tool: string; ok: boolean; error?: string }[] }>("/api/demo/attack", {});
    if (r.bookingId !== bookingId || r.results.some((x) => x.ok)) throw new Error("the overspend push was not refused");
    for (const x of r.results) overspend.push({ tool: x.tool, refused: x.error ?? "" });
    d.log.info("b_overspend_refused", { bookingId, refusals: overspend.map((x) => `${x.tool}:${x.refused}`) });
  });
  const cyc = await ok<{ affected: string[] }>("/api/demo/cyclone", { on: true });
  d.log.info("b_cyclone_replay", { affected: cyc.affected });
  if (!cyc.affected.includes(b.bookingId)) throw new Error("the cyclone rule did not reach the locked booking");
  const sb = await waitBalance(ba.t);
  const bb = balances(sb);
  await ok("/api/demo/cyclone", { on: false });
  const refund: FlowReport = {
    bookingId: b.bookingId,
    priceSats: b.price,
    agent: b.agent,
    holdLimit: b.holdLimit,
    finalState: booking(sb, b.bookingId).state,
    travellerDeltaSats: bb.t - ba.t,
    guideDeltaSats: bb.g - ba.g,
  };
  if (refund.finalState !== "refunded_cyclone") throw new Error(`flow (b) ended ${refund.finalState}`);
  printAudit(sb, b.bookingId);
  d.log.info("b_done", { ...refund });
  return { settle, refund, overspend };
}
