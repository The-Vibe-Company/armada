import { expect, test } from "@playwright/test";
import { IDS, LABELS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);
const post = (path: string, body: unknown) =>
  fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
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
