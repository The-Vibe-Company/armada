import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const DIAGNOSTIC = "HTTP 503: secret_id unavailable; digest sha256:example";
async function failure(message: string | null, unsupported = false) {
  expect(
    (
      await fetch(`${MOCK}/__test/vault-list-failure`, {
        method: "POST",
        body: JSON.stringify({ message, unsupported }),
      })
    ).ok,
  ).toBe(true);
}
test.beforeEach(reset);

test("Variables read errors hide diagnostics and recover with a fresh metadata read", async ({ page }) => {
  await failure(DIAGNOSTIC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/variables");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("Variables could not be loaded");
  await expect(alert).not.toContainText(DIAGNOSTIC);
  await page.screenshot({ path: "test-results/variable-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/variable-states-mobile.png", animations: "disabled" });
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  await failure(null);
  await alert.getByRole("link", { name: "Reload Variables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText(/Variables are readable configuration, not secrets/)).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("Launches do not deliver these values");
});

test("an older vault API is not an empty inventory and has a readable update next step", async ({ page }) => {
  await failure(DIAGNOSTIC, true);
  await signIn(page, "alice@example.com", "/variables");
  const main = page.getByRole("main");
  await expect(main.getByText("Variable management needs an update", { exact: true })).toBeVisible();
  await expect(main).not.toContainText(DIAGNOSTIC);
  await expect(main).not.toContainText("No variables or secrets yet");
  await expect(main.getByRole("link", { name: "Reload Variables", exact: true })).toHaveAttribute("href", "/variables");
  await expect(main.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
});

test("Variables without an organization offers an organization choice before any vault form", async ({ page }) => {
  await signIn(page, "carol@example.com", "/variables");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(main.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
});
