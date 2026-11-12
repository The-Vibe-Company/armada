import { expect, test } from "@playwright/test";
import { goldenPanel, goldenRow, MOCK, reset, signIn } from "./helpers";

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
