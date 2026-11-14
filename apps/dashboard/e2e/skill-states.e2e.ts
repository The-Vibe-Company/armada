import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const DIAGNOSTIC = "HTTP 503: credential_kind unavailable; digest sha256:example";
async function failure(value: string | null) {
  expect(
    (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: JSON.stringify({ listFailure: value }) })).ok,
  ).toBe(true);
}
test.beforeEach(reset);

test("Skills read errors hide raw diagnostics and reload fresh key metadata", async ({ page }) => {
  await failure(DIAGNOSTIC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/skills");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("The Skillpack key could not be loaded");
  await expect(alert).not.toContainText(DIAGNOSTIC);
  await page.screenshot({ path: "test-results/skill-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/skill-states-mobile.png", animations: "disabled" });
  await expect(page.getByRole("button", { name: "Add key", exact: true })).toHaveCount(0);
  await failure(null);
  await alert.getByRole("link", { name: "Reload Skills", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add key", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Choose skills in supported launch dialogs or templates");
});

test("Skills without an organization gives an organization next step instead of key controls", async ({ page }) => {
  await signIn(page, "carol@example.com", "/skills");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(main.getByRole("button", { name: "Add key", exact: true })).toHaveCount(0);
});
