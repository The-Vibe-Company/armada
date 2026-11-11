import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);
const MORNING = "00000000-0000-4000-8000-000000002200";
const MODAL_TEMPLATE = "00000000-0000-4000-8000-000000000091";
const row = (page: Page, name: string) => page.locator(`[data-routine="${name}"]`);
const shownPanel = (page: Page, name: string) => page.locator(`[data-routine-panel="${name}"]`);
async function panel(page: Page, name: string) {
  const target = shownPanel(page, name);
  if (!(await target.isVisible())) await row(page, name).locator("[data-select-item]").click();
  await expect(target).toBeVisible();
  return target;
}
async function state(): Promise<{
  routines: {
    id: string;
    name: string;
    prompt: string;
    status: string;
    templateId: string;
    templateRevision: number;
    intervalHours: number;
  }[];
  routineCalls: { route: string; body: Record<string, unknown>; authorized: boolean }[];
}> {
  return (await fetch(`${MOCK}/__test/state`)).json();
}
async function configure(body: Record<string, unknown>) {
  expect((await fetch(`${MOCK}/__test/routines`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}

for (const mobile of [false, true]) {
  test(`routines show a quiet schedule list and readable selected history (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 });
    await signIn(page, "alice@example.com", "/routines");
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Routines/ }),
    ).toHaveAttribute("aria-current", "page");
    await expect(row(page, "Morning review")).toContainText(/Enabled/);
    await expect(row(page, "Release notes")).toContainText(/Paused/);
    await expect(row(page, "Bob private check")).toHaveCount(0);
    expect((await state()).routineCalls.filter((c) => c.route === "routines/history")).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1360);
    await page.screenshot({
      path: `test-results/routines-list-${mobile ? "phone" : "desktop"}.png`,
      animations: "disabled",
      fullPage: true,
    });
    const detail = await panel(page, "Morning review");
    await expect(detail.getByRole("heading", { name: "Run history" })).toBeVisible();
    await expect(detail.getByText("Skipped", { exact: true })).toBeVisible();
    await expect(detail.getByText(/Previous sandbox is still alive|previous sandbox is still alive/)).toBeVisible();
    await expect(detail.getByText(/finished/i).first()).toBeVisible();
    await expect(detail.locator('a[href="/sandboxes/00000000-0000-4000-8000-000000000030"]')).toBeVisible();
    expect((await state()).routineCalls.filter((c) => c.route === "routines/history")).toHaveLength(1);
    await page.screenshot({
      path: `test-results/routines-history-${mobile ? "phone" : "desktop"}.png`,
      animations: "disabled",
      fullPage: true,
    });
    // Close details before opening the centered creation flow on a phone.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New routine" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Prompt", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create routine", exact: true })).toBeInViewport();
    await page.screenshot({
      path: `test-results/routines-create-${mobile ? "phone" : "desktop"}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
  });
}

test("create pins a revision and preserves the prompt; enable/pause submit fresh optimistic versions", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/routines");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New routine" });
  await dialog.getByLabel("Name", { exact: true }).fill("Weekly notes");
  await dialog.getByLabel("Template", { exact: true }).selectOption(MODAL_TEMPLATE);
  const prompt = "  Summarize this week's changes.\nDo not edit files.  ";
  await dialog.getByLabel("Prompt", { exact: true }).fill(prompt);
  await dialog.getByLabel("Interval (hours)", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Create routine", exact: true }).click();
  await expect(dialog).toBeHidden();
  const created = row(page, "Weekly notes");
  await expect(created).toContainText("Paused");
  const saved = (await state()).routines.find((r) => r.name === "Weekly notes");
  expect(saved).toMatchObject({
    prompt,
    templateId: MODAL_TEMPLATE,
    templateRevision: 1,
    intervalHours: 1,
    status: "paused",
  });
  await page.getByRole("button", { name: "Enable Weekly notes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause Weekly notes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause Weekly notes", exact: true }).click();
  await expect(created).toContainText("Paused");
  const calls = (await state()).routineCalls;
  expect(calls.filter((c) => c.route === "routines/enable").at(-1)).toMatchObject({
    authorized: true,
    body: { id: saved!.id, expectedVersion: 1 },
  });
  expect(calls.filter((c) => c.route === "routines/pause").at(-1)).toMatchObject({
    authorized: true,
    body: { id: saved!.id, expectedVersion: 2 },
  });
});

test("create cannot be resubmitted while the server is still accepting its first request", async ({ page }) => {
  await signIn(page, "alice@example.com", "/routines");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New routine" });
  await dialog.getByLabel("Name", { exact: true }).fill("Pending review");
  await dialog.getByLabel("Template", { exact: true }).selectOption(MODAL_TEMPLATE);
  await dialog.getByLabel("Prompt", { exact: true }).fill("Read-only review.");
  await configure({ holdCreate: true });
  try {
    await dialog.getByRole("button", { name: "Create routine", exact: true }).click();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Create routine", exact: true })).toBeDisabled();
  } finally {
    await configure({ holdCreate: false });
  }
  await expect(dialog).toBeHidden();
  await expect(row(page, "Pending review")).toContainText("Paused");
  expect((await state()).routineCalls.filter((c) => c.route === "routines/create")).toHaveLength(1);
});

test("stale versions are readable refusals, not silent retry or duplicate schedule changes", async ({ page }) => {
  await signIn(page, "alice@example.com", "/routines");
  await configure({ stale: MORNING });
  await page.getByRole("button", { name: "Pause Morning review", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /refresh|changed|version/i })
      .first(),
  ).toBeVisible();
  expect((await state()).routineCalls.filter((c) => c.route === "routines/pause")).toHaveLength(1);
  expect((await state()).routines.find((r) => r.id === MORNING)?.status).toBe("enabled");
  await page.reload();
  await page.getByRole("button", { name: "Pause Morning review", exact: true }).click();
  await expect(row(page, "Morning review")).toContainText("Paused");
});

test("member reads shared history without another owner's sandbox links or shared mutation controls", async ({
  page,
}) => {
  await signIn(page, "bob@example.com", "/routines");
  await expect(row(page, "Morning review")).toBeVisible();
  await expect(row(page, "Release notes")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause Morning review", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable Bob private check", exact: true })).toBeVisible();
  const detail = await panel(page, "Morning review");
  await expect(detail.getByText("Skipped", { exact: true })).toBeVisible();
  await expect(detail.locator('a[href^="/sandboxes/"]')).toHaveCount(0);
});

test("empty and unavailable states stay actionable without echoing upstream error bodies", async ({ page }) => {
  await configure({ failure: { status: 503, code: "unavailable", message: "fixture-private-upstream-body" } });
  await signIn(page, "alice@example.com", "/routines");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("fixture-private-upstream-body");
  await configure({ failure: null, empty: true });
  await page.reload();
  await expect(page.getByText("No routines yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New routine" })).toBeVisible();
});
