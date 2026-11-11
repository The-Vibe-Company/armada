import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

// Owns responsive toolbar geometry; filter semantics and navigation live in sandboxes.e2e.ts.
for (const theme of ["light", "dark"] as const) {
  test(`the toolbar keeps search and sort together without overflow in ${theme} mode`, async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, "alice@example.com");
    await page.getByRole("heading", { name: "Sandboxes", exact: true }).waitFor();
    await page.evaluate((value) => localStorage.setItem("theme", value), theme);
    for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const [state, query] of [
        ["default", ""],
        ["active", "?status=running&status=failed&provider=boat&provider=modal&harness=claude&harness=codex&owner=me"],
      ] as const) {
        await page.goto(`/sandboxes${query}`);
        const toolbar = page.getByRole("region", { name: "Filters", exact: true });
        const search = toolbar.getByLabel("Search sandboxes");
        const sort = toolbar.getByLabel("Sort sandboxes");
        const facet = toolbar.getByRole("button", { name: /^Status/ }).first();
        await expect(sort).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const [searchBox, sortBox, facetBox] = await Promise.all([
          search.boundingBox(),
          sort.boundingBox(),
          facet.boundingBox(),
        ]);
        if (!searchBox || !sortBox || !facetBox) throw new Error("Toolbar controls must have visible bounds");
        // Search must remain readable; sort may share its row or deliberately stack,
        // but must never trail the wrapping facet row.
        expect(searchBox.width).toBeGreaterThanOrEqual(200);
        expect(Math.abs(searchBox.y - sortBox.y) <= 2 || sortBox.y >= searchBox.y + searchBox.height).toBe(true);
        expect(sortBox.y + sortBox.height).toBeLessThanOrEqual(facetBox.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        await page.screenshot({
          path: `test-results/toolbar-fit-${width}-${theme}-${state}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  });
}
