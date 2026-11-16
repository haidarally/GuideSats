// The real-wallet entry points must refuse to run without .env values. Run from an empty temp
// dir with a cleared environment, so this test can never reach a real wallet.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Runs one of the opt-in NWC entry points from an empty temp dir with a cleared environment. */
function runEmpty(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "guidesats-e2e-"));
  try {
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
