import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test("a rejected provider replacement gives next steps without exposing the key", async ({ page }) => {
  await reset();
  await signIn(page, "alice@example.com", "/providers/cloud");
  const row = page.locator('[data-provider-row="boat"]');
  await row.getByRole("button", { name: "Replace key", exact: true }).click();
  const key = "example_provider_key_rejected";
  await row.getByLabel("Boat API key").fill(key);
  await row.getByRole("button", { name: "Save and replace", exact: true }).click();
  await expect(row.getByRole("alert")).toContainText("Check them in your provider account");
  await expect(row.getByRole("alert")).toContainText("The connected key is unchanged");
  await expect(row.getByLabel("Boat API key")).toHaveValue("");
  expect(await page.content()).not.toContain(key);
  await expect(row).toHaveAttribute("data-provider-state", "connected");
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await row.getByRole("alert").scrollIntoViewIfNeeded();
    await expect(row.getByRole("alert")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `test-results/provider-action-after-${name}.png`, fullPage: true });
  }
});
