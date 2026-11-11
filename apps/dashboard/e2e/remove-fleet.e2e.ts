import { expect, type Page, test } from "@playwright/test";
import { BUSY, BUSY_LABELS, busyFleet } from "./busy-fleet";
import { IDS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(async () => {
  await reset();
  const examples = new Set(Object.values(BUSY));
  const response = await fetch(`${MOCK}/__test/add-sandboxes`, {
    method: "POST",
    body: JSON.stringify({ rows: busyFleet().filter((row) => examples.has(row.id)) }),
  });
  expect(response.ok).toBe(true);
});

async function attention(page: Page, id: string) {
  await page.goto(`/sandboxes/${id}`);
  const card = page.locator("[data-sandbox-attention]").filter({ visible: true });
  if (!(await card.isVisible()) && (await page.getByRole("button", { name: "Details", exact: true }).isVisible())) {
    await page.getByRole("button", { name: "Details", exact: true }).click();
  }
  await expect(card).toBeVisible();
  return card;
}

const calls = async () => (await (await fetch(`${MOCK}/__test/state`)).json()).toolCalls;

test("the dashboard lands on Sandboxes and old Fleet bookmarks redirect without a navigation or search entry", async ({
  page,
}) => {
  await signIn(page, "alice@example.com");
  await page.goto("/");
  await expect(page).toHaveURL(/\/sandboxes$/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Fleet", exact: true }),
  ).toHaveCount(0);
  for (const path of ["/fleet", "/fleet?view=all"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sandboxes$/);
    await expect(page.getByRole("heading", { name: "Sandboxes", exact: true })).toBeVisible();
  }
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search pages and actions" }).fill("fleet");
  await expect(page.getByRole("option")).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`sandbox details retain resend, continue, acknowledgement and attention states (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signIn(page, "alice@example.com");
    const interrupted = await attention(page, BUSY.interrupted);
    await expect(interrupted).toContainText("Interrupted");
    await expect(interrupted.locator("[data-failure]")).toHaveCount(0);
    await interrupted
      .getByRole("button", { name: `Resend the interrupted prompt to ${BUSY_LABELS.interrupted}` })
      .click();
    await expect(interrupted).toBeHidden();
    expect(await calls()).toContainEqual({
      name: "send",
      args: {
        id: BUSY.interrupted,
        prompt: "Deliver issue #811 in acme/web: read the issue, implement it, open a PR.",
      },
    });

    const unfinished = await attention(page, BUSY.unconcluded);
    await unfinished.getByRole("button", { name: `Continue ${BUSY_LABELS.unconcluded}` }).click();
    await expect(unfinished).toBeHidden();
    expect(await calls()).toContainEqual({
      name: "send",
      args: {
        id: BUSY.unconcluded,
        prompt:
          "Continue where you stopped. When the work is done or you need a decision, report the outcome (ready to merge or blocked).",
      },
    });

    const failed = await attention(page, BUSY.failed);
    await expect(failed).toContainText("Usage limit reached");
    await failed.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(failed.getByText("Acknowledged", { exact: true })).toBeVisible();
    await page.reload();
    if (width < 1024) await page.getByRole("button", { name: "Details", exact: true }).click();
    await failed.getByRole("button", { name: "Restore attention" }).click();
    await expect(failed.getByText("Acknowledged", { exact: true })).toHaveCount(0);

    for (const [id, state] of [
      [BUSY.ready, "ready"],
      [BUSY.blocked, "blocked"],
      [BUSY.expiring, "expiring"],
    ] as const) {
      const card = await attention(page, id);
      await expect(card).toHaveAttribute("data-sandbox-attention", state);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.context().clearCookies();
    await signIn(page, "bob@example.com", `/sandboxes/${IDS.running}`);
    await expect(page.locator("[data-restricted]")).toBeVisible();
    await expect(page.locator("[data-sandbox-attention]").filter({ visible: true })).toHaveCount(0);
  });
}

test("old Fleet acknowledgement cookies migrate once without restoring stale acknowledgements on another bookmark visit", async ({
  page,
}) => {
  await signIn(page, "alice@example.com");
  const failed = await attention(page, BUSY.failed);
  await failed.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(failed.getByText("Acknowledged", { exact: true })).toBeVisible();
  const saved = (await page.context().cookies()).find((cookie) => cookie.name === "armada-fleet-ack");
  expect(saved).toBeDefined();
  await page.context().clearCookies({ name: "armada-fleet-ack" });
  await page.context().addCookies([{ ...saved!, path: "/fleet" }]);
  await page.goto("/fleet?view=all");
  await expect(page).toHaveURL(/\/sandboxes$/);
  const migrated = (await page.context().cookies()).filter((cookie) => cookie.name === "armada-fleet-ack");
  expect(migrated.map((cookie) => cookie.path)).toEqual(["/sandboxes"]);
  expect(migrated[0]?.value).toBe(saved?.value);
  await attention(page, BUSY.failed);
  await failed.getByRole("button", { name: "Restore attention" }).click();
  await page.goto("/fleet");
  await attention(page, BUSY.failed);
  await expect(failed.getByText("Acknowledged", { exact: true })).toHaveCount(0);
});
