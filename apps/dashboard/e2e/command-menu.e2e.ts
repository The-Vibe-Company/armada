import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

test("the command menu opens from the keyboard, finds a page by a few letters and goes there", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search pages and actions" });
  await expect(search).toBeFocused();
  await search.fill("mcp");
  await expect(page.getByRole("option")).toHaveText(["Connections"]);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/connections");
  await expect(search).toHaveCount(0);

  // Arrows choose among several results; Escape closes without going anywhere.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await search.fill("sandbox");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toHaveText("Launch a sandbox");
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(page).toHaveURL(/\/connections$/);
});
