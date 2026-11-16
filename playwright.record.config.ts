// `npm run record:nwc`: records the demo video at phone size, slowed down so a viewer can follow.
// Not part of `npm run test:e2e`. Two clips (one per test): flow (a) lock and settle, flow (b) the overspend
// push refused, a lock, and the refund on the synthetic cyclone replay. The videos (.webm) and each clip's
// step times (marks.json, for the shot list) land in test-results/record/ (git-ignored).
//   RECORD_BACKEND=sim  records against the simulator instead: a dry run, no wallets.
//   PW_EXECUTABLE_PATH  as in playwright.config.ts.
import { defineConfig } from "@playwright/test";

const PORT = 8798;
const SIM = process.env.RECORD_BACKEND === "sim";
const executablePath = process.env.PW_EXECUTABLE_PATH || undefined;
// The screencast is captured at CSS pixels, so the page is drawn at 2x: an 824 x 1832 window whose page is
// zoomed 2x (tests/record/demo.spec.ts) keeps the 412 px phone layout at double density in the video.
const viewport = { width: 824, height: 1832 }; // even dimensions: video encoders want them

export default defineConfig({
  testDir: "tests/record",
  outputDir: "test-results/record",
  timeout: 5 * 60_000,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport,
    locale: "en-GB",
    colorScheme: "light",
    launchOptions: { executablePath, slowMo: 250 },
    video: { mode: "on", size: viewport },
  },
  webServer: {
    command: `PORT=${PORT} npm run ${SIM ? "demo" : "demo:nwc"}`,
    url: `http://127.0.0.1:${PORT}/api/state`,
    reuseExistingServer: false,
    timeout: 120_000,
    // SIGTERM, not a kill: over NWC the server first cancels any hold still open at the guide's wallet.
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
  },
});
