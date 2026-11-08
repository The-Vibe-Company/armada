import { expect, test } from "@playwright/test";
import { alert, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("a signed-out visitor is sent to the login page and back after signing in", async ({ page }) => {
  await page.goto("/credentials");
  await expect(page).toHaveURL(/\/login\?next=%2Fcredentials/);
  await expect(page.getByText("Sign in to Armada")).toBeVisible();

  await signIn(page, "alice@example.com", "/credentials");
  await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sandboxes" })).toBeVisible();
});

test("social login buttons show up when they are configured", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("a wrong code is refused with a clear message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(alert(page)).toHaveText("That code is wrong or has expired.");
  await expect(page).toHaveURL(/\/login/);
});

test("a login redirect cannot leave the site", async ({ page }) => {
  await signIn(page, "alice@example.com", "/sandboxes");
  await page.context().clearCookies();
  await page.goto("/login?next=https%3A%2F%2Fevil.example%2F");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes$/);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/sandboxes");
  await expect(page).toHaveURL(/\/login/);
});
