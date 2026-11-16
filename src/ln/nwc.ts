// Nostr Wallet Connect adapter (NIP-47 + the NWC-03 hold-invoice extension) on @getalby/sdk.
// Unit-tested with a fake client, and run by the opt-in `npm run e2e:nwc` against Alby's
// NWC Faucet test wallets (hold methods present, one hold settled, one cancelled and refunded).
//
// Least privilege: the traveller's connection should allow only pay_invoice (+ get_budget,
// get_balance); the guide's only make/settle/cancel_hold_invoice + lookup_invoice.
// Connection strings come from env vars (see .env.example) and are never logged.
import type { Network } from "./bolt11";
import {
  HOLD_METHODS,
  HoldsUnsupportedError,
  type Budget,
  type HoldState,
  type LightningBackend,
  type PayerWallet,
  type PayOutcome,
  type ReceiverWallet,
  type TxRecord,
  type WalletInfo,
} from "./backend";

/** The subset of @getalby/sdk's NWCClient this adapter uses (amounts in msat). */
export interface NwcClientLike {
  getInfo(): Promise<{ pubkey: string; network: string; methods: string[]; block_height?: number }>;
  getBudget(): Promise<{ used_budget: number; total_budget: number; renewal_period: string } | Record<string, never>>;
  getBalance(): Promise<{ balance: number }>;
  payInvoice(req: { invoice: string }): Promise<{ preimage: string; fees_paid: number }>;
  makeHoldInvoice(req: { amount: number; payment_hash: string; description?: string; expiry?: number }): Promise<NwcTx>;
  makeInvoice(req: { amount: number; description?: string; expiry?: number }): Promise<NwcTx>;
  settleHoldInvoice(req: { preimage: string }): Promise<unknown>;
  cancelHoldInvoice(req: { payment_hash: string }): Promise<unknown>;
  lookupInvoice(req: { payment_hash: string }): Promise<NwcTx>;
  listTransactions(req: { limit?: number }): Promise<{ transactions: NwcTx[] }>;
  close(): void;
}

export interface NwcTx {
  type: "incoming" | "outgoing";
  state: "settled" | "pending" | "failed" | "accepted";
  invoice: string;
  description: string;
  payment_hash: string;
  amount: number; // msat
  created_at: number; // unix seconds
  expires_at: number; // unix seconds
  settle_deadline?: number; // a block height on the faucet wallets (24 blocks ahead); unix seconds if >= 500 000 000
}

const NETWORKS: Record<string, Network> = { mainnet: "mainnet", bitcoin: "mainnet", testnet: "testnet", signet: "signet", regtest: "regtest" };

export function parseNetwork(s: string | undefined): Network {
  const n = NETWORKS[(s ?? "").trim().toLowerCase()];
  if (!n) throw new Error(`unknown network: ${JSON.stringify(s ?? "")}`);
  return n;
}

const msatToSats = (msat: number) => Math.floor(msat / 1000);

function mapTx(t: NwcTx, now: number): TxRecord {
  const state: TxRecord["state"] =
    t.state === "settled" ? "settled" : t.state === "accepted" ? "held" : t.state === "failed" ? "failed" : t.expires_at * 1000 < now ? "failed" : "pending";
  return { at: t.created_at * 1000, direction: t.type === "incoming" ? "in" : "out", amountSats: msatToSats(t.amount), paymentHash: t.payment_hash, state, description: t.description ?? "" };
}

export function mapHoldState(t: NwcTx, now: number): HoldState {
  if (t.state === "accepted") return "accepted";
  if (t.state === "settled") return "settled";
  if (t.state === "failed") return "cancelled";
  return t.expires_at * 1000 < now ? "expired" : "open";
}

/** The hold-method gate: the guide's wallet must list the three hold methods. */
export function assertHoldSupport(info: { methods: string[] }): void {
  const missing = HOLD_METHODS.filter((m) => !info.methods.includes(m));
  if (missing.length > 0) throw new HoldsUnsupportedError(missing);
}

function errorCode(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; name?: unknown };
    if (typeof o.code === "string") return o.code;
    if (typeof o.name === "string") return o.name;
  }
  return "ERROR";
}

/**
 * NIP-47 error codes with which the WALLET says it refused the payment: nothing left it, so the
 * mandate's single use may be given back. Everything else (INTERNAL, OTHER, timeouts, relay or
 * socket errors, anything we cannot classify) is "unknown": the payment may be in flight, so the
 * mandate stays reserved (fail closed).
 */
const DEFINITE_FAILURES = new Set(["PAYMENT_FAILED", "INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "RATE_LIMITED", "NOT_IMPLEMENTED", "NOT_FOUND"]);

export class NwcBackend implements LightningBackend {
  readonly kind = "nwc" as const;
  readonly simulated = false;
  readonly payeeProof = "signature" as const;

  constructor(
    readonly network: Network,
    private readonly clients: Record<string, NwcClientLike>, // walletId -> client
    private readonly clock: () => number = Date.now,
  ) {}

  private client(id: string): NwcClientLike {
    const c = this.clients[id];
    if (!c) throw new Error(`no NWC connection configured for wallet "${id}"`);
    return c;
  }

  private async info(id: string): Promise<WalletInfo> {
    const i = await this.client(id).getInfo();
    const net = parseNetwork(i.network);
    if (net !== this.network) throw new Error(`wallet "${id}" is on ${net}, expected ${this.network}`);
    return { pubkey: i.pubkey, methods: [...i.methods], network: net, blockHeight: typeof i.block_height === "number" ? i.block_height : undefined };
  }

  payer(id: string): PayerWallet {
    return {
      getInfo: () => this.info(id),
      getBalance: async () => msatToSats((await this.client(id).getBalance()).balance),
      getBudget: async (): Promise<Budget | null> => {
        try {
          const b = await this.client(id).getBudget();
          if (!("total_budget" in b)) return null;
          return { totalSats: msatToSats(b.total_budget), usedSats: msatToSats(b.used_budget), renewal: b.renewal_period };
        } catch {
          return null; // wallet does not offer get_budget (NWC-13 is optional)
        }
      },
      payInvoice: async (invoice): Promise<PayOutcome> => {
        try {
          const r = await this.client(id).payInvoice({ invoice });
          return { status: "settled", preimage: r.preimage };
        } catch (e) {
          const code = errorCode(e);
          return DEFINITE_FAILURES.has(code) ? { status: "failed", error: code } : { status: "unknown", error: code };
        }
      },
      listTransactions: async () => (await this.client(id).listTransactions({ limit: 20 })).transactions.map((t) => mapTx(t, this.clock())),
    };
  }

  receiver(id: string): ReceiverWallet {
    return {
      getInfo: () => this.info(id),
      getBalance: async () => msatToSats((await this.client(id).getBalance()).balance),
      makeHoldInvoice: async (req) => {
        assertHoldSupport(await this.info(id));
        const t = await this.client(id).makeHoldInvoice({ amount: req.amountSats * 1000, payment_hash: req.paymentHash, description: req.description, expiry: req.expirySecs });
        if (t.payment_hash !== req.paymentHash) throw new Error("wallet returned a hold invoice for a different hash");
        return { invoice: t.invoice, paymentHash: t.payment_hash, expiresAt: t.expires_at * 1000 };
      },
      makeInvoice: async (req) => {
        const t = await this.client(id).makeInvoice({ amount: req.amountSats * 1000, description: req.description, expiry: req.expirySecs });
        return { invoice: t.invoice, paymentHash: t.payment_hash, expiresAt: t.expires_at * 1000 };
      },
      settleHoldInvoice: async (preimage) => {
        await this.client(id).settleHoldInvoice({ preimage });
      },
      cancelHoldInvoice: async (paymentHash) => {
        await this.client(id).cancelHoldInvoice({ payment_hash: paymentHash });
      },
      lookupInvoice: async (paymentHash) => {
        const t = await this.client(id).lookupInvoice({ payment_hash: paymentHash });
        return { state: mapHoldState(t, this.clock()), amountSats: msatToSats(t.amount), settleDeadline: t.settle_deadline };
      },
      listTransactions: async () => (await this.client(id).listTransactions({ limit: 20 })).transactions.map((t) => mapTx(t, this.clock())),
    };
  }

  close(): void {
    for (const c of Object.values(this.clients)) c.close();
  }
}

export interface NwcEnv {
  NWC_TRAVELLER_URL?: string;
  NWC_GUIDE_URL?: string;
  NWC_NETWORK?: string;
}

/** Throws (without echoing any value) unless both connection strings and the network are set. */
export function requireNwcEnv(env: NwcEnv): { traveller: string; guide: string; network: Network } {
  const missing = (["NWC_TRAVELLER_URL", "NWC_GUIDE_URL", "NWC_NETWORK"] as const).filter((k) => !(env[k] ?? "").trim());
  if (missing.length > 0) throw new Error(`missing env: ${missing.join(", ")} (see .env.example)`);
  for (const k of ["NWC_TRAVELLER_URL", "NWC_GUIDE_URL"] as const) {
    if (!env[k]!.startsWith("nostr+walletconnect://")) throw new Error(`${k} is not a nostr+walletconnect:// URL`);
  }
  return { traveller: env.NWC_TRAVELLER_URL!, guide: env.NWC_GUIDE_URL!, network: parseNetwork(env.NWC_NETWORK) };
}

/** Builds the real backend. The SDK is imported lazily so tests and the demo never load it. */
export async function nwcBackendFromEnv(env: NwcEnv, walletIds: { traveller: string; guide: string }): Promise<NwcBackend> {
  const cfg = requireNwcEnv(env);
  const { NWCClient } = await import("@getalby/sdk/nwc");
  const mk = (url: string) => new NWCClient({ nostrWalletConnectUrl: url }) as unknown as NwcClientLike;
  return new NwcBackend(cfg.network, { [walletIds.traveller]: mk(cfg.traveller), [walletIds.guide]: mk(cfg.guide) });
}
