// SIMULATED Lightning backend: an in-process ledger with hold invoices.
// Deterministic (injected clock, no randomness), regtest-only invoices with a zero
// signature, so nothing it produces can ever be paid on a real network.
// No private keys exist here: "node ids" are labels derived by hashing a wallet id.
import { decode } from "light-bolt11-decoder";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeSimInvoice } from "./bolt11";
import type {
  Budget,
  HoldInvoiceRequest,
  HoldState,
  LightningBackend,
  MadeInvoice,
  PayerWallet,
  PayOutcome,
  ReceiverWallet,
  TxRecord,
  WalletInfo,
} from "./backend";

export const SIM_LABEL = "SIMULATED";

/** A stable 33-byte identifier for a simulated wallet. Not a key: nobody can sign with it. */
export function simNodeId(walletId: string): string {
  return "02" + bytesToHex(sha256(new TextEncoder().encode(`sim-node:${walletId}`)));
}

interface Hold {
  receiver: string;
  payer: string | null;
  amountSats: number;
  paymentHash: string;
  invoice: string;
  state: HoldState;
  invoiceExpiresAt: number;
  settleDeadline: number | null;
  resolve: ((o: PayOutcome) => void) | null;
  plain: boolean; // a regular invoice (plan B): paid at once, no hold
  preimage: string | null; // known to the receiving wallet for plain invoices
}

export interface SimOptions {
  clock: () => number;
  balances: Record<string, number>; // walletId -> sats
  budgets?: Record<string, Budget>;
  holdMaxSecs?: number; // how long an accepted hold may stay unsettled (assumed 12 h until measured)
}

export class SimLedger {
  readonly clock: () => number;
  readonly holdMaxSecs: number;
  private balances = new Map<string, number>();
  private budgets = new Map<string, Budget>();
  private holds = new Map<string, Hold>(); // key: `${receiver}:${paymentHash}`
  private tx = new Map<string, TxRecord[]>();

  constructor(opts: SimOptions) {
    this.clock = opts.clock;
    this.holdMaxSecs = opts.holdMaxSecs ?? 12 * 3600;
    for (const [id, sats] of Object.entries(opts.balances)) this.balances.set(id, sats);
    for (const [id, b] of Object.entries(opts.budgets ?? {})) this.budgets.set(id, { ...b });
  }

  balance(id: string): number {
    return this.balances.get(id) ?? 0;
  }
  budget(id: string): Budget | null {
    const b = this.budgets.get(id);
    return b ? { ...b } : null;
  }
  transactions(id: string): TxRecord[] {
    return [...(this.tx.get(id) ?? [])];
  }
  holdState(receiver: string, hash: string): HoldState | null {
    return this.holds.get(`${receiver}:${hash}`)?.state ?? null;
  }
  /** Every hold the ledger knows, for invariant checks in tests. */
  allHolds(): { receiver: string; payer: string | null; amountSats: number; paymentHash: string; state: HoldState }[] {
    return [...this.holds.values()].map((h) => ({ receiver: h.receiver, payer: h.payer, amountSats: h.amountSats, paymentHash: h.paymentHash, state: h.state }));
  }
  /** Sum of every wallet balance plus funds held in flight: must never change. */
  totalSats(): number {
    let t = 0;
    for (const v of this.balances.values()) t += v;
    for (const h of this.holds.values()) if (h.state === "accepted") t += h.amountSats;
    return t;
  }

  private record(id: string, r: TxRecord) {
    const list = this.tx.get(id) ?? [];
    list.push(r);
    this.tx.set(id, list);
  }
  private updateTx(id: string, hash: string, state: TxRecord["state"]) {
    for (const r of this.tx.get(id) ?? []) if (r.paymentHash === hash) r.state = state;
  }

  makeHold(receiver: string, req: HoldInvoiceRequest): MadeInvoice {
    const key = `${receiver}:${req.paymentHash}`;
    if (this.holds.has(key)) throw new Error("hold invoice already exists for this hash");
    const now = this.clock();
    const invoice = encodeSimInvoice({
      network: "regtest",
      amountSats: req.amountSats,
      paymentHash: req.paymentHash,
      description: `[${SIM_LABEL}] ${req.description}`,
      timestamp: Math.floor(now / 1000),
      expirySecs: req.expirySecs,
      payeeNodeId: simNodeId(receiver),
    });
    const expiresAt = (Math.floor(now / 1000) + req.expirySecs) * 1000;
    this.holds.set(key, {
      receiver,
      payer: null,
      amountSats: req.amountSats,
      paymentHash: req.paymentHash,
      invoice,
      state: "open",
      invoiceExpiresAt: expiresAt,
      settleDeadline: null,
      resolve: null,
      plain: false,
      preimage: null,
    });
    this.record(receiver, { at: now, direction: "in", amountSats: req.amountSats, paymentHash: req.paymentHash, state: "pending", description: `[${SIM_LABEL}] ${req.description}` });
    return { invoice, paymentHash: req.paymentHash, expiresAt };
  }

  private plainCount = 0;

  /** Plan B: a regular invoice. The receiving wallet picks the preimage (deterministic here). */
  makePlain(receiver: string, req: { amountSats: number; description: string; expirySecs: number }): MadeInvoice {
    const preimage = bytesToHex(sha256(new TextEncoder().encode(`sim-preimage:${receiver}:${++this.plainCount}`)));
    const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
    const made = this.makeHold(receiver, { ...req, paymentHash });
    const h = this.holds.get(`${receiver}:${paymentHash}`)!;
    h.plain = true;
    h.preimage = preimage;
    return made;
  }

  pay(payer: string, invoice: string): Promise<PayOutcome> {
    this.tick();
    let hash: string;
    try {
      const d = decode(invoice);
      hash = String(d.sections.find((s) => s.name === "payment_hash")?.value ?? "");
    } catch {
      return Promise.resolve({ status: "failed", error: "undecodable invoice" });
    }
    const h = [...this.holds.values()].find((x) => x.paymentHash === hash && x.invoice === invoice);
    if (!h) return Promise.resolve({ status: "failed", error: "unknown invoice" });
    if (h.state !== "open") return Promise.resolve({ status: "failed", error: `invoice is ${h.state}` });
    if (h.receiver === payer) return Promise.resolve({ status: "failed", error: "self-payment" });
    const bal = this.balance(payer);
    if (bal < h.amountSats) return Promise.resolve({ status: "failed", error: "insufficient balance" });
    const b = this.budgets.get(payer);
    if (b && b.usedSats + h.amountSats > b.totalSats) return Promise.resolve({ status: "failed", error: "wallet budget exceeded" });
    const now = this.clock();
    if (h.plain) {
      // Regular invoice: the sats move at once.
      this.balances.set(payer, bal - h.amountSats);
      this.balances.set(h.receiver, this.balance(h.receiver) + h.amountSats);
      if (b) b.usedSats += h.amountSats;
      h.payer = payer;
      h.state = "settled";
      this.updateTx(h.receiver, hash, "settled");
      this.record(payer, { at: now, direction: "out", amountSats: h.amountSats, paymentHash: hash, state: "settled", description: `[${SIM_LABEL}] payment` });
      return Promise.resolve({ status: "settled", preimage: h.preimage ?? undefined });
    }
    // Lock: the sats leave the payer and sit in the HTLC (accepted hold).
    this.balances.set(payer, bal - h.amountSats);
    if (b) b.usedSats += h.amountSats;
    h.payer = payer;
    h.state = "accepted";
    h.settleDeadline = now + this.holdMaxSecs * 1000;
    this.updateTx(h.receiver, hash, "held");
    this.record(payer, { at: now, direction: "out", amountSats: h.amountSats, paymentHash: hash, state: "held", description: `[${SIM_LABEL}] hold` });
    return new Promise((resolve) => (h.resolve = resolve));
  }

  settle(receiver: string, preimage: string): void {
    this.tick();
    if (!/^[0-9a-f]{64}$/.test(preimage)) throw new Error("preimage must be 32-byte hex");
    const hash = bytesToHex(sha256(hexToBytes(preimage)));
    const h = this.holds.get(`${receiver}:${hash}`);
    if (!h) throw new Error("no hold invoice for this preimage");
    if (h.plain || h.state !== "accepted") throw new Error(`cannot settle a hold in state ${h.state}`);
    h.state = "settled";
    this.balances.set(receiver, this.balance(receiver) + h.amountSats);
    this.updateTx(receiver, hash, "settled");
    if (h.payer) this.updateTx(h.payer, hash, "settled");
    h.resolve?.({ status: "settled", preimage });
  }

  cancel(receiver: string, hash: string): void {
    const h = this.holds.get(`${receiver}:${hash}`);
    if (!h) throw new Error("no hold invoice for this hash");
    if (h.state === "accepted") this.refund(h, "cancelled");
    else if (h.state === "open") {
      h.state = "cancelled";
      this.updateTx(receiver, hash, "failed");
    } else throw new Error(`cannot cancel a hold in state ${h.state}`);
  }

  private refund(h: Hold, to: "cancelled" | "expired") {
    h.state = to;
    if (h.payer) {
      this.balances.set(h.payer, this.balance(h.payer) + h.amountSats);
      const b = this.budgets.get(h.payer);
      if (b) b.usedSats = Math.max(0, b.usedSats - h.amountSats);
      this.updateTx(h.payer, h.paymentHash, "refunded");
    }
    this.updateTx(h.receiver, h.paymentHash, "refunded");
    h.resolve?.({ status: "refunded" });
  }

  /** Expire unpaid invoices and time out accepted holds past their settle deadline. */
  tick(): void {
    const now = this.clock();
    for (const h of this.holds.values()) {
      if (h.state === "open" && now >= h.invoiceExpiresAt) {
        h.state = "expired";
        this.updateTx(h.receiver, h.paymentHash, "failed");
      } else if (h.state === "accepted" && h.settleDeadline !== null && now >= h.settleDeadline) this.refund(h, "expired");
    }
  }

  lookup(receiver: string, hash: string) {
    this.tick();
    const h = this.holds.get(`${receiver}:${hash}`);
    if (!h) throw new Error("no hold invoice for this hash");
    return { state: h.state, amountSats: h.amountSats, settleDeadline: h.settleDeadline ?? undefined };
  }
}

const SIM_METHODS = ["get_info", "get_balance", "get_budget", "pay_invoice", "make_invoice", "make_hold_invoice", "settle_hold_invoice", "cancel_hold_invoice", "lookup_invoice", "list_transactions"];

export class SimBackend implements LightningBackend {
  readonly kind = "sim" as const;
  readonly simulated = true;
  readonly network = "regtest" as const;
  readonly payeeProof = "sim_n_tag" as const;
  constructor(readonly ledger: SimLedger) {}

  private info(id: string): WalletInfo {
    return { pubkey: simNodeId(id), methods: SIM_METHODS, network: "regtest" };
  }

  payer(id: string): PayerWallet {
    const l = this.ledger;
    return {
      getInfo: async () => this.info(id),
      getBalance: async () => l.balance(id),
      getBudget: async () => l.budget(id),
      payInvoice: (invoice) => l.pay(id, invoice),
      listTransactions: async () => l.transactions(id),
    };
  }

  receiver(id: string): ReceiverWallet {
    const l = this.ledger;
    return {
      getInfo: async () => this.info(id),
      getBalance: async () => l.balance(id),
      makeHoldInvoice: async (req) => l.makeHold(id, req),
      makeInvoice: async (req) => l.makePlain(id, req),
      settleHoldInvoice: async (preimage) => l.settle(id, preimage),
      cancelHoldInvoice: async (hash) => l.cancel(id, hash),
      lookupInvoice: async (hash) => l.lookup(id, hash),
      listTransactions: async () => l.transactions(id),
    };
  }
}
