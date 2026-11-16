// The Lightning boundary. Two adapters implement it:
//   sim.ts : in-process, deterministic, every value labelled SIMULATED (demo + tests + CI)
//   nwc.ts : Nostr Wallet Connect via @getalby/sdk (real wallets, opt-in, needs .env)
// The rest of the app only sees these interfaces.
import type { Network } from "./bolt11";
import type { PayeeProof } from "./invoiceCheck";

export type HoldState = "open" | "accepted" | "settled" | "cancelled" | "expired";

export interface WalletInfo {
  pubkey: string; // Lightning node key that signs this wallet's invoices
  methods: string[];
  network: Network;
  blockHeight?: number; // the wallet's chain tip (NWC get_info block_height), when it reports one
}

export interface Budget {
  totalSats: number;
  usedSats: number;
  renewal: string;
}

export interface TxRecord {
  at: number; // ms epoch
  direction: "in" | "out";
  amountSats: number;
  paymentHash: string;
  state: "pending" | "held" | "settled" | "refunded" | "failed";
  description: string;
}

export interface HoldInvoiceRequest {
  amountSats: number;
  paymentHash: string;
  description: string;
  expirySecs: number;
}

export interface MadeInvoice {
  invoice: string;
  paymentHash: string;
  expiresAt: number; // ms epoch
}

export type PayOutcome =
  | { status: "settled"; preimage?: string }
  | { status: "refunded" }
  | { status: "failed"; error: string } // definite: nothing left the wallet (or it came back)
  | { status: "unknown"; error: string }; // e.g. a reply timeout: the payment may still be in flight

export interface PayerWallet {
  getInfo(): Promise<WalletInfo>;
  getBalance(): Promise<number>; // sats
  getBudget(): Promise<Budget | null>; // null when the wallet offers none
  /**
   * Starts a payment. For a hold invoice the promise settles only when the guide settles
   * or cancels, so callers must not await it to learn that funds are locked; they ask
   * the receiver (lookupInvoice) instead.
   */
  payInvoice(invoice: string): Promise<PayOutcome>;
  listTransactions(): Promise<TxRecord[]>;
}

export interface ReceiverWallet {
  getInfo(): Promise<WalletInfo>;
  getBalance(): Promise<number>;
  makeHoldInvoice(req: HoldInvoiceRequest): Promise<MadeInvoice>;
  /** Plan B (wallets without hold invoices): a regular invoice; the wallet picks the hash. */
  makeInvoice(req: { amountSats: number; description: string; expirySecs: number }): Promise<MadeInvoice>;
  settleHoldInvoice(preimage: string): Promise<void>;
  cancelHoldInvoice(paymentHash: string): Promise<void>;
  /** settleDeadline: as the wallet reports it, a block height or unix seconds (see domain/holdLimit.ts). */
  lookupInvoice(paymentHash: string): Promise<{ state: HoldState; amountSats: number; settleDeadline?: number }>;
  listTransactions(): Promise<TxRecord[]>;
}

export interface LightningBackend {
  readonly kind: "sim" | "nwc";
  readonly simulated: boolean;
  readonly network: Network;
  readonly payeeProof: PayeeProof;
  payer(walletId: string): PayerWallet;
  receiver(walletId: string): ReceiverWallet;
}

export const HOLD_METHODS = ["make_hold_invoice", "settle_hold_invoice", "cancel_hold_invoice"] as const;

export class HoldsUnsupportedError extends Error {
  constructor(readonly missing: string[]) {
    super(`wallet does not support hold invoices (missing: ${missing.join(", ")})`);
    this.name = "HoldsUnsupportedError";
  }
}
