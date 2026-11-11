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

test("delayed usage refreshes a ready session's card without a status transition or repeated refreshes", async ({
  page,
  request,
}) => {
  expect((await request.post(`${MOCK}/__test/delayed-usage`, { data: {} })).ok()).toBe(true);
  const eventsPath = `/api/sandboxes/${IDS.running}/events`;
  const firstPoll = page.waitForResponse((response) => new URL(response.url()).pathname === eventsPath);
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  expect((await (await firstPoll).json()).status).toBe("ready");
  const card = page.locator("[data-sandbox-cost]");
  await expect(card).toContainText("Tokens not reported");
  let refreshes = 0;
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === `/sandboxes/${IDS.running}` && sent.headers().rsc === "1") refreshes++;
  });
  expect((await request.post(`${MOCK}/__test/delayed-usage`, { data: { collect: true } })).ok()).toBe(true);
  await expect(
    card
      .locator("dl > div")
      .filter({ has: page.getByText("Input", { exact: true }) })
      .locator("dd"),
  ).toHaveText("13.1K");
  await expect(card.locator("p[title]")).toHaveText("$0.03");
  const refreshed = refreshes;
  expect(refreshed).toBeGreaterThan(0);
  for (let i = 0; i < 2; i++) {
    const poll = await page.waitForResponse((response) => new URL(response.url()).pathname === eventsPath);
    expect((await poll.json()).status).toBe("ready");
  }
  expect(refreshes).toBe(refreshed);
  // Another collector persisted usage while optional status telemetry is down.
  // Successful logs must still carry the row's new observation to the card.
  expect(
    (
      await request.post(`${MOCK}/__test/delayed-usage`, {
        data: { collect: true, persisted: true, failStatus: true, inputTokens: 26272 },
      })
    ).ok(),
  ).toBe(true);
  await expect(
    card
      .locator("dl > div")
      .filter({ has: page.getByText("Input", { exact: true }) })
      .locator("dd"),
  ).toHaveText("26.3K");
  await expect(card.locator("p[title]")).toHaveText("$0.05");
  await page.screenshot({ path: "test-results/sandbox-cost-delayed-collection.png", animations: "disabled" });
});
