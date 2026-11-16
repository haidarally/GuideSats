// `npm run e2e:sim`: the demo scenarios, end to end, on the SIMULATED backend.
// No network, no keys. Exits non-zero if any scenario does not end as expected.
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSimWorld } from "../src/app/world";
import { agentFacade, runTool } from "../src/agent/tools";
import { runAgent } from "../src/agent/planner";
import { loadFixture, replayShifted } from "../src/feeds/gdacs";
import { encodeSimInvoice } from "../src/ln/bolt11";
import { simNodeId } from "../src/ln/sim";
import { invoiceExpiresAt } from "../src/ln/invoiceCheck";
import type { GdacsFeed } from "../src/domain/cyclone";

const out = (s: string) => process.stdout.write(s + "\n");
let failed = 0;
const expect = (label: string, ok: boolean) => {
  out(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const secret = () => {
  const p = bytesToHex(randomBytes(32));
  return { p, h: bytesToHex(sha256(hexToBytes(p))) };
};

out("GuideSats end-to-end on the SIMULATED Lightning backend (regtest, in-process)\n");

{
  out("1. Happy path: the agent locks 21 000 sats, the guide settles with the traveller's code");
  const w = await buildSimWorld();
  const agent = agentFacade(w.svc);
  const proposed = await runAgent(agent, { kind: "book", text: "Le Morne sunrise hike" });
  const id = w.svc.bookings()[0]!.id;
  const { p, h } = secret();
  w.svc.approveMandate(id, { actor: "traveller", paymentHash: h, at: w.clock() });
  const locked = await runAgent(agent, { kind: "lock", bookingId: id });
  await w.svc.settleWithPreimage(id, p);
  expect(`agent proposed (${proposed.outcome})`, proposed.outcome === "proposed_waiting_for_traveller_approval");
  expect(`agent locked (${locked.steps.map((s) => s.call.tool).join(" > ")})`, locked.outcome === "locked");
  expect("booking settled", w.svc.booking(id).state === "settled");
  expect(`guide received ${w.ledger.balance("guide_lemorne")} sats`, w.ledger.balance("guide_lemorne") === 21_000);
}

{
  out("\n2. Cyclone: GDACS alert (BELAL-24 replay) after the lock, the hold is cancelled, the traveller is refunded");
  let feed: GdacsFeed = { features: [] };
  const w = await buildSimWorld({ feed: () => feed });
  const { booking } = w.svc.proposeBooking("tour_lagoon");
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: secret().h, at: w.clock() });
  await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id });
  const before = w.ledger.balance("traveller");
  feed = replayShifted(loadFixture("tc-2024-01-belal.json"), w.clock() - 6 * 3_600_000);
  await w.svc.applyCycloneRule();
  expect(`locked first (traveller balance ${before})`, before === 120_000 - 12_000);
  expect("booking refunded_cyclone", w.svc.booking(booking.id).state === "refunded_cyclone");
  expect(`traveller back to ${w.ledger.balance("traveller")} sats`, w.ledger.balance("traveller") === 120_000);
}

{
  out("\n3. The agent tries to pay more, or someone else: refused by the mandate and the invoice check");
  const w = await buildSimWorld();
  const { booking } = w.svc.proposeBooking("tour_lemorne");
  const { h } = secret();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: h, at: w.clock() });
  const f = agentFacade(w.svc);
  const now = Math.floor(w.clock() / 1000);
  const greedy = encodeSimInvoice({ network: "regtest", amountSats: 50_000, paymentHash: h, description: "upsell", timestamp: now, expirySecs: 600, payeeNodeId: simNodeId("guide_lemorne") });
  const stranger = encodeSimInvoice({ network: "regtest", amountSats: 21_000, paymentHash: h, description: "x", timestamp: now, expirySecs: 600, payeeNodeId: simNodeId("someone_else") });
  const r1 = await runTool(f, { tool: "pay_invoice", args: { bookingId: booking.id, invoice: greedy } });
  const r2 = await runTool(f, { tool: "pay_invoice", args: { bookingId: booking.id, invoice: stranger } });
  const r3 = await runTool(f, { tool: "approve_mandate" as never, args: { bookingId: booking.id } });
  expect(`over-cap invoice refused (${r1.ok ? "paid!" : r1.error})`, !r1.ok);
  expect(`other payee refused (${r2.ok ? "paid!" : r2.error})`, !r2.ok);
  expect(`no approve tool (${r3.ok ? "exists!" : r3.error})`, !r3.ok);
  expect(`traveller still has ${w.ledger.balance("traveller")} sats`, w.ledger.balance("traveller") === 120_000);
}

{
  out("\n4. Plan B (wallets without hold invoices): pay after the tour, once the traveller confirms it");
  let now = Date.now();
  const w = await buildSimWorld({ clock: () => now });
  const { booking } = w.svc.proposeBooking("tour_lagoon", "on_completion");
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: null, at: now });
  const early = await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id });
  now += 9 * 3_600_000; // the 2 h lagoon tour started 6 h after booking
  w.svc.confirmTourHappened(booking.id);
  const paid = await runAgent(agentFacade(w.svc), { kind: "lock", bookingId: booking.id });
  expect(`agent waits before confirmation (${early.outcome})`, early.outcome === "waiting_for_traveller_to_confirm_the_tour");
  expect(`agent pays after confirmation (${paid.outcome})`, paid.outcome === "paid");
  expect(`guide received ${w.ledger.balance("guide_lagoon")} sats`, w.ledger.balance("guide_lagoon") === 12_000);
}

{
  out("\n5. A hold invoice expires before the agent pays it: the traveller approves again with a NEW secret");
  let now = Date.now();
  const w = await buildSimWorld({ clock: () => now });
  const agent = agentFacade(w.svc);
  const { booking } = w.svc.proposeBooking("tour_lemorne");
  const s1 = secret();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s1.h, at: now });
  const old = await runTool(agent, { tool: "request_invoice", args: { bookingId: booking.id } }); // asked for, never paid
  const oldInvoice = old.ok ? (old.data as { invoice: string }).invoice : "";
  now = (invoiceExpiresAt(oldInvoice) ?? now) + 1000;
  await w.svc.reconcile(); // the watcher's tick
  const reused = (() => {
    try {
      w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s1.h, at: now });
      return "approved!";
    } catch (e) {
      return (e as { code?: string }).code ?? "refused";
    }
  })();
  const stateAfterExpiry = w.svc.booking(booking.id).state;
  const s2 = secret();
  w.svc.approveMandate(booking.id, { actor: "traveller", paymentHash: s2.h, at: now });
  const replay = await runTool(agent, { tool: "pay_invoice", args: { bookingId: booking.id, invoice: oldInvoice } });
  const locked = await runAgent(agent, { kind: "lock", bookingId: booking.id });
  const oldSecret = await w.svc.settleWithPreimage(booking.id, s1.p).then(() => "settled!", (e: { code?: string }) => e.code ?? "refused");
  await w.svc.settleWithPreimage(booking.id, s2.p);
  expect(`booking waits for the traveller (${stateAfterExpiry})`, stateAfterExpiry === "reapproval_needed");
  expect(`the old hash cannot be approved again (${reused})`, reused === "payment_hash_reused");
  expect(`the old invoice is refused (${replay.ok ? "paid!" : replay.error})`, !replay.ok);
  expect(`agent locked with the new hash (${locked.outcome})`, locked.outcome === "locked");
  expect(`the old secret cannot settle (${oldSecret})`, oldSecret === "preimage_mismatch");
  expect(`guide received ${w.ledger.balance("guide_lemorne")} sats, once`, w.ledger.balance("guide_lemorne") === 21_000 && w.ledger.balance("traveller") === 99_000);
}

out(failed === 0 ? "\nAll scenarios passed (SIMULATED)." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
