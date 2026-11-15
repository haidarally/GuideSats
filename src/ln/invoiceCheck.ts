// Every invoice is decoded and checked BEFORE any payment: network, exact amount,
// payment hash (must equal the H the traveller approved), expiry, and payee.
// Decoding uses light-bolt11-decoder; payee recovery uses @noble/curves (see bolt11.ts).
import { decode } from "light-bolt11-decoder";
import { NETWORK_PREFIX, recoverPayee, type Network } from "./bolt11";

export type PayeeProof = "signature" | "sim_n_tag";

export interface InvoiceExpectation {
  network: Network;
  amountSats: number; // exact amount expected
  paymentHash: string;
  payeePubkey: string;
  now: number; // ms epoch
  minSecondsLeft?: number; // refuse invoices that expire sooner than this (default 60)
  /**
   * "signature": the payee is the key recovered from the invoice signature (real wallets).
   * "sim_n_tag": trust the explicit `n` tag. Allowed ONLY on regtest (the simulator).
   */
  payeeProof: PayeeProof;
}

export type InvoiceRefusal =
  | "undecodable"
  | "wrong_network"
  | "no_amount"
  | "wrong_amount"
  | "wrong_hash"
  | "expired"
  | "unverifiable_payee"
  | "payee_signature_mismatch"
  | "wrong_payee";

export interface CheckedInvoice {
  network: Network;
  amountSats: number;
  paymentHash: string;
  payeePubkey: string;
  timestamp: number; // unix seconds
  expiresAt: number; // ms epoch
  description: string;
}

export type InvoiceCheckResult = { ok: true; invoice: CheckedInvoice } | { ok: false; reason: InvoiceRefusal };

interface Section {
  name: string;
  value?: unknown;
}

export function checkInvoice(paymentRequest: string, exp: InvoiceExpectation): InvoiceCheckResult {
  let sections: Section[];
  try {
    if (typeof paymentRequest !== "string" || paymentRequest.length > 4096) return { ok: false, reason: "undecodable" };
    const d = decode(paymentRequest.trim());
    sections = d.sections as Section[];
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  const get = (n: string) => sections.find((s) => s.name === n)?.value;

  const coin = get("coin_network") as { bech32?: string } | undefined;
  if (coin?.bech32 !== NETWORK_PREFIX[exp.network]) return { ok: false, reason: "wrong_network" };

  const msat = get("amount");
  if (typeof msat !== "string" || !/^\d+$/.test(msat)) return { ok: false, reason: "no_amount" };
  const msatBig = BigInt(msat);
  if (msatBig % 1000n !== 0n) return { ok: false, reason: "wrong_amount" };
  if (msatBig / 1000n !== BigInt(exp.amountSats)) return { ok: false, reason: "wrong_amount" };

  const hash = get("payment_hash");
  if (typeof hash !== "string" || hash.toLowerCase() !== exp.paymentHash.toLowerCase()) return { ok: false, reason: "wrong_hash" };

  const timestamp = get("timestamp");
  if (typeof timestamp !== "number") return { ok: false, reason: "undecodable" };
  // Note: light-bolt11-decoder's `expiry` field is the relative `x` tag (seconds), not an absolute time.
  const rel = get("expiry");
  const expiresAtSec = timestamp + (typeof rel === "number" ? rel : 3600); // BOLT11 default expiry: 3600 s
  const minLeft = (exp.minSecondsLeft ?? 60) * 1000;
  if (expiresAtSec * 1000 - exp.now < minLeft) return { ok: false, reason: "expired" };

  const nTag = typeof get("payee") === "string" ? (get("payee") as string).toLowerCase() : null;
  let payee: string | null;
  if (exp.payeeProof === "signature") {
    payee = recoverPayee(paymentRequest.trim());
    if (payee === null) return { ok: false, reason: "unverifiable_payee" };
    if (nTag !== null && nTag !== payee) return { ok: false, reason: "payee_signature_mismatch" };
  } else {
    // Fail closed: the n-tag shortcut exists only for the in-process simulator on regtest.
    if (exp.network !== "regtest") return { ok: false, reason: "unverifiable_payee" };
    payee = nTag ?? recoverPayee(paymentRequest.trim());
    if (payee === null) return { ok: false, reason: "unverifiable_payee" };
  }
  if (payee !== exp.payeePubkey.toLowerCase()) return { ok: false, reason: "wrong_payee" };

  const description = typeof get("description") === "string" ? (get("description") as string) : "";
  return {
    ok: true,
    invoice: { network: exp.network, amountSats: exp.amountSats, paymentHash: hash.toLowerCase(), payeePubkey: payee, timestamp, expiresAt: expiresAtSec * 1000, description },
  };
}
