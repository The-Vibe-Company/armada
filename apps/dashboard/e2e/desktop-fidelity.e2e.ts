import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

for (const theme of ["light", "dark"]) {
  test(`desktop fidelity management journey, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await signIn(page, "alice@example.com", "/variables");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText([
      "Name",
      "Value",
      "Kind",
      "Shared with",
      "Updated",
      "Actions",
    ]);
    const variable = table.locator('[data-vault-item="APP_REGION"]');
    await variable.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    const nav = page.getByRole("navigation", { name: "Main", exact: true });
    await nav.getByRole("link", { name: "Organization", exact: true }).click();
    await expect(page).toHaveURL(/\/orgs\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
    await expect(page.getByLabel("Active organization", { exact: true })).toBeVisible();
    const organization = page.getByLabel("Active organization", { exact: true });
    const largeId = await organization
      .locator("option")
      .filter({ hasText: /^Large$/ })
      .getAttribute("value");
    await organization.selectOption({ label: "Large" });
    await expect(page).toHaveURL(`/orgs/${largeId}`);
    await nav
      .getByRole("link", { name: /^Sandboxes/ })
      .first()
      .click();
    const placements = page.locator("article span[title]").filter({ hasText: "your server" });
    await expect(placements.first()).toBeVisible();
    for (const placement of await placements.all()) {
      const contained = await placement.evaluate((element) => {
        const cell = element.parentElement?.parentElement;
        return !!cell && element.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 1;
      });
      expect(contained).toBe(true);
    }
  });
}
