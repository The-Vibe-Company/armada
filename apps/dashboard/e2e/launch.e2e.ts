import { expect, type Page, test } from "@playwright/test";
import { MOCK, openLaunch, reset, signIn } from "./helpers";

test.beforeEach(reset);

const ACME = "00000000-0000-4000-8000-000000000010";

async function post(path: string, body: object = {}) {
  const response = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
}

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
  // Every default stays readable on a phone: the summary wraps instead of being cut off.
  expect(await dialog.locator("[data-launch-summary]").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
    true,
  );
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
  // Modal stays connected, so only the golden's own provider is missing once Boat is cleared.
  await post("/__test/reset", { acmeModal: true });
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
  await post("/__test/clear-legacy-boat", { org: ACME });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  const refusal = dialog.getByRole("alert");
  await expect(refusal).toHaveText("Boat is not connected for this organization. An admin connects it in Settings.");
  await expect(refusal).toBeFocused();
  await expect(dialog.getByLabel("Task")).toHaveValue("Keep me");
  await expect(dialog.getByRole("radio", { name: "Codex" })).toBeChecked();
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue("gpt-6.1-sol");
  await page.setViewportSize({ width: 390, height: 664 });
  await expectPinnedLaunch(page);
  await page.screenshot({ path: "test-results/launch-error-mobile.png", animations: "disabled" });
  expect(await launches()).toHaveLength(0);
});

/**
 * A phone keyboard, as browsers report it: the visual viewport shrinks while the layout viewport (and `dvh` on iOS)
 * keeps its height, and Safari may also scroll it (`offsetTop`). Headless Chromium has no soft keyboard, so the test
 * stands in a visualViewport it controls.
 */
async function emulateKeyboard(page: Page) {
  await page.addInitScript(() => {
    const fake = new EventTarget() as EventTarget & Record<string, number>;
    let covered = 0;
    let top = 0;
    Object.defineProperties(fake, {
      height: { get: () => window.innerHeight - covered },
      width: { get: () => window.innerWidth },
      offsetTop: { get: () => top },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => window.scrollY + top },
      pageLeft: { get: () => window.scrollX },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    (window as unknown as { keyboard: (px: number, offsetTop: number) => void }).keyboard = (px, offsetTop) => {
      covered = px;
      fake.dispatchEvent(new Event("resize"));
      if (offsetTop === top) return;
      top = offsetTop;
      fake.dispatchEvent(new Event("scroll"));
    };
  });
  return (px: number, offsetTop = 0) =>
    page.evaluate(
      ([value, scrolled]) =>
        (window as unknown as { keyboard: (px: number, offsetTop: number) => void }).keyboard(value, scrolled),
      [px, offsetTop] as const,
    );
}

/** What the person sees above the keyboard: everything the test names must be inside it. */
async function expectAboveKeyboard(
  page: Page,
  { keyboard, offsetTop = 0 }: { keyboard: number; offsetTop?: number },
  ...targets: ReturnType<Page["locator"]>[]
) {
  const bottom = offsetTop + (page.viewportSize()?.height ?? 0) - keyboard;
  for (const target of targets) {
    const box = await target.boundingBox();
    if (!box) throw new Error("not rendered");
    expect(box.y, `${target} starts in the visible part`).toBeGreaterThanOrEqual(offsetTop);
    expect(box.y + box.height, `${target} ends above the keyboard`).toBeLessThanOrEqual(bottom);
  }
}

test("on a phone the keyboard never covers Launch, the field being typed or an error", async ({ page }) => {
  const keyboard = await emulateKeyboard(page);
  await page.setViewportSize({ width: 390, height: 664 });
  await post("/__test/reset", { acmeModal: true });
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunch(page, "shared-golden", { advanced: false });
  const task = dialog.getByLabel("Task");
  const launch = dialog.getByRole("button", { name: "Launch", exact: true });
  await expect(task).toBeFocused();
  await keyboard(300);
  await task.fill("Fix the flaky login test");
  await expectAboveKeyboard(page, { keyboard: 300 }, task, launch);
  await page.screenshot({ path: "test-results/launch-keyboard-mobile.png", animations: "disabled" });

  // Safari scrolls the visible part to the field: the dialog follows it.
  await keyboard(300, 120);
  await expectAboveKeyboard(page, { keyboard: 300, offsetTop: 120 }, task, launch);
  await keyboard(0);

  // The usual order: a lower field is tapped first, then the keyboard opens over it.
  await dialog.locator("[data-launch-advanced] > summary").click();
  const effort = dialog.getByLabel("Reasoning effort");
  await effort.focus();
  await keyboard(300);
  await expectAboveKeyboard(page, { keyboard: 300 }, effort, launch);

  // A refused launch shows its reason next to Launch, above the keyboard, and keeps the task.
  await post("/__test/clear-legacy-boat", { org: ACME });
  await launch.click();
  const refusal = dialog.getByRole("alert");
  await expect(refusal).toBeFocused();
  await expectAboveKeyboard(page, { keyboard: 300 }, refusal, launch);
  await expect(task).toHaveValue("Fix the flaky login test");
  await page.screenshot({ path: "test-results/launch-keyboard-error-mobile.png", animations: "disabled" });

  // Closing the keyboard gives the dialog its normal bounds back.
  await keyboard(0);
  await expect(page.locator('[data-slot="dialog-content"]')).not.toHaveAttribute("data-visible-viewport");
  await expectPinnedLaunch(page);
});
