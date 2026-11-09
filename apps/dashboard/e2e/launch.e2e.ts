import { expect, type Page, test } from "@playwright/test";
import { MOCK, openLaunch, reset, signIn } from "./helpers";

test.beforeEach(reset);

async function launches(): Promise<Record<string, unknown>[]> {
  return ((await (await fetch(`${MOCK}/__test/state`)).json()) as { launches: Record<string, unknown>[] }).launches;
}

/** Launch stays on screen and only the fields scroll: the page itself never scrolls because of the form. */
async function expectPinnedLaunch(page: Page) {
  const dialog = page.getByRole("dialog");
  const pageScroll = await page.evaluate(() => window.scrollY);
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toBeInViewport({ ratio: 1 });
  const fields = dialog.locator("[data-launch-fields]");
  await fields.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY), "the page behind the dialog does not scroll").toBe(pageScroll);
}

test("a task-only launch sends the configured defaults through the launch API", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunch(page, "shared-golden", { advanced: false });
  // The task comes first and has focus; the overrides stay collapsed behind a summary of what will be used.
  const task = dialog.getByLabel("Task");
  await expect(task).toBeFocused();
  await expect(dialog.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(dialog.getByLabel("Project")).toBeVisible();
  await expect(dialog.getByLabel("Model", { exact: true })).toBeHidden();
  await expect(dialog.locator("[data-launch-summary]")).toHaveText("Claude Opus 5.5 · Medium · Org · No MCP");
  await page.screenshot({ path: "test-results/launch-default-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 664 });
  await expectPinnedLaunch(page);
  await page.screenshot({ path: "test-results/launch-default-mobile.png", animations: "disabled" });

  await task.fill("Fix the flaky login test");
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  expect(await launches()).toEqual([
    {
      golden: "shared-golden",
      provider: "boat",
      org: expect.any(String),
      harness: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "medium",
      visibility: "org",
      connections: [],
      prompt: "Fix the flaky login test",
    },
  ]);
});

test("the open Advanced area scrolls inside the dialog with Launch still on screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunch(page, "shared-golden");
  await dialog.getByRole("radio", { name: /^Private/ }).check();
  await dialog.getByLabel("Alice Linear").uncheck();
  await dialog.getByLabel("Acme Docs").check();
  await expect(dialog.locator("[data-launch-summary]")).toHaveText("Claude Opus 5.5 · Medium · Private · 1 MCP");
  await dialog.getByLabel("Acme Docs").scrollIntoViewIfNeeded();
  await expectPinnedLaunch(page);
  await page.screenshot({ path: "test-results/launch-advanced-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByLabel("Task").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/launch-advanced-desktop.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  expect(await launches()).toMatchObject([{ visibility: "private", connections: [expect.any(String)] }]);
  expect((await launches())[0]).not.toHaveProperty("prompt");
});

test("errors are never hidden: an invalid override opens Advanced, a refused launch keeps the task", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunch(page, "shared-golden");
  await dialog.getByLabel("Model", { exact: true }).selectOption("other");
  await dialog.locator("[data-launch-advanced] > summary").click();
  await expect(dialog.getByLabel("Model id")).toBeHidden();
  await dialog.getByLabel("Task").fill("Keep me");
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  // The browser refuses the empty custom model id: the collapsed area opens on it.
  await expect(dialog.getByLabel("Model id")).toBeFocused();
  await dialog.getByLabel("Model", { exact: true }).selectOption("claude-sonnet-5-5");

  // A launch the server refuses keeps what was entered and moves focus to the reason.
  await dialog.getByRole("radio", { name: "Codex" }).check();
  await dialog.locator('input[name="golden"]').evaluate((input) => {
    (input as HTMLInputElement).value = "missing-golden";
  });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  const refusal = dialog.getByRole("alert");
  await expect(refusal).toHaveText("That golden is not available in this organization.");
  await expect(refusal).toBeFocused();
  await expect(dialog.getByLabel("Task")).toHaveValue("Keep me");
  await expect(dialog.getByRole("radio", { name: "Codex" })).toBeChecked();
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue("gpt-6.1-sol");
  await page.setViewportSize({ width: 390, height: 664 });
  await expectPinnedLaunch(page);
  await page.screenshot({ path: "test-results/launch-error-mobile.png", animations: "disabled" });
  expect(await launches()).toHaveLength(0);
});
