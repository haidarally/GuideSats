import { defineConfig } from "@playwright/test";

const PORT = 8797;
// Optional: point at an already-installed Chromium (e.g. PW_EXECUTABLE_PATH=/path/to/chrome-headless-shell).
const executablePath = process.env.PW_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "line",
  use: { baseURL: `http://127.0.0.1:${PORT}`, launchOptions: { executablePath }, screenshot: "only-on-failure" },
  projects: [
    { name: "360-en", use: { viewport: { width: 360, height: 780 }, locale: "en-GB" } },
    { name: "412-fr", use: { viewport: { width: 412, height: 860 }, locale: "fr-FR" } },
  ],
  webServer: { command: `PORT=${PORT} npm run demo`, url: `http://127.0.0.1:${PORT}/api/state`, reuseExistingServer: false, timeout: 60_000 },
});
