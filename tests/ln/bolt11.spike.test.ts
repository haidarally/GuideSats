import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decode } from "light-bolt11-decoder";
import { encodeSimInvoice, recoverPayee } from "../../src/ln/bolt11";

const spec2 = readFileSync(new URL("../../fixtures/bolt11/spec-example-2.txt", import.meta.url), "utf8").trim();

describe("spike", () => {
  it("recovers spec example 2 payee", () => {
    expect(recoverPayee(spec2)).toBe("03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad");
  });
  it("round-trips a sim invoice", () => {
    const inv = encodeSimInvoice({ network: "regtest", amountSats: 21000, paymentHash: "ab".repeat(32), description: "Le Morne hike", timestamp: 1763236800, expirySecs: 43200, payeeNodeId: "02" + "11".repeat(32) });
    const d = decode(inv) as any;
    const get = (n: string) => d.sections.find((s: any) => s.name === n)?.value;
    console.log(inv.slice(0, 20), get("amount"), get("coin_network")?.bech32, d.expiry, get("payee"), get("payment_hash"), get("description"), get("timestamp"));
    expect(get("amount")).toBe("21000000");
    expect(recoverPayee(inv)).toBe(null);
  });
  it("loads node:sqlite", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("create table t(x)");
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 });
  });
});
