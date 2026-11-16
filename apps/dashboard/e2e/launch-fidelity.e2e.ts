import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

test("closed launch settings retain choices and submit a task with the pinned footer", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.getByRole("button", { name: "Launch a sandbox", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Launch a sandbox", exact: true });
  await expect(dialog.getByRole("button", { name: "Launch idle", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Options settings", exact: true }).click();
  await dialog.getByRole("button", { name: /^Stops after:/ }).click();
  await page.getByRole("option", { name: "1 hour", exact: true }).click();
  await dialog.getByLabel("Task", { exact: true }).fill("Review the parser");
  await page.setViewportSize({ width: 390, height: 844 });
  const submit = dialog.getByRole("button", { name: "Launch", exact: true });
  await expect(submit).toBeInViewport({ ratio: 1 });
  const payload = await dialog.locator("form").evaluate((form) => Object.fromEntries(new FormData(form)));
  expect(payload).toMatchObject({
    prompt: "Review the parser",
    ttl: "3600",
    harness: "claude",
    model: "claude-opus-5-5",
  });
  await submit.click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
});
