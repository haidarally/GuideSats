// The real-wallet script must refuse to run without .env values. Run from an empty temp
// dir with a cleared environment, so this test can never reach a real wallet.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("npm run e2e:nwc", () => {
  it("refuses without a .env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "guidesats-e2e-"));
    try {
      const r = spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "scripts/e2e-nwc.ts")], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("e2e:nwc refused: no .env file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
