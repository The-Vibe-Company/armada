import { expect, test } from "@playwright/test";
import { alert, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("an org is created, and inviting someone does not make them a member", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await expect(page.getByRole("link", { name: /Acme/ })).toBeVisible();

  await page.getByLabel("Name").fill("Side Project");
  await page.getByRole("button", { name: "Create org" }).click();
  // A new org starts by connecting a sandbox provider in Settings; its members page stays reachable.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('[data-settings="providers"]')).toContainText("Side Project");
  await page.goto("/orgs");
  await page.getByRole("link", { name: /Side Project/ }).click();
  await expect(page.getByRole("heading", { name: "Side Project" })).toBeVisible();
  await expect(page.locator('[data-member="alice@example.com"]')).toBeVisible();

  await page.getByLabel("Email").fill("carol@example.com");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation emailed to carol@example.com.")).toBeVisible();
  await expect(page.locator('[data-invitation="carol@example.com"]')).toBeVisible();
  await expect(page.locator('[data-member="carol@example.com"]')).toHaveCount(0);
});

test("an admin removes a member", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  const bob = page.locator('[data-member="bob@example.com"]');
  await bob.getByRole("button", { name: "Remove bob@example.com" }).click();
  // Removing is confirmed first, in the destructive dialog; cancelling keeps the member.
  const confirm = page.getByRole("alertdialog", { name: "Remove bob@example.com from Acme?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(bob).toBeVisible();
  await bob.getByRole("button", { name: "Remove bob@example.com" }).click();
  await confirm.getByRole("button", { name: "Remove member" }).click();
  await expect(page.locator('[data-member="bob@example.com"]')).toHaveCount(0);
});

test("a member sees the roster but no controls", async ({ page }) => {
  await signIn(page, "bob@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  await expect(page.locator('[data-member="alice@example.com"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Send invitation" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Invite a teammate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Remove/ })).toHaveCount(0);
});

test("the last admin cannot be demoted", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  const alice = page.locator('[data-member="alice@example.com"]');
  // Save appears only once the role differs, and giving up your own admin role asks first.
  await expect(alice.getByRole("button", { name: "Save" })).toHaveCount(0);
  await alice.getByLabel("Role of alice@example.com").selectOption("member");
  await alice.getByRole("button", { name: "Save" }).click();
  await page
    .getByRole("alertdialog", { name: "Give up admin of Acme?" })
    .getByRole("button", { name: "Make me a member" })
    .click();
  await expect(alert(page)).toContainText("keeps at least one admin");
});
