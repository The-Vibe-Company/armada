import { expect, test } from "@playwright/test";
import { alert, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("an org is created, and its admin adds and removes a member", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await expect(page.getByRole("link", { name: /Acme/ })).toBeVisible();

  await page.getByLabel("Name").fill("Side Project");
  await page.getByRole("button", { name: "Create org" }).click();
  await expect(page.getByRole("heading", { name: "Side Project" })).toBeVisible();
  await expect(page.locator('[data-member="alice@example.com"]')).toBeVisible();

  await page.getByLabel("Email").fill("carol@example.com");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText("carol@example.com is now a member.")).toBeVisible();
  const carol = page.locator('[data-member="carol@example.com"]');
  await expect(carol).toBeVisible();

  await carol.getByRole("button", { name: "Remove carol@example.com" }).click();
  await expect(page.locator('[data-member="carol@example.com"]')).toHaveCount(0);
});

test("adding an email nobody signed up with says so", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  await page.getByLabel("Email").fill("ghost@example.com");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(alert(page)).toContainText("signs in to Armada once first");
});

test("a member sees the roster but no controls", async ({ page }) => {
  await signIn(page, "bob@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  await expect(page.locator('[data-member="alice@example.com"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Remove/ })).toHaveCount(0);
});

test("the last admin cannot be demoted", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  const alice = page.locator('[data-member="alice@example.com"]');
  await alice.getByLabel("Role of alice@example.com").selectOption("member");
  await alice.getByRole("button", { name: "Save" }).click();
  await expect(alert(page)).toContainText("keeps at least one admin");
});
