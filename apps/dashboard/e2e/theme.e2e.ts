import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

test("the theme can be switched to dark and stays", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.getByRole("button", { name: "Change theme" }).last().click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("the navigation fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, "alice@example.com");
  for (const name of ["Sandboxes", "Environments", "Tools", "Credentials", "Organizations"]) {
    await expect(page.getByRole("link", { name })).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
