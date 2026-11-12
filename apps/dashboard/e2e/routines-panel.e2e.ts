import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`Routines overlay keeps list geometry and restores focus (${width}, ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await signIn(page, "alice@example.com", "/routines");
      const row = page.locator('[data-routine="Morning review"]').filter({ visible: true });
      const select = row.locator("[data-select-item]");
      await select.scrollIntoViewIfNeeded();
      const before = await row.boundingBox();
      await select.click();
      const panel = page.locator('[data-routine-panel="Morning review"]');
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Skipped", { exact: true })).toBeVisible();
      await page.screenshot({
        path: `test-results/routines-panel-${width}-${theme}.png`,
        fullPage: false,
        animations: "disabled",
      });
      const sheet = page.getByRole("dialog", { name: "Morning review", exact: true });
      await expect(sheet).toBeVisible();
      expect(await row.boundingBox()).toEqual(before);
      await expect(row).toHaveAttribute("data-selected", "true");
      await expect(page.locator("[data-resource-panel-title]")).toBeFocused();
      const bounds = await sheet.boundingBox();
      if (width === 390) expect(bounds?.width).toBe(width);
      else expect(bounds?.x).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(select).toBeFocused();
      await expect(page).toHaveURL(/\/routines$/);
    });
  }
}

test("Routines history, direct links, keyboard navigation and reload stay coherent", async ({ page }) => {
  await signIn(page, "alice@example.com", "/variables");
  await page.goto("/routines");
  const row = page.locator('[data-routine="Morning review"]').filter({ visible: true });
  for (const dismiss of ["back", "reload-back", "close", "outside"] as const) {
    await row.locator("[data-select-item]").click();
    const sheet = page.getByRole("dialog", { name: "Morning review", exact: true });
    await expect(sheet).toBeVisible();
    if (dismiss === "reload-back") {
      await page.reload();
      await expect(sheet).toBeVisible();
      await page.goBack();
    } else if (dismiss === "back") await page.evaluate(() => history.back());
    else if (dismiss === "close") await page.getByRole("button", { name: "Close the panel" }).click();
    else await page.mouse.click(10, 300);
    await expect(sheet).toBeHidden();
    await expect(row.locator("[data-select-item]")).toBeFocused();
  }
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/variables$/);
  // Native row links support new tabs; a direct load closes without leaving Routines.
  await page.goto("/routines");
  const href = await row.locator("[data-select-item]").getAttribute("href");
  expect(href).toContain("item=");
  if (!href) throw new Error("Routine row must be a shareable link");
  await page.goto(new URL(href, page.url()).href);
  const sheet = page.getByRole("dialog", { name: "Morning review", exact: true });
  await expect(sheet).toBeVisible();
  await page.reload();
  await expect(sheet).toBeVisible();
  const url = page.url();
  await page.keyboard.press("j");
  await expect(page).not.toHaveURL(url);
  await page.keyboard.press("k");
  await expect(page).toHaveURL(url);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(row.locator("[data-select-item]")).toBeFocused();
  await expect(page).toHaveURL(/\/routines$/);
});
