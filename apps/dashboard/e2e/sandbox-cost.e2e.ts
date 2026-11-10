import { expect, test } from "@playwright/test";
import { IDS, LABELS, reset, signIn } from "./helpers";

test.beforeEach(reset);

// Alice's running sandbox reported two Claude Opus 5.5 turns; her failed one reported nothing (#875).
test("a sandbox with usage shows its cost, one without says so", async ({ page }) => {
  await signIn(page, "alice@example.com");
  const row = (name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
  // (12,000 × $4 + 480,000 × $0.20 + 9,500 × $20 + 3,000 × $4 + 610,000 × $0.20 + 4,200 × $20) / 1M = $0.552.
  await expect(row(LABELS.running).locator("[data-row-cost=priced]")).toHaveText("$0.55");
  await expect(row(LABELS.running).locator("[data-row-cost=priced]")).toHaveAttribute("title", "Estimated cost");
  await expect(row(LABELS.failed).locator("[data-row-cost=none]")).toHaveText("No usage recorded yet");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: `test-results/sandbox-cost-list-desktop-${scheme}.png`, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row(LABELS.running).locator("[data-phone-cost=priced]")).toHaveText("Estimated cost: $0.55");
    await expect(row(LABELS.failed).locator("[data-phone-cost=none]")).toHaveText("No usage recorded yet");
    await page.screenshot({ path: `test-results/sandbox-cost-list-phone-${scheme}.png`, animations: "disabled" });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sandboxes/${IDS.running}`);
  const card = page.locator("[data-sandbox-cost=priced]");
  await expect(card.getByText("Estimated cost", { exact: true })).toBeVisible();
  await expect(card.getByText("$0.55", { exact: true })).toBeVisible();
  await expect(card.getByText("1.1M", { exact: true })).toBeVisible(); // cached input
  await expect(card.getByText("12 min", { exact: true })).toBeVisible();
  await expect(card.getByText("claude-opus-5-5", { exact: true })).toBeVisible();
  await card.getByText("Per turn").click();
  const turns = card.getByRole("table", { name: "Cost per turn" });
  await expect(turns.getByRole("row")).toHaveCount(3);
  await expect(turns.getByRole("row").nth(1)).toContainText("$0.33");
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
