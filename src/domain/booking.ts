// Booking state machine. One table, no hidden transitions.
//
//  proposed --APPROVE_MANDATE--> mandated --LOCK--> locked --SETTLE--> settled
//      |                            |                  |--CYCLONE_CANCEL--> refunded_cyclone
//      |                            |                  '--HOLD_EXPIRED----> refunded_expired
//      |                            |--CYCLONE_CANCEL--> skipped_cyclone   (nothing was locked)
//      |                            |--PAY_ON_COMPLETION--> paid           (plan B: no holds)
//      '--TRAVELLER_CANCEL / mandated --TRAVELLER_CANCEL--> cancelled

export type BookingState =
  | "proposed"
  | "mandated"
  | "locked"
  | "settled"
  | "refunded_cyclone"
  | "refunded_expired"
  | "skipped_cyclone"
  | "paid"
  | "cancelled";

export type BookingEvent =
  | "APPROVE_MANDATE"
  | "LOCK"
  | "SETTLE"
  | "CYCLONE_CANCEL"
  | "HOLD_EXPIRED"
  | "PAY_ON_COMPLETION"
  | "TRAVELLER_CANCEL";

export const TRANSITIONS: Readonly<Record<BookingState, Readonly<Partial<Record<BookingEvent, BookingState>>>>> = {
  proposed: { APPROVE_MANDATE: "mandated", TRAVELLER_CANCEL: "cancelled", CYCLONE_CANCEL: "skipped_cyclone" },
  mandated: { LOCK: "locked", CYCLONE_CANCEL: "skipped_cyclone", PAY_ON_COMPLETION: "paid", TRAVELLER_CANCEL: "cancelled" },
  locked: { SETTLE: "settled", CYCLONE_CANCEL: "refunded_cyclone", HOLD_EXPIRED: "refunded_expired" },
  settled: {},
  refunded_cyclone: {},
  refunded_expired: {},
  skipped_cyclone: {},
  paid: {},
  cancelled: {},
};

export const TERMINAL_STATES: readonly BookingState[] = (Object.keys(TRANSITIONS) as BookingState[]).filter(
  (s) => Object.keys(TRANSITIONS[s]).length === 0,
);

export type PaymentMode = "hold" | "on_completion";

export interface Booking {
  id: string;
  tourId: string;
  guideId: string;
  travellerId: string;
  priceSats: number;
  tourStart: number; // ms epoch
  tourEnd: number; // ms epoch
  mode: PaymentMode;
  state: BookingState;
  paymentHash: string | null;
  invoice: string | null;
  confirmedAt?: number | null; // plan B: when the traveller confirmed the tour happened
  history: { at: number; event: BookingEvent; from: BookingState; to: BookingState }[];
}

export class TransitionError extends Error {
  constructor(
    readonly from: BookingState,
    readonly event: BookingEvent,
  ) {
    super(`illegal transition: ${event} from ${from}`);
    this.name = "TransitionError";
  }
}

export function nextState(from: BookingState, event: BookingEvent): BookingState | null {
  return TRANSITIONS[from][event] ?? null;
}

export function applyEvent(b: Booking, event: BookingEvent, at: number): Booking {
  const to = nextState(b.state, event);
  if (to === null) throw new TransitionError(b.state, event);
  if (event === "LOCK" && b.mode !== "hold") throw new TransitionError(b.state, event);
  if (event === "PAY_ON_COMPLETION" && b.mode !== "on_completion") throw new TransitionError(b.state, event);
  return { ...b, state: to, history: [...b.history, { at, event, from: b.state, to }] };
}

export function isTerminal(s: BookingState): boolean {
  return TERMINAL_STATES.includes(s);
}
