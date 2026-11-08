import { expect, test } from "@playwright/test";
import { alert, IDS, MOCK, signIn } from "./helpers";

const ACME = "00000000-0000-4000-8000-000000000010";
const ZENITH = "00000000-0000-4000-8000-000000000011";

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ multiOrg: true }) });
});

for (const mobile of [false, true]) {
  test(`switching scopes and persists from a detail (${mobile ? "mobile keyboard submission" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 800 });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const select = page.getByLabel("Active organization");
    await expect(select).toHaveValue(ACME);
    await select.selectOption(ZENITH);
    await expect(select).toHaveValue(ZENITH);
    await select.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sandboxes$/);
    await expect(select).toHaveValue(ZENITH);
    await expect(page.getByRole("link", { name: "bx_zenith" })).toBeVisible();
    await expect(page.getByText("bx_alice_running")).toHaveCount(0);
    await expect(page.getByLabel("Golden", { exact: true }).getByRole("option", { name: "shared-golden" })).toHaveCount(
      0,
    );
    await expect(
      page.getByLabel("Owner", { exact: true }).getByRole("option", { name: "bob@example.com" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(select).toHaveValue(ZENITH);
    await page.goto("/goldens");
    await expect(page.locator('[data-golden="zenith-golden"]')).toBeVisible();
    await expect(page.locator('[data-golden="shared-golden"]')).toHaveCount(0);
    await page.goto("/credentials");
    await expect(page.locator('[data-credentials="user"]')).toBeVisible();
    await expect(page.locator('[data-credentials="Zenith (org)"]')).toBeVisible();
    await expect(page.locator('[data-credentials="Acme (org)"]')).toHaveCount(0);
    await page.screenshot({ path: `test-results/organization-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.goto("/sandboxes?golden=00000000-0000-4000-8000-000000000023");
    await select.selectOption(ACME);
    await page.getByRole("button", { name: "Switch organization" }).click();
    await expect(page).toHaveURL(/\/sandboxes$/);
    await expect(page.getByRole("link", { name: "bx_alice_running" })).toBeVisible();
  });
}

test("forged and removed preferences fall back; forged switch is refused server-side", async ({ page, context }) => {
  await signIn(page, "alice@example.com");
  const select = page.getByLabel("Active organization");
  await select.evaluate((element) => {
    const option = document.createElement("option");
    option.value = "00000000-0000-4000-8000-000000000099";
    option.text = "Forged";
    element.append(option);
  });
  await select.selectOption("00000000-0000-4000-8000-000000000099");
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(alert(page)).toContainText("no longer available");
  await context.addCookies([{ name: "armada-org", value: "forged", url: page.url() }]);
  await page.reload();
  await expect(select).toHaveValue(ACME);
  await select.selectOption(ZENITH);
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(select).toHaveValue(ZENITH);
  await fetch(`${MOCK}/__test/remove-zenith-membership`, { method: "POST" });
  await page.reload();
  await expect(select).toHaveValue(ACME);
  await expect(page.getByText("bx_zenith")).toHaveCount(0);
});

test("mutation targets cannot escape the selected org even when the viewer administers the other org", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByLabel("Active organization").selectOption(ZENITH);
  await page.getByRole("button", { name: "Switch organization" }).click();
  const golden = page.locator('[data-golden="zenith-golden"]');
  await golden.locator('input[name="golden"]').evaluate((input) => {
    (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000020";
  });
  await golden.getByRole("button", { name: "Make private" }).click();
  await expect(alert(page)).toContainText("not available in this scope");
  await page.goto("/credentials");
  const personal = page.locator('[data-credentials="user"]');
  await personal.locator('input[name="scope"]').evaluate((input) => {
    (input as HTMLInputElement).value = "org";
  });
  await personal.locator('input[name="owner"]').evaluate((input) => {
    (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000010";
  });
  await personal.getByLabel("Value", { exact: true }).fill("throwaway-test-value");
  await personal.getByRole("button", { name: "Save credential" }).click();
  await expect(alert(page)).toContainText("Switch to that organization first");
});

test("without memberships the shell offers organization setup and no scoped resources", async ({ page }) => {
  await signIn(page, "carol@example.com");
  await expect(page.getByRole("link", { name: "Create an organization", exact: true })).toBeVisible();
  await expect(page.getByLabel("Active organization")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "bx_alice_running" })).toHaveCount(0);
  await page.getByRole("link", { name: "Create an organization", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create org", exact: true })).toBeVisible();
});
