import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

// The browser boundary owns discoverability, active routes and phone menu behavior.
// Descriptive menu sub-text or broken route/menu interactions fail this contract.
for (const phone of [false, true])
  for (const theme of ["light", "dark"]) {
    test(`relationship navigation stays usable on ${phone ? "phone" : "desktop"}, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: phone ? 390 : 1280, height: phone ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await signIn(page, "alice@example.com", "/environments");
      await expect(page.getByLabel("Active organization", { exact: true })).toHaveCount(1);
      const nav = page.getByRole("navigation", { name: "Main", exact: true });
      const toggle = page.getByRole("button", { name: /Navigation/ });
      if (phone) {
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(nav.getByRole("link", { name: "Environments" })).toBeHidden();
        await toggle.click();
      }
      await expect(nav.getByRole("heading", { level: 2 })).toHaveText(["Run", "Library", "Account"]);
      for (const [label, items] of [
        ["Run", ["Sandboxes", "Routines", "Templates"]],
        ["Library", ["Environments", "Skills", "Tools", "Variables"]],
        ["Account", ["Models", "Organizations", "Settings"]],
      ] as const) {
        await expect(nav.getByRole("region", { name: label, exact: true }).getByRole("link")).toHaveText([...items]);
      }
      await expect(nav).not.toContainText("A machine and an agent account.");
      await expect(nav).not.toContainText("Tools, instructions and configuration.");
      await expect(nav).not.toContainText("Templates bring these choices together.");
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const environment = nav.getByRole("link", { name: "Environments", exact: true });
      await expect(environment).toHaveAttribute("aria-current", "page");
      await page.mouse.move(389, 843);
      await page.screenshot({
        animations: "disabled",
        path: `test-results/navigation-structure-after-${phone ? "phone" : "desktop"}-${theme}.png`,
      });
      if (!phone) {
        await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
        await expect.poll(async () => (await nav.boundingBox())?.width ?? Infinity).toBeLessThan(80);
        await expect(environment).toBeInViewport({ ratio: 1 });
        const firstBounds = await nav.getByRole("link", { name: "Sandboxes", exact: true }).evaluate((element) => {
          const content = element.closest('[data-slot="sidebar-content"]');
          if (!content) throw new Error("Missing sidebar viewport");
          return { top: element.getBoundingClientRect().top, viewportTop: content.getBoundingClientRect().top };
        });
        expect(firstBounds.top).toBeGreaterThanOrEqual(firstBounds.viewportTop);
        await page.mouse.move(1000, 100);
        await page.screenshot({
          path: `test-results/navigation-structure-after-collapsed-${theme}.png`,
          animations: "disabled",
        });
        await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
        await expect(page.getByLabel("Active organization", { exact: true })).toBeVisible();
      }
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
      await nav.getByRole("link", { name: "Models", exact: true }).click();
      await expect(page).toHaveURL(/\/harness$/);
      await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1280);
    });
  }
