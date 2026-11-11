import { expect, test } from "@playwright/test";
import { IDS, LABELS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

// Alice's running sandbox reported two Claude Opus 5.5 turns; her failed one reported nothing (#875). Neither
// records a readable account, so the figure is the API equivalent, never an estimate of a bill.
test("a sandbox with usage shows its cost, one without says so", async ({ page }) => {
  await signIn(page, "alice@example.com");
  const row = (name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
  // (100,000 × $5 + 12,000 × $4 + 480,000 × $0.20 + 9,500 × $20 + 3,000 × $4 + 610,000 × $0.20 + 4,200 × $20) / 1M = $1.052.
  await expect(row(LABELS.running).locator("[data-row-cost=priced]")).toHaveText("$1.05");
  await expect(row(LABELS.running).locator("[data-row-cost=priced]")).toHaveAttribute("title", "API-equivalent cost");
  await expect(row(LABELS.failed).locator("[data-row-cost=none]")).toHaveText("No usage yet");
  await expect(row(LABELS.failed).locator("[data-row-cost=none]")).toHaveAttribute("title", "No usage recorded yet");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: `test-results/sandbox-cost-list-desktop-${scheme}.png`, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row(LABELS.running).locator("[data-phone-cost=priced]")).toHaveText("API-equivalent cost: $1.05");
    await expect(row(LABELS.failed).locator("[data-phone-cost=none]")).toHaveText("No usage recorded yet");
    await page.screenshot({ path: `test-results/sandbox-cost-list-phone-${scheme}.png`, animations: "disabled" });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sandboxes/${IDS.running}`);
  const card = page.locator("[data-sandbox-cost=priced]");
  await expect(card.getByText("API-equivalent cost", { exact: true })).toBeVisible();
  await expect(card.getByText("$1.05", { exact: true })).toBeVisible();
  await expect(card.getByText("1.1M", { exact: true })).toBeVisible(); // cached input
  await expect(card.getByRole("definition").filter({ hasText: /^100K$/ })).toBeVisible(); // priced cache writes
  await expect(card.getByText("12 min", { exact: true })).toBeVisible();
  await expect(card.getByText("claude-opus-5-5", { exact: true })).toBeVisible();
  await card.getByText("Per turn").click();
  const turns = card.getByRole("table", { name: "Cost per turn" });
  await expect(turns.getByRole("row")).toHaveCount(3);
  await expect(turns.getByRole("row").nth(1)).toContainText("$0.83");
  await expect(turns.getByRole("row").nth(2)).toContainText("$0.22");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `test-results/sandbox-cost-card-desktop-${scheme}.png`, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Details" }).click();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/sandbox-cost-card-phone-${scheme}.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Details" }).click();
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sandboxes/${IDS.failed}`);
  await expect(page.locator("[data-sandbox-cost=none]")).toContainText("No usage recorded yet.");
  await expect(page.locator("[data-sandbox-cost]").getByText("$0.00")).toHaveCount(0);
});

test("each fleet row carries its small cost figure", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.goto("/fleet?view=all");
  const row = (id: string) => page.locator(`[data-board-row="${id}"], [data-working-row="${id}"]`).first();
  await expect(row(IDS.running).locator("[data-row-cost=priced]")).toHaveText("$1.05");
  await expect(row(IDS.running).locator("[data-row-cost=priced]")).toHaveAttribute("title", "API-equivalent cost");
  await expect(row(IDS.bobSecret).locator("[data-row-cost=none]")).toHaveText("No usage yet");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `test-results/sandbox-cost-fleet-desktop-${scheme}.png`, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row(IDS.running).locator("[data-row-cost=priced]")).toBeVisible();
    await page.screenshot({ path: `test-results/sandbox-cost-fleet-phone-${scheme}.png`, animations: "disabled" });
  }
});

// Alice's orchestrator runs on a sandbox with no recorded usage and launched her running sandbox as its one worker.
test("an orchestrator shows its own cost and its workers' together", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orchestrators/00000000-0000-4000-8000-000000000160");
  const side = page.getByRole("complementary", { name: "Orchestrator details" });
  const fact = (label: string) => side.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
  await expect(fact("API-equivalent cost").locator("dd")).toHaveText("$1.05");
  await expect(fact("Its own").locator("dd")).toHaveText("No usage yet");
  await expect(fact("Its 1 worker").locator("dd")).toHaveText("$1.05");
  await side.locator("summary", { hasText: "Workers" }).click();
  await expect(side.locator("li").filter({ has: page.getByRole("link", { name: "00000000" }) })).toContainText("$1.05");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `test-results/sandbox-cost-orchestrator-desktop-${scheme}.png`,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await fact("Its own").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/sandbox-cost-orchestrator-phone-${scheme}.png`,
      animations: "disabled",
    });
  }
});

test("partial token reporting stays Not reported in the card and per-turn table", async ({ page }) => {
  const response = await fetch(`${MOCK}/__test/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ missingUsage: true }),
  });
  expect(response.ok).toBe(true);
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const card = page.locator("[data-sandbox-cost=priced]");
  const output = card.locator("dl > div").filter({ has: page.getByText("Output", { exact: true }) });
  await expect(output.locator("dd")).toHaveText("Not reported");
  await expect(card.locator("p[title]")).toHaveText("$0.83");
  await card.getByText("Per turn").click();
  await expect(card.getByRole("row").nth(2)).toContainText("Not reported");
  await page.screenshot({ path: "test-results/sandbox-cost-missing-counters.png", animations: "disabled" });
});
