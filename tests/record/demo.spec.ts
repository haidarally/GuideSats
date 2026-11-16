// The demo video, recorded by `npm run record:nwc` (playwright.record.config.ts), not by `npm run test:e2e`.
//   clip 1, flow (a): book, the mandate, approve, the agent locks (hold accepted), the meeting code,
//                     the guide settles and is paid, the traveller's balance
//   clip 2, flow (b): book, approve, the overspend push refused, the agent locks, the synthetic cyclone
//                     replay, the refund
// Each pause holds a key screen for the voice-over. The step times (seconds from the start of the clip)
// go to marks.json next to each video, for the shot list. Over NWC it refuses to start when the
// traveller has under 2 000 sats or the tours cost more than 100 sats together (the default e2e cap).
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

test.describe.configure({ mode: "serial" });

// A 412 x 916 phone at 2x: the window is 824 x 1832 (playwright.record.config.ts) and the page is zoomed 2x.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const zoom = () => document.documentElement && (document.documentElement.style.zoom = "2");
    zoom();
    document.addEventListener("DOMContentLoaded", zoom);
  });
});

interface S {
  simulated: boolean;
  traveller: { balanceSats: number | null };
  guides: { balanceSats: number | null }[];
  tours: { id: string; priceSats: number }[];
}

const sats = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

function clip(page: Page) {
  const t0 = Date.now();
  const marks: { at: number; label: string }[] = [];
  return {
    mark: (label: string) => marks.push({ at: Math.round((Date.now() - t0) / 100) / 10, label }),
    hold: (ms: number) => page.waitForTimeout(ms),
    save: () => writeFileSync(test.info().outputPath("marks.json"), JSON.stringify({ end: Math.round((Date.now() - t0) / 100) / 10, marks }, null, 2)),
  };
}

/** The state, once both balances could be read (a shared wallet service can be slow to answer). */
async function state(page: Page): Promise<S> {
  for (let i = 0; ; i++) {
    const s = (await (await page.request.get("/api/state")).json()) as S;
    if ((s.traveller.balanceSats !== null && s.guides[0]?.balanceSats !== null) || i >= 20) return s;
    await page.waitForTimeout(2000);
  }
}

/** Never let an error banner pass unnoticed in a take. */
const noError = (page: Page) => expect(page.locator(".banner.error")).toHaveCount(0);

async function watchAgentLock(page: Page) {
  // The lock button is on the traveller's card; the console shows the agent's tool calls live.
  await page.getByTestId("ask-agent").click();
  await page.getByTestId("tab-agent").click();
  await expect(page.getByTestId("agent-log")).toContainText("⇢ locked", { timeout: 90_000 });
}

test("clip 1, flow (a): mandate, lock, meeting code, the guide is paid", async ({ page }) => {
  const c = clip(page);
  const s0 = await state(page);
  if (!s0.simulated) {
    expect(s0.traveller.balanceSats ?? 0, "traveller balance under 2 000 sats: stop").toBeGreaterThanOrEqual(2000);
    expect(s0.tours.reduce((a, t) => a + t.priceSats, 0)).toBeLessThanOrEqual(100);
  }
  const tour = s0.tours[0]!;
  await page.goto("/");
  await expect(page.getByTestId(s0.simulated ? "sim-banner" : "nwc-banner")).toBeVisible();
  await expect(page.getByTestId("traveller-balance")).toContainText(sats(s0.traveller.balanceSats ?? 0));
  c.mark("open: backend banner, traveller balance, tours");
  await c.hold(3500);

  await page.getByTestId(`book-${tour.id}`).click();
  const card = page.locator(".card.state-proposed").first();
  await expect(card).toContainText(sats(tour.priceSats));
  c.mark("booked: the draft mandate (cap, guide's key, window, one payment)");
  await c.hold(8000);

  await page.getByTestId("approve").click();
  await expect(page.locator(".card.state-mandated").first()).toBeVisible();
  c.mark("approved: the phone kept the secret, sent only its hash");
  await c.hold(3000);

  await watchAgentLock(page);
  c.mark("agent console: request_invoice, pay_invoice, locked");
  await c.hold(5000);

  await page.getByTestId("tab-traveller").click();
  const code = page.getByTestId("meeting-code");
  await expect(code).toBeVisible();
  await expect(page.locator(".card.state-locked").first()).toBeVisible();
  c.mark("hold accepted: sats locked, the traveller's balance");
  await c.hold(3000);
  await code.scrollIntoViewIfNeeded();
  c.mark("meeting code (QR and text)");
  await c.hold(4500);
  const p = (await code.textContent())!.replace(/\s+/g, "");

  await page.getByTestId("tab-guide").click();
  c.mark("guide: the locked booking");
  await c.hold(2000);
  await page.getByTestId("guide-code").fill(p);
  await page.getByTestId("settle").click();
  await expect(page.locator(".card.state-settled").first()).toBeVisible({ timeout: 60_000 });
  const before = s0.guides[0]?.balanceSats ?? 0;
  await expect(page.getByTestId("guide-balance")).toContainText(sats(before + tour.priceSats), { timeout: 60_000 });
  c.mark("guide paid: booking settled, guide balance up");
  await c.hold(5000);

  await page.getByTestId("tab-traveller").click();
  await expect(page.getByTestId("traveller-balance")).toContainText(sats((s0.traveller.balanceSats ?? 0) - tour.priceSats), { timeout: 60_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  c.mark("traveller: paid to the guide, balance down by the price");
  await c.hold(3500);
  await noError(page);
  c.save();
});

test("clip 2, flow (b): overspend refused, lock, synthetic cyclone replay, refund", async ({ page }) => {
  const c = clip(page);
  const s0 = await state(page);
  if (!s0.simulated) expect(s0.traveller.balanceSats ?? 0, "traveller balance under 2 000 sats: stop").toBeGreaterThanOrEqual(2000);
  const tour = s0.tours[1]!;
  await page.goto("/");
  await expect(page.getByTestId("traveller-balance")).toContainText(sats(s0.traveller.balanceSats ?? 0));
  c.mark("open: the settled booking from clip 1");
  await c.hold(2000);

  await page.getByTestId(`book-${tour.id}`).click();
  await expect(page.locator(".card.state-proposed").first()).toContainText(sats(tour.priceSats));
  c.mark("another booking: its mandate");
  await c.hold(3000);
  await page.getByTestId("approve").click();
  await expect(page.locator(".card.state-mandated").first()).toBeVisible();
  c.mark("approved");
  await c.hold(1500);

  await page.getByTestId("tab-agent").click();
  await page.getByTestId("attack").click();
  const log = page.getByTestId("agent-log");
  await expect(log).toContainText("all_refused_by_the_mandate");
  await expect(log).toContainText("invoice_wrong_amount");
  await expect(log).toContainText("invoice_wrong_payee");
  c.mark("overspend push: four refusals in the agent console");
  await c.hold(8000);

  await page.getByTestId("tab-traveller").click();
  await watchAgentLock(page);
  c.mark("the legitimate lock goes through");
  await c.hold(2500);
  await page.getByTestId("tab-traveller").click();
  await expect(page.locator(".card.state-locked").first()).toBeVisible();
  c.mark("sats locked for the second tour");
  await c.hold(3000);

  await page.getByTestId("tab-agent").click();
  await page.getByTestId("cyclone").click();
  await expect(page.getByTestId("cyclone-banner")).toContainText("SYNTHETIC REPLAY");
  c.mark("synthetic replay of the GDACS BELAL-24 alert");
  await c.hold(3000);

  await page.getByTestId("tab-traveller").click();
  await expect(page.locator(".card.state-refunded_cyclone").first()).toBeVisible();
  await expect(page.getByTestId("traveller-balance")).toContainText(sats(s0.traveller.balanceSats ?? 0), { timeout: 60_000 });
  c.mark("refunded: cyclone alert, balance back");
  await c.hold(6000);
  await noError(page);
  c.save();
});
