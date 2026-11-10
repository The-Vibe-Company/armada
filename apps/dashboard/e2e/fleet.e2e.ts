import { expect, type Page, test } from "@playwright/test";
import { IDS, LABELS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const post = (path: string, body: unknown) =>
  fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });

const LONG =
  "I fixed the flaky parser test by pinning the clock, then ran the whole suite twice to be sure. " +
  "Everything passes. The branch is pushed and the pull request is open; it needs a reviewer before it can merge, " +
  "and the changelog entry is waiting for your wording.";

const rows = (page: Page) => page.locator("[data-board-row]");
const row = (page: Page, id: string) => page.locator(`[data-board-row="${id}"]`);

test("the board puts what needs the operator first and acts on each agent", async ({ page }) => {
  // Bob's sandbox (Alice is an admin, so she may open it): its turn finished and its deadline is close.
  await post("sandbox-lifecycle", {
    id: IDS.bobSecret,
    fields: { expires_at: new Date(Date.now() + 20 * 60_000).toISOString(), conversation_ids: ["conv-b"] },
  });
  await post("sandbox-events", {
    sandbox: IDS.bobSecret,
    events: [
      { id: "b1", at: 1, kind: "prompt", text: "Fix the parser", status: "finished", promptId: "p1" },
      { id: "b2", at: 2, kind: "message", text: LONG, partial: false, tools: [], promptId: "p1" },
    ],
  });
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: { expires_at: new Date(Date.now() + 3 * 3600_000).toISOString() },
  });

  await signIn(page, "alice@example.com", "/fleet");
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();

  // Failed first, then the finished one about to expire, then the one still working.
  await expect(rows(page)).toHaveCount(3);
  expect(await rows(page).evaluateAll((items) => items.map((item) => item.getAttribute("data-state")))).toEqual([
    "failed",
    "finished",
    "working",
  ]);
  await expect(rows(page).first()).toContainText(LABELS.failed);
  await expect(row(page, IDS.failed).locator("[data-failure]")).toContainText("Usage limit reached");
  await expect(row(page, IDS.bobSecret).locator('[data-expiry="urgent"]')).toContainText("min left");
  await expect(row(page, IDS.running).locator('[data-expiry="normal"]')).toContainText("h");
  await expect(row(page, IDS.running).locator("[data-latest-message]")).toHaveText("Looking at the test suite.");
  await expect(page.getByText("2 agents need you.")).toBeVisible();

  // The latest message is cut, and opens in place.
  const message = row(page, IDS.bobSecret).locator("[data-latest-message]");
  await expect(message).not.toContainText("changelog entry");
  await row(page, IDS.bobSecret).getByRole("button", { name: "Show more" }).click();
  await expect(message).toContainText("changelog entry");
  await row(page, IDS.bobSecret).getByRole("button", { name: "Show less" }).click();

  await page.screenshot({ path: "test-results/fleet-desktop.png", fullPage: true, animations: "disabled" });

  // Open the conversation.
  await expect(
    row(page, IDS.bobSecret).getByRole("link", { name: `Open the conversation of ${LABELS.bobSecret}` }),
  ).toHaveAttribute("href", `/sandboxes/${IDS.bobSecret}`);
  // A working agent is steered from its conversation, not from the board.
  await expect(row(page, IDS.running).getByRole("textbox")).toHaveCount(0);

  // A follow-up prompt, inline: the agent goes back to work and the row moves down.
  await row(page, IDS.bobSecret)
    .getByRole("textbox", { name: `Follow-up prompt for ${LABELS.bobSecret}` })
    .fill("Write the changelog entry");
  await row(page, IDS.bobSecret).getByRole("button", { name: "Send" }).click();
  await expect(row(page, IDS.bobSecret)).toHaveAttribute("data-state", "working");
  const state = (await (await fetch(`${MOCK}/__test/state`)).json()) as {
    toolCalls: { name: string; args: Record<string, unknown> }[];
  };
  expect(state.toolCalls).toContainEqual({
    name: "send",
    args: { id: IDS.bobSecret, prompt: "Write the changelog entry" },
  });

  // Stop, after confirming.
  await row(page, IDS.running).getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Stop sandbox" }).click();
  await expect(row(page, IDS.running)).toHaveAttribute("data-state", "stopped");
  await expect(rows(page).last()).toHaveAttribute("data-board-row", IDS.running);

  // At phone width, in the dark theme, nothing overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Change theme" }).last().click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(rows(page).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/fleet-mobile-dark.png", fullPage: true, animations: "disabled" });
});

test("a member's board holds only the sandboxes they may open", async ({ page }) => {
  await signIn(page, "bob@example.com", "/fleet");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, IDS.bobSecret)).toBeVisible();
  await expect(page.getByText(LABELS.running)).toHaveCount(0);
});
