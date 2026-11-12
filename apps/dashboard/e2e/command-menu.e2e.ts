import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

test("the command menu opens from the keyboard, finds a page by a few letters and goes there", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search pages and actions" });
  await expect(search).toBeFocused();
  await search.fill("mcp");
  await expect(page.getByRole("option")).toHaveText(["Tools"]);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/tools");
  await expect(search).toHaveCount(0);

  // Arrows choose among several results; Escape closes without going anywhere.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await search.fill("sandbox");
  await expect(page.getByRole("option")).toHaveText(["Sandboxes", "Launch a sandbox", "Connect a sandbox provider"]);
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("option", { selected: true })).toHaveText("Connect a sandbox provider");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toHaveText("Sandboxes");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toHaveText("Launch a sandbox");
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(page).toHaveURL(/\/tools$/);

  const trigger = page.getByRole("button", { name: "Search", exact: true });
  await trigger.click();
  const close = page.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/\/tools$/);

  await trigger.click();
  await expect(search).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Results" })).toContainText("Actions");
  await expect(page.getByRole("listbox", { name: "Results" })).toContainText("Go to");
  await search.fill("zzz");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(page.getByText("Nothing matches “zzz”.", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await search.fill("sandbox");
  await expect(page.getByRole("option", { selected: true })).toHaveText("Sandboxes");
  const provider = page.getByRole("option", { name: "Connect a sandbox provider", exact: true });
  await provider.hover();
  await expect(provider).toHaveAttribute("aria-selected", "true");
  await provider.click();
  await page.waitForURL("**/settings");
  await expect(search).toHaveCount(0);

  await trigger.click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
