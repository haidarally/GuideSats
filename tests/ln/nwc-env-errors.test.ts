// A connection string that cannot be parsed must never come back in an error: not in the message, not in
// a property (Node's URL errors keep the whole input), not in the stack. Offline: the string is FAKE and
// malformed, so the SDK fails while parsing it, before any relay is contacted.
import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { nwcBackendFromEnv, requireNwcEnv } from "../../src/ln/nwc";

const SCHEME = "nostr+wallet" + "connect://";
const FAKE_SECRET = "cd".repeat(32);
const FAKE_WALLET = "ab".repeat(32);
/** A space in the host: the SDK's `new URL` throws on it. */
const MALFORMED = `${SCHEME}${FAKE_WALLET} x?relay=wss://relay.example.invalid&secret=${FAKE_SECRET}`;

const shown = (e: unknown) => `${inspect(e, { depth: 8 })}\n${e instanceof Error ? e.stack : ""}`;

describe("NWC env errors never echo a value", () => {
  it("a malformed connection string fails naming the env key only", async () => {
    for (const key of ["NWC_TRAVELLER_URL", "NWC_GUIDE_URL"] as const) {
      const env = { NWC_TRAVELLER_URL: `${SCHEME}${"ef".repeat(32)}?relay=wss://relay.example.invalid&secret=${"01".repeat(32)}`, NWC_GUIDE_URL: `${SCHEME}${"ef".repeat(32)}?relay=wss://relay.example.invalid&secret=${"01".repeat(32)}`, NWC_NETWORK: "mainnet", [key]: MALFORMED };
      const err = await nwcBackendFromEnv(env, { traveller: "traveller", guide: "guide" }).then(
        (b) => {
          b.close();
          return null;
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(key);
      expect(shown(err)).not.toContain(FAKE_SECRET);
      expect(shown(err)).not.toContain(FAKE_WALLET);
    }
  });

  it("an unknown network is refused without echoing what was there (here a connection string pasted into NWC_NETWORK)", () => {
    const ok = `${SCHEME}${"ef".repeat(32)}?relay=wss://relay.example.invalid&secret=${"01".repeat(32)}`;
    let err: unknown;
    try {
      requireNwcEnv({ NWC_TRAVELLER_URL: ok, NWC_GUIDE_URL: ok, NWC_NETWORK: MALFORMED });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(shown(err)).not.toContain(FAKE_SECRET);
    expect((err as Error).message).toContain("NWC_NETWORK");
  });
});
