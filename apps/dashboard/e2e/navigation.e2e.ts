import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

// The browser boundary owns discoverability, active routes and phone menu behavior.
// Descriptive menu sub-text or broken route/menu interactions fail this contract.
for (const phone of [false, true]) {
  test(`relationship navigation stays usable on ${phone ? "phone" : "desktop"}`, async ({ page }) => {
    await page.setViewportSize({ width: phone ? 390 : 1280, height: phone ? 844 : 900 });
    await signIn(page, "alice@example.com", "/environments");
    await expect(page.getByLabel("Active organization", { exact: true })).toHaveCount(1);
    const nav = page.getByRole("navigation", { name: "Main", exact: true });
    const toggle = page.getByRole("button", { name: /Navigation/ });
    if (phone) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(nav.getByRole("link", { name: "Environments" })).toBeHidden();
      await toggle.click();
    }
    for (const label of ["Start with", "Give the agent", "Save a combination"]) {
      await expect(nav.getByRole("heading", { name: label, exact: true })).toBeVisible();
    }
    // The owner explicitly rejects explanatory sentences beneath menu labels.
    await expect(nav).not.toContainText("A machine and an agent account.");
    await expect(nav).not.toContainText("Tools, instructions and configuration.");
    await expect(nav).not.toContainText("Templates bring these choices together.");
    const environment = nav.getByRole("link", { name: "Environments", exact: true });
    await expect(environment).toHaveAttribute("aria-current", "page");
    await page.screenshot({
      animations: "disabled",
      path: `test-results/navigation-after-${phone ? "phone" : "desktop"}.png`,
    });
    if (phone) {
      await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(toggle).toBeFocused();
      await toggle.click();
    }
    const templates = nav.getByRole("link", { name: "Templates", exact: true });
    await templates.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/templates$/);
    if (phone) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toContainText("Templates");
      await toggle.click();
    }
    await expect(nav.getByRole("link", { name: "Templates", exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1280);
  });
}
