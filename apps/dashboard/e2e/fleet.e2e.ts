import { expect, type Page, test } from "@playwright/test";
import { BUSY, BUSY_LABELS, seedBusyFleet } from "./busy-fleet";
import { IDS, LABELS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const post = (path: string, body: unknown) =>
  fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });

const rows = (page: Page) => page.locator("[data-board-row]");
const row = (page: Page, id: string) => page.locator(`[data-board-row="${id}"]`);
const section = (page: Page, attention: string) => page.locator(`[data-needs="${attention}"]`);
const toolCalls = async () =>
  (
    (await (await fetch(`${MOCK}/__test/state`)).json()) as {
      toolCalls: { name: string; args: Record<string, unknown> }[];
    }
  ).toolCalls;

test("on a busy organization, Needs you holds only what needs a decision", async ({ page }) => {
  await seedBusyFleet();
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/fleet");
  await expect(page.getByRole("heading", { name: "Fleet", level: 1 })).toBeVisible();
  const segments = page.getByRole("navigation", { name: "Board view" });
  await expect(segments.getByRole("link", { name: /Needs you/ })).toHaveAttribute("aria-current", "page");

  // One section per need, in order; the 175 stopped sandboxes, the box moves and the crashes are not there.
  expect(
    await page.locator("[data-needs]").evaluateAll((items) => items.map((item) => item.getAttribute("data-needs"))),
  ).toEqual(["ready", "blocked", "failed", "interrupted", "unconcluded", "expiring"]);
  await expect(rows(page)).toHaveCount(7);
  await expect(page.getByText(/bx_done_|bx_moved_|bx_crash_|bx_launch_interrupted/)).toHaveCount(0);

  const ready = row(page, BUSY.ready);
  await expect(ready.locator("[data-work-item]")).toHaveText("acme/web#801");
  await expect(ready).toContainText("replaces 1 earlier run");
  await expect(ready.getByRole("link", { name: "PR #805" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/pull/805",
  );
  await expect(section(page, "ready").locator("[data-board-row]")).toHaveCount(2);
  await expect(row(page, BUSY.blocked).locator('[data-outcome-detail="blocked"]')).toContainText("staging Stripe key");
  await expect(row(page, BUSY.blocked).getByPlaceholder("Answer the agent")).toBeVisible();

  // The only failure is the real one; the box move is a calm interruption with a one-click resend.
  await expect(page.locator("[data-failure]")).toHaveCount(1);
  await expect(row(page, BUSY.failed).locator("[data-failure]")).toContainText("Usage limit reached");
  const interrupted = row(page, BUSY.interrupted);
  await expect(interrupted.locator("[data-failure]")).toHaveCount(0);
  await expect(interrupted.locator("[data-interruption]")).toContainText("moved to a new machine");
  await expect(
    row(page, BUSY.unconcluded).getByRole("button", { name: `Tell ${BUSY_LABELS.unconcluded} to continue` }),
  ).toBeVisible();
  await expect(row(page, BUSY.expiring).locator('[data-expiry="urgent"]')).toBeVisible();

  // The live agents that need nothing: one quiet line each.
  const working = page.locator("[data-working]");
  await expect(working.getByRole("heading")).toHaveText("Working (2)");
  await expect(working.locator(`[data-working-row="${BUSY.working}"]`)).toContainText("acme/web#812");
  await expect(working.locator(`[data-working-row="${BUSY.working}"]`)).toContainText(
    "Bash: bun test test/parser.test.ts",
  );
  await expect(working.locator(`[data-working-row="${BUSY.working}"] [data-elapsed]`)).toHaveText(/^4\d min$/);

  await page.screenshot({ path: "test-results/fleet-needs-you-desktop.png", fullPage: true, animations: "disabled" });

  // Resend the interrupted prompt: the same text goes back to the same sandbox, and the row leaves Needs you.
  await interrupted
    .getByRole("button", { name: `Resend the interrupted prompt to ${BUSY_LABELS.interrupted}` })
    .click();
  await expect(row(page, BUSY.interrupted)).toHaveCount(0);
  await expect(working.locator(`[data-working-row="${BUSY.interrupted}"]`)).toBeVisible();
  expect(await toolCalls()).toContainEqual({
    name: "send",
    args: { id: BUSY.interrupted, prompt: "Deliver issue #811 in acme/web: read the issue, implement it, open a PR." },
  });

  // Dismiss the failure: it leaves Needs you, stays in All, and comes back on Restore.
  await row(page, BUSY.failed)
    .getByRole("button", { name: `Dismiss ${BUSY_LABELS.failed} from Needs you` })
    .click();
  await expect(row(page, BUSY.failed)).toHaveCount(0);
  await expect(section(page, "failed")).toHaveCount(0);
  await page.reload();
  await expect(row(page, BUSY.failed)).toHaveCount(0);
  await segments.getByRole("link", { name: /All/ }).click();
  await expect(page).toHaveURL(/view=all/);
  await expect(row(page, BUSY.failed)).toHaveAttribute("data-dismissed", "");
  await expect(row(page, BUSY.failed)).toContainText("Dismissed");
  await row(page, BUSY.failed)
    .getByRole("button", { name: `Bring ${BUSY_LABELS.failed} back to Needs you` })
    .click();
  await expect(row(page, BUSY.failed)).not.toHaveAttribute("data-dismissed", "");
  await segments.getByRole("link", { name: /Needs you/ }).click();
  await expect(row(page, BUSY.failed)).toBeVisible();

  // At phone width, in the dark theme, nothing overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Change theme" }).last().click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({
    path: "test-results/fleet-needs-you-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("an empty Needs you is a good state, and Continue sends the agent back to work", async ({ page }) => {
  await post("sandbox-events", {
    sandbox: IDS.bobSecret,
    events: [
      { id: "b1", at: 1, kind: "prompt", text: "Fix the parser", status: "finished", promptId: "p1" },
      { id: "b2", at: 2, kind: "message", text: "I pinned the clock.", partial: false, tools: [], promptId: "p1" },
    ],
  });
  await signIn(page, "alice@example.com", "/fleet");
  const bob = row(page, IDS.bobSecret);
  await expect(bob.locator('[data-board-state="finished"]')).toHaveText("No outcome reported");
  await bob.getByRole("button", { name: `Tell ${LABELS.bobSecret} to continue` }).click();
  await expect(page.locator("[data-nothing-needed]")).toHaveText("Nothing needs you. 2 agents working.");
  const sent = (await toolCalls()).find((call) => call.name === "send");
  expect(sent?.args).toMatchObject({
    id: IDS.bobSecret,
    prompt: expect.stringContaining("Continue where you stopped"),
  });

  // All: every agent on the board, and the stale failure of two days ago is not one of them.
  await page.getByRole("navigation", { name: "Board view" }).getByRole("link", { name: /All/ }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, IDS.failed)).toHaveCount(0);
});

test("a member's board holds only the sandboxes they may open", async ({ page }) => {
  await signIn(page, "bob@example.com", "/fleet?view=all");
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

test("a stopped sandbox stays on the board while it holds an outcome, and leaves once it holds nothing", async ({
  page,
}) => {
  await reportOutcomes();
  await signIn(page, "alice@example.com", "/fleet");
  // Bob's agent reported ready to merge, though no work item is named: it is its own row.
  const ready = row(page, IDS.bobSecret);
  await expect(ready.locator('[data-board-state="ready"]')).toHaveText("Ready to merge");
  await expect(ready.locator('[data-outcome-detail="ready"] code')).toHaveText(SHA.slice(0, 7));
  const blocked = row(page, IDS.running);
  await expect(blocked.locator('[data-board-state="blocked"]')).toHaveText("Blocked");
  await expect(blocked.locator('[data-preservation="preserved"]')).toContainText("Unpushed work preserved");
  await expect(blocked.locator("code")).toHaveText(`armada recovery ${IDS.running} > armada-recovery.json`);

  // Once the outcome is cleared and the turn ended normally, a stopped sandbox holds nothing for Alice.
  await post("sandbox-lifecycle", { id: IDS.running, fields: { task_outcome: null, task_prompt_id: null } });
  await page.goto("/fleet?view=all");
  await expect(row(page, IDS.running)).toHaveCount(0);
});

test("the list and the conversation header show the outcome and the preservation receipt", async ({ page }) => {
  await reportOutcomes();
  await signIn(page, "alice@example.com", "/sandboxes");
  const listed = (id: string) => page.getByRole("row").filter({ has: page.locator(`a[href="/sandboxes/${id}"]`) });
  await expect(listed(IDS.bobSecret).locator('[data-outcome="ready"]')).toHaveText("Ready to merge");
  // The row's own link covers the row: the pull request link stays above it and opens the pull request.
  await page.context().route("https://github.com/**", (route) => route.fulfill({ body: "pull request" }));
  const [opened] = await Promise.all([
    page.waitForEvent("popup"),
    listed(IDS.bobSecret).getByRole("link", { name: "PR #768" }).click(),
  ]);
  expect(opened.url()).toBe("https://github.com/acme/web/pull/768");
  await opened.close();
  await expect(page).toHaveURL(/\/sandboxes$/);
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
