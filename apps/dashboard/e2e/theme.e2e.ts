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
