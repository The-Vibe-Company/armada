import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

// The shared layout owns this contract; page-specific suites own each form and action.
for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`resource details keep the list width and fit the viewport (${width}, ${theme})`, async ({ page }) => {
      await reset();
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await signIn(page, "alice@example.com", "/environments");
      for (const route of ["environments", "templates", "tools", "variables"]) {
        await page.goto(`/${route}`);
        const select = page.locator("[data-select-item]").first();
        const list = select.locator("xpath=ancestor::ul");
        const before = await list.boundingBox();
        await select.click();
        const panel = page.locator("#resource-panel");
        await expect(panel).toBeVisible();
        const after = await list.boundingBox();
        expect(after?.width).toBe(before?.width);
        const bounds = await panel.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (width >= 1024) {
          // Details are above, not beside the list or covering its first row.
          expect(bounds!.width).toBeCloseTo(after!.width, 0);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(after!.y);
        } else {
          await expect(page.getByRole("dialog")).toBeVisible();
        }
        await page.screenshot({ path: `test-results/resource-${route}-${width}-${theme}.png`, fullPage: true });
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(select).toBeFocused();
      }
    });
  }
}
