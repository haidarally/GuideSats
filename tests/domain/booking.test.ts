import { describe, it, expect } from "vitest";
import { applyEvent, isTerminal, nextState, TERMINAL_STATES, TRANSITIONS, TransitionError, type Booking, type BookingEvent, type BookingState } from "../../src/domain/booking";

const base: Booking = {
  id: "b1",
  tourId: "t1",
  guideId: "g1",
  travellerId: "tr1",
  priceSats: 21_000,
  tourStart: 2_000,
  tourEnd: 3_000,
  mode: "hold",
  state: "proposed",
  paymentHash: null,
  invoice: null,
  history: [],
};

const ALL_EVENTS: BookingEvent[] = ["APPROVE_MANDATE", "LOCK", "SETTLE", "CYCLONE_CANCEL", "HOLD_EXPIRED", "PAY_ON_COMPLETION", "TRAVELLER_CANCEL"];
const ALL_STATES = Object.keys(TRANSITIONS) as BookingState[];

describe("booking state machine", () => {
  it("happy path: proposed -> mandated -> locked -> settled, with history", () => {
    let b = applyEvent(base, "APPROVE_MANDATE", 1);
    b = applyEvent(b, "LOCK", 2);
    b = applyEvent(b, "SETTLE", 3);
    expect(b.state).toBe("settled");
    expect(b.history.map((h) => h.to)).toEqual(["mandated", "locked", "settled"]);
  });
  it("cyclone while locked refunds; before lock it skips", () => {
    const m = applyEvent(base, "APPROVE_MANDATE", 1);
    expect(applyEvent(applyEvent(m, "LOCK", 2), "CYCLONE_CANCEL", 3).state).toBe("refunded_cyclone");
    expect(applyEvent(m, "CYCLONE_CANCEL", 2).state).toBe("skipped_cyclone");
  });
  it("hold expiry refunds", () => {
    const l = applyEvent(applyEvent(base, "APPROVE_MANDATE", 1), "LOCK", 2);
    expect(applyEvent(l, "HOLD_EXPIRED", 3).state).toBe("refunded_expired");
  });
  it("plan B (on_completion) pays only after the mandate, and cannot LOCK", () => {
    const m = applyEvent({ ...base, mode: "on_completion" }, "APPROVE_MANDATE", 1);
    expect(applyEvent(m, "PAY_ON_COMPLETION", 2).state).toBe("paid");
    expect(() => applyEvent(m, "LOCK", 2)).toThrow(TransitionError);
    expect(() => applyEvent(applyEvent(base, "APPROVE_MANDATE", 1), "PAY_ON_COMPLETION", 2)).toThrow(TransitionError);
  });
  it("a locked booking cannot be cancelled by the traveller (only cyclone or expiry)", () => {
    const l = applyEvent(applyEvent(base, "APPROVE_MANDATE", 1), "LOCK", 2);
    expect(() => applyEvent(l, "TRAVELLER_CANCEL", 3)).toThrow("illegal transition");
  });
  it("money can only be locked after the mandate is approved", () => {
    expect(nextState("proposed", "LOCK")).toBeNull();
    expect(nextState("proposed", "SETTLE")).toBeNull();
  });
  it("terminal states accept no event", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["cancelled", "paid", "refunded_cyclone", "refunded_expired", "settled", "skipped_cyclone"]);
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true);
      for (const e of ALL_EVENTS) expect(nextState(s, e)).toBeNull();
    }
  });
  it("every (state, event) pair is either in the table or throws", () => {
    let legal = 0;
    for (const s of ALL_STATES)
      for (const e of ALL_EVENTS) {
        const to = nextState(s, e);
        const b = { ...base, state: s, mode: e === "PAY_ON_COMPLETION" ? ("on_completion" as const) : ("hold" as const) };
        if (to === null) expect(() => applyEvent(b, e, 0)).toThrow(TransitionError);
        else {
          legal++;
          expect(applyEvent(b, e, 0).state).toBe(to);
        }
      }
    expect(legal).toBe(10);
  });
});
