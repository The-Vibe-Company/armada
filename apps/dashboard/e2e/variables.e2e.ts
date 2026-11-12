import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

/** A disposable value that must never come back from the server or stay in the page. */
const CANARY = "e2e-canary-9f2c41d7";

const row = (page: Page, name: string) => page.locator(`[data-vault-item="${name}"]`).filter({ visible: true });
const panelOf = (page: Page, name: string) => page.locator(`[data-vault-panel="${name}"]`).filter({ visible: true });

async function panel(page: Page, name: string) {
  const shown = panelOf(page, name);
  if (!(await shown.isVisible())) {
    await leavePanel(page);
    await row(page, name).locator("[data-select-item]").click();
  }
  await expect(shown).toBeVisible();
  return shown;
}

async function leavePanel(page: Page) {
  const detail = page.getByRole("dialog").filter({ has: page.locator("[data-resource-panel]") });
  if (await detail.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
  }
}

async function openAdd(page: Page) {
  await leavePanel(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a variable or secret" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function mockState(): Promise<{
  vault: { name: string; sealed: boolean; value?: string; status: string }[];
  vaultCalls: { route: string; fields: string[]; authorized: boolean }[];
}> {
  return (await fetch(`${MOCK}/__test/state`)).json();
}

for (const mobile of [false, true]) {
  test(`variables and secrets share one list, readable at a glance, with a dialog to add (${mobile ? "phone" : "laptop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    await signIn(page, "alice@example.com", "/variables");
    const nav = page.getByRole("navigation", { name: "Main" });
    if (mobile) await page.getByRole("button", { name: /Navigation/ }).click();
    await expect(nav.getByRole("link", { name: /Variables/ })).toHaveAttribute("aria-current", "page");
    if (mobile) await page.keyboard.press("Escape");
    // Active first, by name; the revoked secret last. Bob's personal variable is not Alice's to see.
    await expect(page.getByRole("list", { name: "Variables and secrets" }).locator(":scope > li")).toHaveText([
      /ALICE_DEPLOY_TOKEN/,
      /APP_REGION/,
      /STRIPE_API_KEY/,
      /OLD_WEBHOOK_SECRET/,
    ]);
    await expect(row(page, "BOB_NOTES_URL")).toHaveCount(0);
    await expect(row(page, "STRIPE_API_KEY")).toContainText("Org");
    await expect(row(page, "STRIPE_API_KEY")).toContainText("Write-only");
    await expect(row(page, "ALICE_DEPLOY_TOKEN")).toContainText("Personal");
    await expect(row(page, "APP_REGION")).not.toContainText("Write-only");
    await expect(row(page, "APP_REGION")).toContainText("Variable · version 3");
    await expect(row(page, "OLD_WEBHOOK_SECRET")).toContainText("Revoked");
    if (!mobile) await expect(row(page, "STRIPE_API_KEY")).toContainText("Everyone in Acme");
    // A revoked secret is not a fault: no readiness strip, nothing in red.
    await expect(page.locator("[data-readiness]")).toHaveCount(0);
    await expect(page.locator(".text-destructive:visible, p[role=alert]:visible")).toHaveCount(0);
    await page.screenshot({ path: `test-results/variables-${mobile ? "phone" : "desktop"}.png`, fullPage: true });

    const dialog = await openAdd(page);
    // Both irreversible choices are marked; on a laptop the whole form shows without scrolling.
    await expect(dialog.getByRole("group", { name: /Kind/ })).toContainText("Cannot be changed later");
    await expect(dialog.getByRole("group", { name: /Who can use it/ })).toContainText("Cannot be changed later");
    await dialog.getByRole("radio", { name: /Secret/ }).check();
    await expect(dialog.getByText("nobody can read it back, admins included")).toBeVisible();
    if (!mobile) await expect(dialog.getByRole("button", { name: "Store secret" })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1280);
    await page.screenshot({ path: `test-results/variables-add-${mobile ? "phone" : "desktop"}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeFocused();
  });
}

test("a secret is stored once and never shown again: replace, revoke and delete work on metadata only", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/variables");
  const dialog = await openAdd(page);
  // Text typed for a variable never carries over, hidden, into a secret.
  await dialog.getByLabel("Value").fill("typed-as-a-variable");
  await dialog.getByRole("radio", { name: /Secret/ }).check();
  await expect(dialog.getByLabel("Secret value")).toHaveValue("");
  // Names are written the way an environment expects them; a reserved one is refused before sending.
  await dialog.getByLabel("Name").fill("github token");
  await expect(dialog.getByLabel("Name")).toHaveValue("GITHUB_TOKEN");
  await expect(dialog.getByText("Names starting with GITHUB_ are reserved")).toBeVisible();
  await dialog.getByLabel("Name").fill("SENTRY_DSN");
  await dialog.getByLabel("Secret value").fill(CANARY);
  await dialog.getByRole("button", { name: "Store secret" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("SENTRY_DSN is stored. Its value cannot be shown again.").first()).toBeVisible();

  const secret = await panel(page, "SENTRY_DSN");
  await expect(secret.locator("[data-write-only]")).toContainText("never shown, copied or exported");
  // No reveal control exists anywhere for a secret, and the value is nowhere in the page.
  await expect(secret.getByRole("button", { name: /Show|Reveal|Copy/ })).toHaveCount(0);
  expect(await page.content()).not.toContain(CANARY);
  let state = await mockState();
  expect(state.vault.find((item) => item.name === "SENTRY_DSN")?.sealed).toBe(true);
  expect(state.vaultCalls.filter((call) => call.route === "secrets/set")).toEqual([
    { route: "secrets/set", fields: ["name", "org", "scope", "value"], authorized: true },
  ]);
  expect(state.vaultCalls.some((call) => call.route === "secrets/read")).toBe(false);

  await secret.getByRole("button", { name: "Replace value" }).click();
  const replace = page.getByRole("dialog", { name: "Replace SENTRY_DSN" });
  await replace.getByLabel("Secret value").fill(`${CANARY}-2`);
  await replace.getByRole("button", { name: "Replace value" }).click();
  await expect(replace).toBeHidden();
  await expect(secret).toContainText("SENTRY_DSN has a new value (version 2).");
  await expect(row(page, "SENTRY_DSN")).toContainText("version 2");
  expect(await page.content()).not.toContain(CANARY);

  await secret.getByRole("button", { name: "Revoke" }).click();
  const revoke = page.getByRole("alertdialog", { name: "Revoke SENTRY_DSN?" });
  await revoke.getByRole("button", { name: "Revoke" }).click();
  await expect(row(page, "SENTRY_DSN")).toContainText("Revoked");
  await expect(secret.getByRole("button", { name: "Replace value" })).toHaveCount(0);
  state = await mockState();
  expect(state.vault.find((item) => item.name === "SENTRY_DSN")).toMatchObject({ status: "revoked", sealed: false });

  await secret.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog", { name: "Delete SENTRY_DSN?" }).getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "SENTRY_DSN")).toHaveCount(0);
  // The panel went with it: the toast confirms, and the focus lands on Add rather than on nothing.
  await expect(page.getByText("SENTRY_DSN is deleted.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeFocused();
});

test("a variable's value is read on request and edited as a new version", async ({ page }) => {
  await signIn(page, "alice@example.com", "/variables");
  const variable = await panel(page, "APP_REGION");
  await expect(variable.locator("[data-variable-value]")).toHaveCount(0);
  await variable.getByRole("button", { name: "Show value" }).click();
  await expect(variable.locator("[data-variable-value]")).toHaveText("eu-west-1");
  await variable.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit APP_REGION" });
  await expect(edit.getByLabel("Value")).toHaveValue("eu-west-1");
  await edit.getByLabel("Value").fill("us-east-2");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(variable).toContainText("APP_REGION is saved.");
  await expect(row(page, "APP_REGION")).toContainText("version 4");
  // A new version drops what was read: the value is read again on request.
  await expect(variable.locator("[data-variable-value]")).toHaveCount(0);
  await variable.getByRole("button", { name: "Show value" }).click();
  await expect(variable.locator("[data-variable-value]")).toHaveText("us-east-2");
});

test("a member reads org entries without controls and adds personal ones only", async ({ page }) => {
  await signIn(page, "bob@example.com", "/variables");
  await expect(row(page, "ALICE_DEPLOY_TOKEN")).toHaveCount(0);
  await expect(row(page, "BOB_NOTES_URL")).toContainText("Only you");
  const org = await panel(page, "STRIPE_API_KEY");
  await expect(org).toContainText("Managed by Acme's admins.");
  await expect(org.getByRole("button", { name: /Replace|Revoke|Delete/ })).toHaveCount(0);
  const region = await panel(page, "APP_REGION");
  await region.getByRole("button", { name: "Show value" }).click();
  await expect(region.locator("[data-variable-value]")).toHaveText("eu-west-1");
  await expect(region.getByRole("button", { name: "Edit" })).toHaveCount(0);

  const dialog = await openAdd(page);
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeDisabled();
  // A refused name keeps what was typed, so only the name needs fixing.
  await dialog.getByLabel("Name").fill("BOB_NOTES_URL");
  await dialog.getByLabel("Value").fill("eu-west-3");
  await dialog.getByRole("button", { name: "Save variable" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/name is already used/);
  await expect(dialog.getByLabel("Value")).toHaveValue("eu-west-3");
  await dialog.getByLabel("Name").fill("BOB_REGION");
  await dialog.getByRole("button", { name: "Save variable" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "BOB_REGION")).toContainText("Personal");
});

test("a change made elsewhere is refused as stale, without losing the page", async ({ page }) => {
  await signIn(page, "alice@example.com", "/variables");
  const secret = await panel(page, "ALICE_DEPLOY_TOKEN");
  // Another tab revokes it first: this page still holds version 1.
  const other = await fetch(`${MOCK}/__test/vault-revoke`, {
    method: "POST",
    body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000082" }),
  });
  expect(other.ok).toBe(true);
  await secret.getByRole("button", { name: "Replace value" }).click();
  const replace = page.getByRole("dialog", { name: "Replace ALICE_DEPLOY_TOKEN" });
  await replace.getByLabel("Secret value").fill(CANARY);
  await replace.getByRole("button", { name: "Replace value" }).click();
  await expect(replace.getByRole("alert")).toHaveText(/changed since this page loaded.*Refresh and try again/);
  await expect(replace.getByLabel("Secret value")).toHaveValue("");
});
