// BOLT11 helpers that light-bolt11-decoder does not provide:
//  1. payee recovery from the invoice signature (real invoices), using @noble/curves;
//  2. an encoder for SIMULATED invoices (regtest prefix, zero signature, explicit `n` tag).
// The simulator never holds a private key: its invoices carry no valid signature,
// so they can never be paid by a real Lightning wallet.
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type Network = "mainnet" | "testnet" | "signet" | "regtest";

/** BOLT11 human-readable prefix per network (after "ln"). */
export const NETWORK_PREFIX: Record<Network, string> = {
  mainnet: "bc",
  testnet: "tb",
  signet: "tbs",
  regtest: "bcrt",
};

const SIG_WORDS = 104; // 520 bits = 64-byte signature + 1 recovery byte

/** Convert 5-bit words to bytes, padding the last byte with zero bits (BOLT11 signing rule). */
export function wordsToBytesPadded(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

/** Convert bytes to 5-bit words, padding the end with zero bits. */
export function bytesToWords(bytes: Uint8Array): number[] {
  return bech32.toWords(bytes);
}

function intToWords(value: number, length: number): number[] {
  const words = new Array<number>(length).fill(0);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    words[i] = v % 32;
    v = Math.floor(v / 32);
  }
  return words;
}

function minimalIntWords(value: number): number[] {
  if (value === 0) return [0];
  const words: number[] = [];
  let v = value;
  while (v > 0) {
    words.unshift(v % 32);
    v = Math.floor(v / 32);
  }
  return words;
}

function tag(code: number, data: number[]): number[] {
  return [code, ...intToWords(data.length, 2), ...data];
}

/**
 * Recover the payee node pubkey (33-byte compressed, hex) from a BOLT11 signature.
 * Returns null if the signature does not recover (e.g. a SIMULATED zero signature).
 */
export function recoverPayee(paymentRequest: string): string | null {
  try {
    const { prefix, words } = bech32.decode(paymentRequest.toLowerCase() as `${string}1${string}`, Number.MAX_SAFE_INTEGER);
    if (words.length <= SIG_WORDS) return null;
    const dataWords = words.slice(0, -SIG_WORDS);
    const sigBytes = bech32.fromWordsUnsafe(words.slice(-SIG_WORDS));
    if (!sigBytes || sigBytes.length !== 65) return null;
    const recovery = sigBytes[64]!;
    if (recovery > 3) return null;
    const hrp = new TextEncoder().encode(prefix);
    const data = wordsToBytesPadded(dataWords);
    const msg = new Uint8Array(hrp.length + data.length);
    msg.set(hrp, 0);
    msg.set(data, hrp.length);
    const digest = sha256(msg);
    const sig = secp256k1.Signature.fromBytes(sigBytes.slice(0, 64), "compact").addRecoveryBit(recovery);
    return bytesToHex(sig.recoverPublicKey(digest).toBytes(true));
  } catch {
    return null;
  }
}

export interface SimInvoiceParams {
  network: Network;
  amountSats: number;
  paymentHash: string; // 32-byte hex
  description: string;
  timestamp: number; // unix seconds
  expirySecs: number;
  payeeNodeId: string; // 33-byte hex identifier (simulated, no private key exists)
}

/** Encode a SIMULATED BOLT11 invoice: valid structure, zero signature, explicit payee (`n`) tag. */
export function encodeSimInvoice(p: SimInvoiceParams): string {
  if (!Number.isSafeInteger(p.amountSats) || p.amountSats <= 0) throw new Error("amountSats must be a positive integer");
  if (!/^[0-9a-f]{64}$/.test(p.paymentHash)) throw new Error("paymentHash must be 32-byte hex");
  if (!/^0[23][0-9a-f]{64}$/.test(p.payeeNodeId)) throw new Error("payeeNodeId must be 33-byte compressed hex");
  // 1 sat = 10 nano-BTC, so "<sats*10>n" is exact.
  const hrp = `ln${NETWORK_PREFIX[p.network]}${p.amountSats * 10}n`;
  const enc = new TextEncoder();
  const words: number[] = [
    ...intToWords(p.timestamp, 7),
    ...tag(1, bytesToWords(hexToBytes(p.paymentHash))), // p
    ...tag(13, bytesToWords(enc.encode(p.description))), // d
    ...tag(6, minimalIntWords(p.expirySecs)), // x
    ...tag(19, bytesToWords(hexToBytes(p.payeeNodeId))), // n
    ...new Array<number>(SIG_WORDS).fill(0), // zero signature: SIMULATED, unpayable on a real network
  ];
  return bech32.encode(hrp, words, Number.MAX_SAFE_INTEGER);
}
