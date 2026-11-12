import { expect, test } from "@playwright/test";
import { goldenPanel, goldenRow, MOCK, openCreate, reset, signIn } from "./helpers";

const PRIVATE = "00000000-0000-4000-8000-000000000021";
test.beforeEach(reset);

test("a direct mobile link owns focus and excludes the whole background; closing has a visible fallback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", `/environments?item=${PRIVATE}`);
  const sheet = page.getByRole("dialog", { name: "alice-private", exact: true });
  await expect(sheet).toBeVisible();
  await expect(page.locator("[data-resource-panel-title]")).toBeFocused();
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  for (const key of ["Shift+Tab", "Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(goldenRow(page, "alice-private").locator("[data-select-item]")).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]item=/);
});

test("one detail tree retains a draft through selections, closure and mobile/desktop transitions", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  const panel = await goldenPanel(page, "alice-private");
  const repository = panel.getByRole("textbox", { name: "Repository 1", exact: true });
  await repository.fill("git@github.com:acme/retained.git");
  await goldenPanel(page, "shared-golden");
  await goldenPanel(page, "alice-private");
  await expect(repository).toHaveValue("git@github.com:acme/retained.git");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "alice-private", exact: true })).toBeVisible();
  await expect(repository).toHaveValue("git@github.com:acme/retained.git");
  await page.keyboard.press("Escape");
  await expect(goldenRow(page, "alice-private").locator("[data-select-item]")).toBeFocused();
  await goldenPanel(page, "alice-private");
  await expect(repository).toHaveValue("git@github.com:acme/retained.git");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("dialog", { name: "alice-private", exact: true })).toBeVisible();
  await expect(repository).toHaveValue("git@github.com:acme/retained.git");
  await expect(page.locator("[data-resource-panel]")).toHaveCount(1);
});

test("a nested confirmation closes before the sheet and restores its row opener", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", "/environments");
  const panel = await goldenPanel(page, "shared-golden");
  const remove = panel.getByRole("button", { name: "Remove golden" });
  await remove.click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(remove).toBeFocused();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(goldenRow(page, "shared-golden").locator("[data-select-item]")).toBeFocused();
});

test("a pending rebuild keeps following its job through sheet closure and breakpoint changes", async ({ page }) => {
  const gate = await fetch(`${MOCK}/__test/golden-gate`, { method: "POST", body: JSON.stringify({ hold: true }) });
  expect(gate.ok).toBe(true);
  await signIn(page, "alice@example.com", "/environments");
  const panel = await goldenPanel(page, "shared-golden");
  await panel.getByText("Edit and rebuild").click();
  const form = panel.locator('form[data-golden-form="update"]');
  await form.getByLabel("Branch").first().fill("retained");
  await form.getByRole("button", { name: "Rebuild golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  const tracking = new URL(page.url()).searchParams.get("build.rebuild.00000000-0000-4000-8000-000000000020");
  expect(tracking).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  await page.keyboard.press("Escape");
  await goldenPanel(page, "alice-private");
  await page.keyboard.press("Escape");
  await goldenPanel(page, "shared-golden");
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  await expect(form.getByRole("button", { name: "Rebuild golden" })).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  expect(new URL(page.url()).searchParams.get("build.rebuild.00000000-0000-4000-8000-000000000020")).toBe(tracking);
});

test("desktop details overlay without moving the list; history, keyboard navigation and outside dismissal stay coherent", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  const row = goldenRow(page, "shared-golden");
  const before = await row.boundingBox();
  const panel = await goldenPanel(page, "shared-golden");
  const sheet = page.getByRole("dialog", { name: "shared-golden", exact: true });
  await expect(sheet).toBeVisible();
  expect(await row.boundingBox()).toEqual(before);
  await expect(row).toHaveAttribute("data-selected", "true");
  const selectedUrl = page.url();
  await page.evaluate(() => window.history.back());
  await expect(panel).toBeHidden();
  await expect(row.locator("[data-select-item]")).toBeFocused();
  await page.evaluate(() => window.history.forward());
  await expect(sheet).toBeVisible();
  await page.reload();
  await expect(sheet).toBeVisible();
  await expect(page.locator("[data-resource-panel-title]")).toBeFocused();
  await page.keyboard.press("k");
  await expect(page).not.toHaveURL(selectedUrl);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(selectedUrl);
  await page.mouse.click(10, 300);
  await expect(sheet).toBeHidden();
  await expect(row.locator("[data-select-item]")).toBeFocused();
});

// One owner-boundary sequence table: catches both duplicate list entries and
// loss of rebuild recovery state, including native Back and reload.
for (const scenario of [
  { name: "Escape", rebuild: false, direct: false, reload: false, dismiss: "escape" },
  { name: "close button after rebuild", rebuild: true, direct: false, reload: false, dismiss: "close" },
  { name: "Back after rebuild and reload", rebuild: true, direct: false, reload: true, dismiss: "back" },
  { name: "outside after rebuild", rebuild: true, direct: false, reload: false, dismiss: "outside" },
  { name: "direct link Escape after rebuild", rebuild: true, direct: true, reload: false, dismiss: "escape" },
]) {
  test(`panel history sequence: ${scenario.name}`, async ({ page }) => {
    await fetch(`${MOCK}/__test/golden-gate`, { method: "POST", body: JSON.stringify({ hold: true }) });
    await signIn(page, "alice@example.com", "/templates");
    await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
    await page.goto(scenario.direct ? "/environments?item=00000000-0000-4000-8000-000000000020" : "/environments");
    const row = goldenRow(page, "shared-golden");
    const baseline = await page.evaluate(() => window.history.length);
    const panel = await goldenPanel(page, "shared-golden");
    let tracking: string | null = null;
    const buildKey = "build.rebuild.00000000-0000-4000-8000-000000000020";
    if (scenario.rebuild) {
      await panel.getByText("Edit and rebuild").click();
      const form = panel.locator('form[data-golden-form="update"]');
      await form.getByLabel("Branch").first().fill("history-regression");
      await form.getByRole("button", { name: "Rebuild golden" }).click();
      await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
      tracking = new URL(page.url()).searchParams.get(buildKey);
      expect(tracking).toBeTruthy();
    }
    if (scenario.reload) await page.reload();
    if (scenario.dismiss === "back") await page.goBack();
    else if (scenario.dismiss === "close") await page.getByRole("button", { name: "Close the panel" }).click();
    else if (scenario.dismiss === "outside") await page.mouse.click(10, 300);
    else await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(row.locator("[data-select-item]")).toBeFocused();
    expect(new URL(page.url()).searchParams.has("item")).toBe(false);
    expect(new URL(page.url()).searchParams.get(buildKey)).toBe(tracking);
    // Reopening and closing must not grow the stack or drop recovery state.
    await goldenPanel(page, "shared-golden");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => window.history.length)).toBe(baseline + 1);
    await page.reload();
    await expect(panel).toBeHidden();
    expect(new URL(page.url()).searchParams.get(buildKey)).toBe(tracking);
    await page.goBack();
    await expect(page).toHaveURL(/\/templates$/);
  });
}

test("Forward through an older detail does not erase a newer list-side build", async ({ page }) => {
  await fetch(`${MOCK}/__test/golden-gate`, { method: "POST", body: JSON.stringify({ hold: true }) });
  await signIn(page, "alice@example.com", "/environments");
  const panel = await goldenPanel(page, "shared-golden");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  const form = await openCreate(page);
  await form.getByLabel("Name").fill("history-new-build");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  const recovery = new URL(page.url()).search;
  expect(recovery).toContain("build.create.");
  await page.keyboard.press("Escape");
  await page.goForward();
  await expect(panel).toBeVisible();
  await page.goBack();
  await expect(panel).toBeHidden();
  expect(new URL(page.url()).search).toBe(recovery);
  await page.reload();
  expect(new URL(page.url()).search).toBe(recovery);
});

test("hydration reconciles selection when native history changed before panel subscriptions", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  // Native Back can change the URL before the new document's React effects
  // subscribe. Reproduce that missing-event boundary, not an arbitrary delay.
  await page.addInitScript(() => {
    const url = new URL(location.href);
    if (url.pathname === "/environments" && url.searchParams.has("item")) {
      url.searchParams.delete("item");
      history.replaceState(null, "", url);
    }
  });
  await page.goto(`/environments?item=${PRIVATE}&source=history-handoff`);
  await expect(goldenRow(page, "alice-private")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "alice-private", exact: true })).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]item=/);
  expect(new URL(page.url()).searchParams.get("source")).toBe("history-handoff");
});
