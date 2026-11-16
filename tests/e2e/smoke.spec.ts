// Playwright smoke test at 360 px (EN) and 412 px (FR): book, approve, agent locks, guide settles.
import { test, expect } from "@playwright/test";

test("book -> approve -> agent locks -> guide settles", async ({ page, request }, info) => {
  await request.post("/api/demo/reset", { data: {} });
  await page.goto("/");
  const fr = info.project.name.endsWith("fr");
  await expect(page.getByTestId("sim-banner")).toContainText(fr ? "SIMULÉ" : "SIMULATED");
  await expect(page.getByTestId("traveller-balance")).toContainText("120 000");

  await page.getByTestId("book-tour_lemorne").click();
  await page.getByTestId("approve").click();
  await page.getByTestId("ask-agent").click();
  const code = page.getByTestId("meeting-code");
  await expect(code).toBeVisible();
  await expect(page.getByTestId("traveller-balance")).toContainText("99 000");
  await page.screenshot({ path: `test-results/${info.project.name}-traveller.png`, fullPage: true });
  const p = (await code.textContent())!.replace(/\s+/g, "");

  await page.getByTestId("tab-guide").click();
  await page.getByTestId("guide-code").fill(p);
  await page.getByTestId("settle").click();
  await expect(page.getByTestId("guide-balance")).toContainText("21 000");
  await page.screenshot({ path: `test-results/${info.project.name}-guide.png`, fullPage: true });

  await page.getByTestId("tab-agent").click();
  await expect(page.getByTestId("agent-log")).toContainText("pay_invoice");
  await page.screenshot({ path: `test-results/${info.project.name}-agent.png`, fullPage: true });

  // No horizontal scroll on a small phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("cyclone alert refunds a locked booking", async ({ page, request }, info) => {
  const fr = info.project.name.endsWith("fr");
  await request.post("/api/demo/reset", { data: {} });
  await page.goto("/");
  await page.getByTestId("book-tour_lagoon").click();
  await page.getByTestId("approve").click();
  await page.getByTestId("ask-agent").click();
  await expect(page.getByTestId("traveller-balance")).toContainText("108 000");
  await page.getByTestId("tab-agent").click();
  await page.getByTestId("cyclone").click();
  const banner = page.getByTestId("cyclone-banner");
  await expect(banner).toContainText("BELAL");
  // The demo replay is named so in the screen's language.
  await expect(banner).toContainText(fr ? "REJEU SYNTHÉTIQUE" : "SYNTHETIC REPLAY");
  if (fr) await expect(banner).not.toContainText("SYNTHETIC REPLAY");
  await page.getByTestId("tab-traveller").click();
  await expect(page.getByTestId("traveller-balance")).toContainText("120 000");
});

test("plan B: book after, approve, skip past the tour, confirm, agent pays", async ({ page, request }) => {
  await request.post("/api/demo/reset", { data: {} });
  await page.goto("/");
  await page.getByTestId("book-after-tour_lagoon").click();
  await page.getByTestId("approve").click();
  await page.getByTestId("tab-agent").click();
  await page.getByRole("button", { name: /13 h/ }).click();
  await page.getByTestId("tab-traveller").click();
  await page.getByTestId("confirm-tour").click();
  await page.getByTestId("ask-agent-pay").click();
  await expect(page.getByTestId("traveller-balance")).toContainText("108 000");
  await page.getByTestId("tab-guide").click();
  await page.locator("#guide-select").selectOption("guide_lagoon");
  await expect(page.getByTestId("guide-balance")).toContainText("12 000");
});

test("the agent console shows every overspend attempt refused", async ({ page, request }) => {
  await request.post("/api/demo/reset", { data: {} });
  await page.goto("/");
  await page.getByTestId("book-tour_chamarel").click();
  await page.getByTestId("approve").click();
  await page.getByTestId("tab-agent").click();
  await page.getByTestId("attack").click();
  const log = page.getByTestId("agent-log");
  await expect(log).toContainText("all_refused_by_the_mandate");
  await expect(log).toContainText("invoice_wrong_amount");
  await expect(log).toContainText("invoice_wrong_payee");
  await expect(log).toContainText("unknown tool: approve_mandate");
  await page.screenshot({ path: `test-results/${test.info().project.name}-attack.png`, fullPage: true });
});

test("hold invoice expired unpaid: the traveller approves again with a new code, then the guide is paid", async ({ page, request }) => {
  await request.post("/api/demo/reset", { data: {} });
  await page.goto("/");
  const fr = test.info().project.name.endsWith("fr");
  await page.getByTestId("book-tour_lemorne").click();
  await page.getByTestId("approve").click();
  await page.getByTestId("tab-agent").click();
  await page.getByTestId("expire-invoice").click();
  await expect(page.getByTestId("agent-log")).toContainText("request_invoice");
  await page.getByTestId("tab-traveller").click();
  const card = page.locator(".card.state-reapproval_needed");
  await expect(card).toContainText(fr ? "nouveau code" : "new code");
  await page.screenshot({ path: `test-results/${test.info().project.name}-reapprove.png`, fullPage: true });
  await page.getByTestId("reapprove").click();
  await page.getByTestId("ask-agent").click();
  const code = page.getByTestId("meeting-code");
  await expect(code).toBeVisible();
  await expect(page.getByTestId("traveller-balance")).toContainText("99 000");
  const p = (await code.textContent())!.replace(/\s+/g, "");
  await page.getByTestId("tab-guide").click();
  await page.getByTestId("guide-code").fill(p);
  await page.getByTestId("settle").click();
  await expect(page.getByTestId("guide-balance")).toContainText("21 000");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
