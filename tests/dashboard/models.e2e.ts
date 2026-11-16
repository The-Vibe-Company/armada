import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Protects the provider disclosure and wizard navigation at their user-facing boundary.
for (const session of ["alice", "large"]) {
  test(`${session}: inspect a provider and configure an API account`, { session }, async ({ app, screen, browser }) => {
    await app.open("/harness");
    const row = browser.locator("[data-account]").first();
    const toggle = browser.locator("[data-account] button[aria-expanded]").first();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByText("Status", { exact: true })).toBeVisible();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", "Add account", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "Add provider");
    await dialog.getByRole("button", "OpenAI API key").tap();
    await dialog.getByRole("button", "Continue", { exact: true }).tap();
    await dialog.getByLabel("Name", { exact: true }).fill("Journey model connection");
    await dialog.getByLabel("Maximum agents running at the same time").fill("0");
    await dialog.getByRole("button", "Continue to configuration").tap();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
    await dialog.getByLabel("Maximum agents running at the same time").fill("2");
    await dialog.getByRole("button", "Continue to configuration").tap();
    await expect(dialog.getByLabel("API key", { exact: true })).toBeVisible();
    await dialog.getByRole("button", "Back", { exact: true }).tap();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Journey model connection");
    await dialog.getByRole("button", "Continue to configuration").tap();
    await dialog.getByLabel("API key", { exact: true }).fill("example_api_key");
    await dialog.getByRole("button", "Add account", { exact: true }).tap();
    await expect(dialog).toBeHidden();
    const added = browser.locator('[data-account="Journey model connection"]');
    await expect(added).toBeVisible();
    await added.getByRole("button", /^Journey model connection/).tap();
    await added.getByLabel("Display name").fill("Journey renamed connection");
    await added.getByRole("button", "Save name", { exact: true }).tap();
    const renamed = browser.locator('[data-account="Journey renamed connection"]');
    await expect(renamed).toBeVisible();
    await renamed.getByRole("button", /^More actions for/).tap();
    await screen.getByRole("menuitem", "Remove", { exact: true }).tap();
    await screen.getByRole("button", "Remove account", { exact: true }).tap();
    await expect(renamed).toHaveCount(0);
  });
}
