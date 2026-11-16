// HTTP API (Hono) + Server-Sent Events. Local demo only: the server binds to 127.0.0.1.
// Doors: /api/traveller/* (approve), /api/guide/* (settle), /api/agent/* (run the agent),
// /api/demo/* (simulator controls, SIMULATED backend only).
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { agentFacade, runTool, type ToolCall } from "../agent/tools";
import { encodeSimInvoice } from "../ln/bolt11";
import { simNodeId } from "../ln/sim";
import { runAgent, type Goal } from "../agent/planner";
import { cycloneVerdict } from "../domain/cyclone";
import { ServiceError } from "../app/service";
import { MandateError } from "../domain/mandate";
import { TransitionError } from "../domain/booking";
import { loadFixture, replayShifted } from "../feeds/gdacs";
import { redact } from "../log/redact";
import type { BookingService } from "../app/service";
import type { TxRecord } from "../ln/backend";

/** What the server needs from a world: the service, plus a clock control on the simulator only. */
export interface AppWorld {
  svc: BookingService;
  advance?: (ms: number) => void;
}

export interface ServerContext {
  world(): AppWorld;
  reset(): Promise<void>;
  allowedHosts: string[]; // e.g. ["127.0.0.1:8787", "localhost:8787"]
}

const ID = /^[a-z0-9_]{1,40}$/;
const HEX32 = /^[0-9a-f]{64}$/;

class BadRequest extends Error {}

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

function param(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  if (!ID.test(v)) throw new BadRequest(`bad ${name}`);
  return v;
}

const newestFirst = (txs: TxRecord[]) => [...txs].sort((a, b) => b.at - a.at).slice(0, 20);

/** Where the banner's cyclone comes from. The event name carries "(SYNTHETIC REPLAY)" for the demo replay. */
function cycloneSource(feed: { features: unknown[] }, event: { name: string } | undefined): string {
  if (event) return `GDACS (${event.name})`;
  return feed.features.length ? "GDACS: no Orange or Red cyclone alert for Mauritius" : "GDACS: no active alert";
}

/** Everything the PWA shows. Wallet data is read through the Lightning interface, so it is the same for SIM and NWC. */
export async function snapshot(w: AppWorld) {
  const { svc } = w;
  const now = svc.now();
  const feed = svc.currentFeed();
  const travellerId = svc.travellerWalletId;
  const payer = svc.backend.payer(travellerId);
  const guides = await Promise.all(
    svc.guides.map(async (g) => {
      const r = svc.backend.receiver(g.id);
      return { ...g, balanceSats: await r.getBalance(), transactions: newestFirst(await r.listTransactions()) };
    }),
  );
  const anyTour = svc.tours[0];
  const verdict = anyTour ? cycloneVerdict(feed, { now, tourStart: now, tourEnd: now + 48 * 3_600_000 }) : { cancel: false };
  return {
    simulated: svc.backend.simulated,
    backend: svc.backend.kind,
    network: svc.backend.network,
    now,
    cyclone: { active: verdict.cancel, event: "event" in verdict ? verdict.event : undefined, source: cycloneSource(feed, "event" in verdict ? verdict.event : undefined) },
    traveller: {
      id: travellerId,
      balanceSats: await payer.getBalance(),
      budget: await payer.getBudget(),
      transactions: newestFirst(await payer.listTransactions()),
    },
    guides,
    tours: svc.tours,
    bookings: svc.bookings().map((b) => {
      const m = svc.mandate(b.id);
      return {
        ...b,
        invoice: b.invoice,
        mandate: m && { status: m.status, capSats: m.capSats, payeePubkey: m.payeePubkey, notBefore: m.notBefore, notAfter: m.notAfter },
      };
    }),
    audit: svc.audit(30).map((a) => redact(a)),
  };
}

export function createApp(ctx: ServerContext) {
  const app = new Hono();
  const subscribers = new Set<(event: string, data: unknown) => void>();
  const broadcast = (event: string, data: unknown) => {
    for (const s of subscribers) s(event, data);
  };
  let unhook = ctx.world().svc.on((e) => broadcast("update", { type: e.type }));

  app.use("*", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], imgSrc: ["'self'", "data:"], styleSrc: ["'self'"], scriptSrc: ["'self'"], connectSrc: ["'self'"] } }));

  // DNS-rebinding and CSRF guard: only our own host, and POSTs must be JSON from our origin.
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!ctx.allowedHosts.includes(host)) return c.json({ error: "forbidden_host" }, 403);
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && !ctx.allowedHosts.some((h) => origin === `http://${h}`)) return c.json({ error: "forbidden_origin" }, 403);
      if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "json_only" }, 415);
    }
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }));

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof ServiceError) return c.json({ error: err.code }, 409);
    if (err instanceof MandateError || err instanceof TransitionError) return c.json({ error: err.message }, 409);
    return c.json({ error: "internal_error" }, 500); // never echo internals
  });

  app.get("/api/state", async (c) => c.json(await snapshot(ctx.world())));

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) });
      subscribers.add(send);
      stream.onAbort(() => {
        subscribers.delete(send);
      });
      send("hello", { ok: true });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "{}" }));
    }),
  );

  // ---------- traveller ----------
  app.post("/api/traveller/bookings", async (c) => {
    const b = await json(c);
    const tourId = typeof b.tourId === "string" && ID.test(b.tourId) ? b.tourId : null;
    if (!tourId) throw new BadRequest("bad tourId");
    const mode = b.mode === undefined || b.mode === "hold" ? "hold" : b.mode === "on_completion" ? "on_completion" : null;
    if (!mode) throw new BadRequest("mode must be hold or on_completion");
    const { booking, mandate } = ctx.world().svc.proposeBooking(tourId, mode);
    return c.json({ bookingId: booking.id, capSats: mandate.capSats, payeePubkey: mandate.payeePubkey, notBefore: mandate.notBefore, notAfter: mandate.notAfter });
  });

  app.post("/api/traveller/bookings/:id/approve", async (c) => {
    const id = param(c, "id");
    const b = await json(c);
    if (b.paymentHash !== undefined && b.paymentHash !== null && (typeof b.paymentHash !== "string" || !HEX32.test(b.paymentHash.toLowerCase()))) {
      throw new BadRequest("paymentHash must be 32-byte hex (SHA-256 of the secret kept on this phone)");
    }
    const svc = ctx.world().svc;
    let h: string | null = null;
    if (svc.booking(id).mode === "hold") {
      h = typeof b.paymentHash === "string" ? b.paymentHash.toLowerCase() : "";
      if (!HEX32.test(h)) throw new BadRequest("paymentHash must be 32-byte hex (SHA-256 of the secret kept on this phone)");
    } else if (b.paymentHash !== undefined && b.paymentHash !== null) throw new BadRequest("plan B takes no paymentHash");
    const m = svc.approveMandate(id, { actor: "traveller", paymentHash: h, at: svc.now() });
    return c.json({ ok: true, mandate: { status: m.status, capSats: m.capSats } });
  });

  app.post("/api/traveller/bookings/:id/confirm", async (c) => {
    const b = ctx.world().svc.confirmTourHappened(param(c, "id"));
    return c.json({ ok: true, state: b.state, confirmed: true });
  });

  app.post("/api/traveller/bookings/:id/cancel", async (c) => {
    const b = ctx.world().svc.cancelByTraveller(param(c, "id"));
    return c.json({ ok: true, state: b.state });
  });

  // ---------- guide ----------
  app.post("/api/guide/bookings/:id/settle", async (c) => {
    const id = param(c, "id");
    const b = await json(c);
    const p = typeof b.preimage === "string" ? b.preimage.trim().toLowerCase() : "";
    if (!HEX32.test(p)) throw new BadRequest("preimage must be 32-byte hex");
    const booking = await ctx.world().svc.settleWithPreimage(id, p);
    return c.json({ ok: true, state: booking.state });
  });

  // ---------- agent ----------
  app.post("/api/agent/run", async (c) => {
    const b = await json(c);
    let goal: Goal;
    if (typeof b.bookingId === "string" && ID.test(b.bookingId)) goal = { kind: "lock", bookingId: b.bookingId };
    else if (typeof b.text === "string" && b.text.trim().length > 0 && b.text.length <= 300) goal = { kind: "book", text: b.text };
    else throw new BadRequest("give bookingId or text (max 300 chars)");
    const svc = ctx.world().svc;
    broadcast("agent", { goal: goal.kind === "book" ? { kind: "book" } : goal, started: true });
    const r = await runAgent(agentFacade(svc), goal, (s) => broadcast("agent", redact(s)));
    broadcast("agent", { outcome: r.outcome });
    return c.json(redact({ outcome: r.outcome, steps: r.steps }));
  });

  // ---------- demo controls (SIMULATED only) ----------
  const simOnly = (c: Context) => (ctx.world().svc.backend.simulated ? null : c.json({ error: "demo controls exist only on the SIMULATED backend" }, 403));

  app.post("/api/demo/cyclone", async (c) => {
    const no = simOnly(c);
    if (no) return no;
    const b = await json(c);
    const svc = ctx.world().svc;
    const on = b.on === true;
    const replay = replayShifted(loadFixture("tc-2024-01-belal.json"), svc.now() - 6 * 3_600_000);
    svc.setFeed(on ? () => replay : () => ({ type: "FeatureCollection", features: [] }));
    const r = await svc.applyCycloneRule();
    broadcast("update", { type: "cyclone" });
    return c.json({ ok: true, active: on, affected: r.verdicts.map((v) => v.bookingId) });
  });

  // Shows the mandate at work: the agent is pushed to overspend, pay someone else, or approve itself.
  app.post("/api/demo/attack", async (c) => {
    const no = simOnly(c);
    if (no) return no;
    const svc = ctx.world().svc;
    const target = [...svc.bookings()].reverse().find((b) => b.mode === "hold" && b.state === "mandated" && b.paymentHash);
    if (!target) return c.json({ error: "approve_a_booking_first" }, 409);
    const ts = Math.floor(svc.now() / 1000);
    const other = svc.guides.find((g) => g.id !== target.guideId)!;
    const forge = (amountSats: number, payee: string) =>
      encodeSimInvoice({ network: "regtest", amountSats, paymentHash: target.paymentHash!, description: "attack", timestamp: ts, expirySecs: 600, payeeNodeId: payee });
    const calls: ToolCall[] = [
      { tool: "pay_invoice", args: { bookingId: target.id, invoice: forge(target.priceSats * 3, simNodeId(target.guideId)) } },
      { tool: "pay_invoice", args: { bookingId: target.id, invoice: forge(target.priceSats, simNodeId(other.id)) } },
      { tool: "approve_mandate" as ToolCall["tool"], args: { bookingId: target.id } },
      { tool: "raise_cap" as ToolCall["tool"], args: { bookingId: target.id, capSats: 1_000_000 } },
    ];
    const f = agentFacade(svc);
    broadcast("agent", { goal: { kind: "attack" }, started: true });
    const results = [];
    for (const call of calls) {
      const result = await runTool(f, call);
      broadcast("agent", redact({ call, result }));
      results.push({ tool: call.tool, ok: result.ok, error: result.ok ? undefined : result.error });
    }
    broadcast("agent", { outcome: results.every((r) => !r.ok) ? "all_refused_by_the_mandate" : "SOMETHING_WAS_PAID" });
    return c.json({ bookingId: target.id, results });
  });

  app.post("/api/demo/advance", async (c) => {
    const no = simOnly(c);
    if (no) return no;
    const b = await json(c);
    const hours = typeof b.hours === "number" && b.hours > 0 && b.hours <= 48 ? b.hours : null;
    if (hours === null) throw new BadRequest("hours must be in (0, 48]");
    const w = ctx.world();
    if (!w.advance) return c.json({ error: "no clock control on this backend" }, 403);
    w.advance(hours * 3_600_000);
    const reconciled = await w.svc.reconcile();
    broadcast("update", { type: "clock" });
    return c.json({ ok: true, now: w.svc.now(), reconciled });
  });

  app.post("/api/demo/reset", async (c) => {
    const no = simOnly(c);
    if (no) return no;
    unhook();
    await ctx.reset();
    unhook = ctx.world().svc.on((e) => broadcast("update", { type: e.type }));
    broadcast("update", { type: "reset" });
    return c.json({ ok: true });
  });

  return app;
}
