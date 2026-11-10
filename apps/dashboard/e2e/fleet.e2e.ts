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
  // The failed sandbox was last seen an hour ago: it is still on the board.
  await post("sandbox-lifecycle", {
    id: IDS.failed,
    fields: { last_observed_at: new Date(Date.now() - 3600_000).toISOString() },
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
  await expect(row(page, IDS.failed).getByRole("link", { name: "Manage credentials" })).toHaveAttribute(
    "href",
    "/credentials",
  );
  await expect(row(page, IDS.bobSecret).locator('[data-expiry="urgent"]')).toContainText(/Expires soon: \d+ min left/);
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

const SHA = "4f1c2a9e0b7d3c6f5a8e1d2c3b4a59687f6e5d4c";
const RECOVERY = "00000000-0000-4000-8000-000000000099";

/** Alice's running sandbox stopped after reporting blocked and preserving its work; Bob's reports ready to merge. */
async function reportOutcomes() {
  await post("sandbox-events", {
    sandbox: IDS.running,
    events: [
      { id: "r1", at: 1, kind: "prompt", text: "Ship the parser fix", status: "finished", promptId: "p1" },
      { id: "r2", at: 2, kind: "message", text: "I need a staging key.", partial: false, tools: [], promptId: "p1" },
    ],
  });
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: {
      status: "stopped",
      stopped_at: new Date(Date.now() - 600_000).toISOString(),
      task_prompt_id: "p1",
      task_outcome: { state: "blocked", reason: "The staging API key is missing; add it to the org credentials." },
      preservation_note: `unpushed work preserved at work_recovery:${IDS.running}/${RECOVERY}`,
    },
  });
  await post("sandbox-events", {
    sandbox: IDS.bobSecret,
    events: [
      { id: "b1", at: 1, kind: "prompt", text: "Fix the parser", status: "finished", promptId: "p9" },
      { id: "b2", at: 2, kind: "message", text: "PR is green.", partial: false, tools: [], promptId: "p9" },
    ],
  });
  await post("sandbox-lifecycle", {
    id: IDS.bobSecret,
    fields: {
      expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
      task_prompt_id: "p9",
      task_outcome: { state: "ready", prNumber: 768, prUrl: "https://github.com/acme/web/pull/768", headSha: SHA },
    },
  });
}

test("the board shows blocked and ready to merge above the rest, and Needs me keeps only those", async ({ page }) => {
  await reportOutcomes();
  await post("sandbox-lifecycle", {
    id: IDS.failed,
    fields: { last_observed_at: new Date(Date.now() - 3600_000).toISOString() },
  });
  await signIn(page, "alice@example.com", "/fleet");

  await expect(rows(page)).toHaveCount(3);
  expect(await rows(page).evaluateAll((items) => items.map((item) => item.getAttribute("data-state")))).toEqual([
    "failed",
    "blocked",
    "ready",
  ]);
  const blocked = row(page, IDS.running);
  await expect(blocked.locator('[data-board-state="blocked"]')).toHaveText("Blocked");
  await expect(blocked.locator('[data-outcome-detail="blocked"]')).toContainText("The staging API key is missing");
  await expect(blocked.locator('[data-preservation="preserved"]')).toContainText("Unpushed work preserved");
  await expect(blocked.locator("code")).toHaveText(`armada recovery ${IDS.running} > armada-recovery.json`);

  const ready = row(page, IDS.bobSecret);
  await expect(ready.locator('[data-board-state="ready"]')).toHaveText("Ready to merge");
  await expect(ready.getByRole("link", { name: "PR #768" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/pull/768",
  );
  await expect(ready.locator('[data-outcome-detail="ready"] code')).toHaveText(SHA.slice(0, 7));
  await page.screenshot({ path: "test-results/fleet-outcome-desktop.png", fullPage: true, animations: "disabled" });

  // Needs me: all three need Alice now.
  const segments = page.getByRole("navigation", { name: "Board view" });
  await segments.getByRole("link", { name: /Needs me/ }).click();
  await expect(page).toHaveURL(/view=needs-me/);
  await expect(segments.getByRole("link", { name: /Needs me/ })).toHaveAttribute("aria-current", "page");
  await expect(rows(page)).toHaveCount(3);

  // Once Bob's agent starts a new turn the server clears its outcome: a plain finished turn does not need Alice.
  await post("sandbox-lifecycle", { id: IDS.bobSecret, fields: { task_outcome: null, task_prompt_id: null } });
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, IDS.bobSecret)).toHaveCount(0);
  await segments.getByRole("link", { name: /All/ }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, IDS.bobSecret)).toHaveAttribute("data-state", "finished");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fleet?view=needs-me");
  await expect(rows(page)).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/fleet-outcome-mobile.png", fullPage: true, animations: "disabled" });
});

test("the list and the conversation header show the outcome and the preservation receipt", async ({ page }) => {
  await reportOutcomes();
  await signIn(page, "alice@example.com", "/sandboxes");
  const listed = (id: string) => page.getByRole("row").filter({ has: page.locator(`a[href="/sandboxes/${id}"]`) });
  await expect(listed(IDS.bobSecret).locator('[data-outcome="ready"]')).toHaveText("Ready to merge");
  await expect(listed(IDS.bobSecret).getByRole("link", { name: "PR #768" })).toBeVisible();
  await expect(listed(IDS.running).locator('[data-outcome="blocked"]')).toHaveText("Blocked");
  await expect(listed(IDS.running).locator('[data-preservation="preserved"]')).toHaveText("Unpushed work preserved");
  await page.screenshot({ path: "test-results/sandboxes-outcome.png", fullPage: true, animations: "disabled" });

  await page.goto(`/sandboxes/${IDS.running}`);
  await expect(page.locator('[data-outcome="blocked"]')).toHaveText("Blocked");
  await expect(page.locator('[data-outcome-detail="blocked"]')).toContainText("staging API key");
  const receipt = page.locator('[data-preservation="preserved"]');
  await expect(receipt.locator("code")).toHaveText(`armada recovery ${IDS.running} > armada-recovery.json`);
  await expect(receipt.getByRole("button", { name: "Copy the recovery command" })).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-outcome.png", animations: "disabled" });

  await page.goto(`/sandboxes/${IDS.bobSecret}`);
  await expect(page.locator('[data-outcome="ready"]')).toHaveText("Ready to merge");
  await expect(page.getByRole("link", { name: "PR #768" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/pull/768",
  );
});

test("a member sees the preservation receipt of a sandbox they cannot open, never its outcome or command", async ({
  page,
}) => {
  await reportOutcomes();
  await signIn(page, "bob@example.com", "/sandboxes");
  const restricted = page.getByRole("row").filter({ hasText: LABELS.running });
  await expect(restricted.locator('[data-preservation="preserved"]')).toHaveText("Unpushed work preserved");
  await expect(restricted.locator("[data-outcome]")).toHaveCount(0);
  await expect(restricted.getByText("armada recovery")).toHaveCount(0);
});
