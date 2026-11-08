import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const SECRET = "sk-ant-oat01-super-secret-token";

test("a token is stored encrypted and never shown again", async ({ page }) => {
  await signIn(page, "alice@example.com", "/credentials");
  const mine = page.locator('[data-credentials="user"]');
  await mine.getByLabel("Kind").selectOption("claude_oauth");
  await mine.getByLabel("Value", { exact: true }).fill(SECRET);
  await mine.getByRole("button", { name: "Save credential" }).click();
  await expect(mine.getByText("Claude Code OAuth token saved.")).toBeVisible();

  await expect(mine.getByRole("img", { name: "Value hidden" })).toHaveCount(1);
  await page.reload();
  expect(await page.content()).not.toContain(SECRET);
  await expect(mine.getByLabel("Value", { exact: true })).toHaveValue("");

  const stored = (await (await fetch(`${MOCK}/__test/credentials`)).json()) as { kind: string; value_enc: string }[];
  const row = stored.find((item) => item.kind === "claude_oauth");
  expect(row?.value_enc.startsWith("\\x")).toBe(true);
  // iv (12) + token + tag (16) bytes, as hex, and not the token itself.
  expect(row?.value_enc.length).toBe(2 + 2 * (12 + SECRET.length + 16));
  expect(row?.value_enc).not.toContain(Buffer.from(SECRET).toString("hex"));

  await mine.getByRole("button", { name: "Remove Claude Code OAuth token" }).click();
  await expect(mine.getByRole("button", { name: "Remove Claude Code OAuth token" })).toHaveCount(0);
});

test("a value with spaces is refused before anything is stored", async ({ page }) => {
  await signIn(page, "alice@example.com", "/credentials");
  const mine = page.locator('[data-credentials="user"]');
  await mine.getByLabel("Value", { exact: true }).fill("two words");
  await mine.getByRole("button", { name: "Save credential" }).click();
  await expect(mine.locator('p[role="alert"]')).toContainText("no spaces");
});

test("an admin manages the org keys, a member only sees which are set", async ({ page }) => {
  await signIn(page, "alice@example.com", "/credentials");
  const org = page.locator('[data-credentials="Acme (org)"]');
  await expect(org.getByLabel("Value", { exact: true })).toBeVisible();
  await org.getByLabel("Kind").selectOption("boat");
  await org.getByLabel("Value", { exact: true }).fill("boat-org-key-123");
  await org.getByRole("button", { name: "Save credential" }).click();
  await expect(org.getByText("boat.dev API key saved.")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "bob@example.com", "/credentials");
  const bobsOrg = page.locator('[data-credentials="Acme (org)"]');
  await expect(bobsOrg.getByText("Only an admin changes them.")).toBeVisible();
  await expect(bobsOrg.getByRole("img", { name: "Value hidden" })).toHaveCount(2);
  await expect(bobsOrg.getByLabel("Value", { exact: true })).toHaveCount(0);
  await expect(bobsOrg.getByRole("button", { name: /Remove/ })).toHaveCount(0);
  expect(await page.content()).not.toContain("boat-org-key-123");
});
