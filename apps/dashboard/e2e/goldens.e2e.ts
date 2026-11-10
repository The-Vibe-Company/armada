import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

test("a member sees the org goldens and only their own private ones", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  await expect(page.locator('[data-golden="shared-golden"]')).toBeVisible();
  await expect(page.locator('[data-golden="alice-private"]')).toBeVisible();
  await expect(page.getByText("bob-private")).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, "bob@example.com", "/goldens");
  await expect(page.locator('[data-golden="bob-private"]')).toBeVisible();
  await expect(page.getByText("alice-private")).toHaveCount(0);
});

test("the owner shares a private golden with the org, and takes it back", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  const row = page.locator('[data-golden="alice-private"]');
  await expect(row.getByText("Private", { exact: true })).toBeVisible();
  await expect(row.getByText("Not snapshotted")).toBeVisible();

  await row.getByRole("button", { name: "Share with org" }).click();
  const shared = page.locator('[data-golden="alice-private"]');
  await expect(shared.getByText("Org", { exact: true })).toBeVisible();
  // The row moved to the shared list: the confirmation is a toast, not a line under a button that is gone.
  await expect(page.locator('[data-slot="toast"]')).toContainText("Shared alice-private with the org.");
  await page.screenshot({ path: "test-results/toast-share-golden.png", animations: "disabled" });
  await shared.getByRole("button", { name: "Make private" }).click();
  await expect(page.locator('[data-golden="alice-private"]').getByText("Private", { exact: true })).toBeVisible();
});

test("a member who is not an admin cannot share a golden", async ({ page }) => {
  await signIn(page, "bob@example.com", "/goldens");
  const row = page.locator('[data-golden="bob-private"]');
  await expect(row.getByText("Org admins share goldens")).toBeVisible();
  await expect(row.getByRole("button", { name: /Share with org|Make private/ })).toHaveCount(0);
});
