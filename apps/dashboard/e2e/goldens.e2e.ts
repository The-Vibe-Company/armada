import { expect, test } from "@playwright/test";
import { goldenPanel, goldenRow, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("a member sees the org goldens and only their own private ones", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  await expect(page.locator('[data-golden="shared-golden"]')).toBeVisible();
  await expect(page.locator('[data-golden="alice-private"]')).toBeVisible();
  await expect(page.getByText("bob-private")).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, "bob@example.com", "/environments");
  await expect(page.locator('[data-golden="bob-private"]')).toBeVisible();
  await expect(page.getByText("alice-private")).toHaveCount(0);
});

test("the owner shares a private golden with the org, and takes it back", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  const row = goldenRow(page, "alice-private");
  await expect(row.getByText("Private", { exact: true })).toBeVisible();
  const panel = await goldenPanel(page, "alice-private");
  await expect(panel.getByText("Not snapshotted")).toBeVisible();

  await panel.getByRole("button", { name: "Share with org" }).click();
  await expect(row.getByText("Org", { exact: true })).toBeVisible();
  // The panel stays open on the same environment while the page refreshes.
  await panel.getByRole("button", { name: "Make private" }).click();
  await expect(row.getByText("Private", { exact: true })).toBeVisible();
});

test("a member who is not an admin cannot share a golden", async ({ page }) => {
  await signIn(page, "bob@example.com", "/environments");
  const row = await goldenPanel(page, "bob-private");
  await expect(row.getByText("Org admins share goldens")).toBeVisible();
  await expect(row.getByRole("button", { name: /Share with org|Make private/ })).toHaveCount(0);
});
