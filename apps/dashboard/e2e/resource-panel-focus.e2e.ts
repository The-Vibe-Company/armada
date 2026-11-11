import { expect, test } from "@playwright/test";
import { goldenPanel, goldenRow, reset, signIn } from "./helpers";

const PRIVATE = "00000000-0000-4000-8000-000000000021";
test.beforeEach(reset);

test("a direct mobile link owns focus and excludes the whole background; closing has a visible fallback", async ({ page }) => {
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
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(repository).toHaveValue("git@github.com:acme/retained.git");
  await expect(page.locator("[data-resource-panel]")).toHaveCount(1);
});
