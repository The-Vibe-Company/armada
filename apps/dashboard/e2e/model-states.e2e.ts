import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const DIAGNOSTIC = "HTTP 503: credential_id unavailable; image sha256:example";
async function failure(value: string | null) {
  expect(
    (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: JSON.stringify({ listFailure: value }) })).ok,
  ).toBe(true);
}
test.beforeEach(reset);

test("Models hides raw read diagnostics and reloads fresh account data on request", async ({ page }) => {
  await failure(DIAGNOSTIC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/harness");
  const alert = page.locator('[data-accounts="error"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Model accounts could not be loaded");
  await expect(alert).not.toContainText(DIAGNOSTIC);
  await page.screenshot({ path: "test-results/model-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/model-states-mobile.png", animations: "disabled" });
  await expect(page.getByRole("button", { name: "Add a model account", exact: true })).toHaveCount(0);
  await failure(null);
  await alert.getByRole("link", { name: "Reload Models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add a model account", exact: true })).toBeVisible();
  await expect(page.locator('[data-accounts="error"]')).toHaveCount(0);
});

test("Models without an organization gives one organization choice instead of an account form", async ({ page }) => {
  await signIn(page, "carol@example.com", "/harness");
  const main = page.getByRole("main");
  await expect(main.getByText("No organization yet", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(page.getByRole("button", { name: "Add a model account", exact: true })).toHaveCount(0);
});
