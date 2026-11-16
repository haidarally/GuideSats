// The real-wallet entry points must refuse to run without .env values. Run from an empty temp
// dir with a cleared environment, so this test can never reach a real wallet.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Runs one of the opt-in NWC entry points from an empty temp dir with a cleared environment (and `dotEnv` as its .env). */
function runEmpty(args: string[], dotEnv?: string) {
  const dir = mkdtempSync(join(tmpdir(), "guidesats-e2e-"));
  try {
    if (dotEnv !== undefined) writeFileSync(join(dir, ".env"), dotEnv);
    return spawnSync(join(root, "node_modules/.bin/tsx"), args, { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 20_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the opt-in NWC entry points refuse without a .env file", () => {
  it("npm run e2e:nwc", () => {
    const r = runEmpty([join(root, "scripts/e2e-nwc.ts")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("e2e:nwc refused: no .env file");
  });
  it("npm run e2e:nwc-app", () => {
    const r = runEmpty([join(root, "scripts/e2e-nwc-app.ts")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("e2e:nwc-app refused: no .env file");
  });
  it("npm run demo:nwc (main.ts --nwc)", () => {
    const r = runEmpty([join(root, "src/server/main.ts"), "--nwc"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("demo:nwc refused: no .env file");
  });
});

// A FAKE connection string with a typo the SDK cannot parse (a space in the host). Node's URL error keeps the
// whole input, secret included; uncaught, it would be printed. Nothing here can reach a wallet: parsing fails
// before any relay is contacted, and the relay host does not exist.
const FAKE_SECRET = "cd".repeat(32);
const FAKE_WALLET = "ab".repeat(32);
const SCHEME = "nostr+wallet" + "connect://";
const typo = `"${SCHEME}${FAKE_WALLET} x?relay=wss://relay.example.invalid&secret=${FAKE_SECRET}"`;
const MALFORMED_ENV = `NWC_TRAVELLER_URL=${typo}\nNWC_GUIDE_URL=${typo}\nNWC_NETWORK=mainnet\n`;

describe("the opt-in NWC entry points never print a connection string they cannot parse", () => {
  for (const [name, args] of [
    ["npm run e2e:nwc", [join(root, "scripts/e2e-nwc.ts")]],
    ["npm run e2e:nwc-app", [join(root, "scripts/e2e-nwc-app.ts")]],
    ["npm run demo:nwc (main.ts --nwc)", [join(root, "src/server/main.ts"), "--nwc"]],
  ] as const) {
    it(name, () => {
      const r = runEmpty([...args], MALFORMED_ENV);
      expect(r.status).not.toBe(0);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain("NWC_TRAVELLER_URL is not a valid NWC connection string");
      expect(out).not.toContain(FAKE_SECRET);
      expect(out).not.toContain(FAKE_WALLET);
    });
  }
});
