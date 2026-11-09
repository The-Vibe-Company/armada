import { expect, type Page, test } from "@playwright/test";
import { alert, MOCK, signIn } from "./helpers";

/** Organization sandbox provider onboarding (#576): readiness is the server's, read again on every visit. */

const ACME = "00000000-0000-4000-8000-000000000010";
const ZENITH = "00000000-0000-4000-8000-000000000011";
const ORION = "00000000-0000-4000-8000-000000000013";
const SETUP = /\/orgs\/[0-9a-f-]{36}\/setup$/;
const BOAT_KEY = "bk_live_e2e_value_123";
const MODAL_ID = "ak-AbCdEf123456";
const MODAL_SECRET = "as-ZyXwVu987654";

async function post(path: string, body: object = {}) {
  const response = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return response.json();
}

type ProviderCall = { route: string; body: Record<string, unknown>; authorized: boolean };
async function providerCalls(): Promise<ProviderCall[]> {
  return (await post("/__test/state")).providerCalls;
}
async function connects(): Promise<ProviderCall[]> {
  return (await providerCalls()).filter((call) => call.route === "org/provider/connect");
}

async function createOrg(page: Page, name: string): Promise<string> {
  await page.goto("/orgs");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create org" }).click();
  await expect(page).toHaveURL(SETUP);
  return page.url().split("/orgs/")[1]?.split("/")[0] ?? "";
}

test.beforeEach(async () => {
  await post("/__test/reset", { multiOrg: true, orionOrg: true });
});

test("a new org resumes its setup on reload, deep links and forged completion; a rejected key is not echoed", async ({
  page,
  context,
}) => {
  await signIn(page, "alice@example.com", "/orgs");
  const org = await createOrg(page, "Side Project");
  await expect(page.getByRole("heading", { name: "Sandbox provider for Side Project" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Boat/ })).toBeChecked();
  await expect(page.getByLabel("Boat API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("link", { name: /Get a Boat API key/ })).toHaveAttribute("href", "https://docs.boat.dev");

  await page.reload();
  await expect(page).toHaveURL(SETUP);
  // New work routes back to setup; a query flag or a cookie claiming completion changes nothing.
  for (const path of ["/", "/goldens", "/goldens?connected=boat", "/sandboxes"]) {
    await page.goto(path);
    await expect(page).toHaveURL(`/orgs/${org}/setup`);
  }
  await context.addCookies([{ name: "armada-setup", value: "done", url: page.url() }]);
  await page.goto("/goldens");
  await expect(page).toHaveURL(`/orgs/${org}/setup`);
  // Management stays reachable: credentials, members, settings, the org list.
  for (const path of ["/credentials", `/orgs/${org}`, "/settings", "/orgs", "/connections"]) {
    await page.goto(path);
    await expect(page).toHaveURL(path);
  }

  await page.goto(`/orgs/${org}/setup`);
  await page.getByLabel("Boat API key", { exact: true }).fill(`${BOAT_KEY}-rejected`);
  await page.getByRole("button", { name: "Connect Boat" }).click();
  await expect(alert(page)).toHaveText("Boat refused these credentials.");
  await expect(page.locator("body")).not.toContainText(BOAT_KEY);
  await expect(page).toHaveURL(SETUP);
  const sent = await connects();
  // One request per submit, never retried, for the org on the page.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toEqual({ org, provider: "boat", value: `${BOAT_KEY}-rejected` });
  const stored = (await post("/__test/credentials")) as { owner_id: string; value_enc: string }[];
  expect(stored.filter((row) => row.owner_id === org)).toHaveLength(0);
  expect(JSON.stringify(stored)).not.toContain(BOAT_KEY);
});

test("switching provider sends only Modal's pair; success leads to goldens; removing the key makes setup pending again", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/orgs");
  const org = await createOrg(page, "Side Project");
  await page.getByLabel("Boat API key", { exact: true }).fill(BOAT_KEY);
  await page.getByText("Modal", { exact: true }).click();
  await expect(page.getByLabel("Boat API key", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Token ID", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Token secret", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("Token ID", { exact: true }).fill(MODAL_ID);
  await page.getByLabel("Token secret", { exact: true }).fill(MODAL_SECRET);
  await page.getByRole("button", { name: "Connect Modal" }).click();

  await expect(page).toHaveURL(/\/goldens\?connected=modal$/);
  await expect(page.locator("[data-provider-connected]")).toHaveText("Modal connected");
  await expect(page.getByRole("heading", { name: "Build a golden" })).toBeVisible();
  const sent = await connects();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body.provider).toBe("modal");
  expect(JSON.parse(String(sent[0]?.body.value))).toEqual({ token_id: MODAL_ID, token_secret: MODAL_SECRET });
  expect(JSON.stringify(sent)).not.toContain(BOAT_KEY);
  await expect(page.locator("body")).not.toContainText(MODAL_SECRET);

  await page.goto(`/orgs/${org}/setup`);
  await expect(page.locator('[data-setup-state="ready"]')).toContainText("Modal connected");
  await page.goto("/");
  await expect(page).toHaveURL(/\/sandboxes$/);

  // The org's Modal token is removed: new work needs setup again.
  await page.goto("/credentials");
  await page
    .locator('[data-credentials="Side Project (org)"]')
    .getByRole("button", { name: "Remove Modal token" })
    .click();
  await expect(
    page.locator('[data-credentials="Side Project (org)"]').getByRole("button", { name: "Remove Modal token" }),
  ).toHaveCount(0);
  await page.goto("/goldens");
  await expect(page).toHaveURL(`/orgs/${org}/setup`);
  await expect(page.locator('[data-setup-state="pending"]')).toBeVisible();
});

test("a post for another org is refused before it reaches the server", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orgs");
  await createOrg(page, "Side Project");
  // Alice administers Acme too, but Side Project is the selected org.
  await page
    .locator('input[name="org"]')
    .first()
    .evaluate((input, acme) => {
      (input as HTMLInputElement).value = acme;
    }, ACME);
  await page.getByLabel("Boat API key", { exact: true }).fill(BOAT_KEY);
  await page.getByRole("button", { name: "Connect Boat" }).click();
  await expect(alert(page)).toHaveText("Switch to that organization first.");
  expect(await connects()).toHaveLength(0);
});

test("a member waits for an admin, sees no credential field, and keeps switching and running sandboxes", async ({
  page,
}) => {
  await post("/__test/reset", { orionOrg: true, orionSandbox: true });
  await signIn(page, "bob@example.com");
  // Acme (ready, by its legacy Boat column) comes first and opens directly.
  await expect(page).toHaveURL(/\/sandboxes$/);
  const select = page.getByLabel("Active organization");
  await select.selectOption(ORION);
  await page.getByRole("button", { name: "Switch organization" }).click();
  // Orion has a running sandbox: it stays listed and stoppable; only new work is held.
  await expect(page).toHaveURL(/\/sandboxes$/);
  await expect(page.getByRole("link", { name: "bx_orion_running" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Launch a sandbox" })).toHaveCount(0);
  await page.getByRole("link", { name: "bx_orion_running" }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.goto("/sandboxes");
  await page.getByRole("link", { name: "Set up a provider" }).click();
  await expect(page).toHaveURL(`/orgs/${ORION}/setup`);
  const waiting = page.locator('[data-setup-state="waiting"]');
  await expect(waiting).toContainText("Waiting for an admin");
  await expect(waiting.getByRole("link", { name: "carol@example.com" })).toHaveAttribute(
    "href",
    "mailto:carol@example.com",
  );
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Connect/ })).toHaveCount(0);

  // Switching away from the setup page lands on the other org's page, not back in setup.
  await select.selectOption(ACME);
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(page).toHaveURL(`/orgs/${ACME}`);
});

test("existing orgs are ready from a legacy column, a Boat row or a Modal row; a personal key never is", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", `/orgs/${ACME}/setup`);
  await expect(page.locator('[data-setup-state="ready"]')).toContainText("Boat connected");
  await page.getByLabel("Active organization").selectOption(ZENITH);
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(page.locator('[data-setup-state="ready"]')).toContainText("Boat connected");

  // Carol holds a personal Boat key; Orion still has no org provider.
  await post("/__test/reset", { orionOrg: true });
  await page.context().clearCookies();
  await signIn(page, "carol@example.com", `/orgs/${ORION}/setup`);
  await page.goto("/");
  await expect(page).toHaveURL(`/orgs/${ORION}/setup`);
  await expect(page.locator('[data-setup-state="pending"]')).toBeVisible();

  await post("/__test/reset", { orionOrg: true, orionModal: true });
  await page.context().clearCookies();
  await signIn(page, "carol@example.com", `/orgs/${ORION}/setup`);
  await expect(page.locator('[data-setup-state="ready"]')).toContainText("Modal connected");
});

test("a deep link to another org's setup offers the switch first", async ({ page }) => {
  await post("/__test/reset", { orionOrg: true });
  await signIn(page, "bob@example.com", `/orgs/${ORION}/setup`);
  await page.getByRole("button", { name: "Switch to Orion" }).click();
  await expect(page.getByLabel("Active organization")).toHaveValue(ORION);
  await expect(page.locator('[data-setup-state="waiting"]')).toBeVisible();
  await page.goto("/orgs/00000000-0000-4000-8000-000000000099/setup");
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});

test("an unavailable status is a retryable error, never ready and never retried on its own", async ({ page }) => {
  await post("/__test/reset", { orionOrg: true });
  await post("/__test/provider-status-fail", {
    fail: { status: 503, code: "unavailable", message: "Try again soon." },
  });
  await signIn(page, "carol@example.com", `/orgs/${ORION}/setup`);
  await expect(page.locator('[data-setup-state="unavailable"]')).toContainText("Try again soon.");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.goto("/goldens");
  await expect(page.locator('[data-setup-state="unavailable"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build a golden" })).toHaveCount(0);
  expect(await connects()).toHaveLength(0);
  // A create build this page already tracks keeps its form to follow the job.
  await page.goto(`/goldens?build-key.create.${ORION}=6f1c2d3e-4b5a-4c6d-8e7f-901234567890`);
  await expect(page.locator('[data-setup-state="unavailable"]')).toBeVisible();
  await expect(page.locator('form[data-golden-form="create"]')).toHaveCount(1);
  // The stale key settles without an active job; the form still cannot submit a new build.
  await expect(
    page.locator('form[data-golden-form="create"]').getByRole("button", { name: "Build golden" }),
  ).toBeDisabled();

  await post("/__test/provider-status-fail", {});
  await page.goto(`/orgs/${ORION}/setup`);
  await expect(page.locator('[data-setup-state="pending"]')).toBeVisible();
});

test("a launch from a page rendered while ready is refused once the org has lost its provider", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("First prompt").fill("Ship it");
  await post("/__test/clear-legacy-boat", { org: ACME });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Connect a sandbox provider for this organization first");
  expect((await post("/__test/state")).launches).toHaveLength(0);
});

test("after its provider is removed, an org keeps managing existing goldens; only new work is paused", async ({
  page,
}) => {
  await post("/__test/clear-legacy-boat", { org: ACME });
  await signIn(page, "alice@example.com", "/goldens");
  // Existing goldens to manage: no redirect, a setup link, and no build, rebuild or launch control.
  await expect(page).toHaveURL(/\/goldens$/);
  const pending = page.locator('[data-setup-state="pending"]');
  await expect(pending).toContainText("No sandbox provider for Acme");
  await expect(pending.getByRole("link", { name: "Set up a provider" })).toHaveAttribute("href", `/orgs/${ACME}/setup`);
  await expect(page.getByRole("heading", { name: "Build a golden" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Launch from/ })).toHaveCount(0);
  const card = page.locator('[data-golden="shared-golden"]');
  await expect(card).toContainText("Launch needs a sandbox provider");
  await expect(card.locator("[data-rebuild-paused]")).toHaveText("Rebuilding needs a sandbox provider.");
  // A rebuild tracked in the URL keeps its form to follow the job, but cannot submit.
  await page.goto(
    "/goldens?build-key.rebuild.00000000-0000-4000-8000-000000000020=6f1c2d3e-4b5a-4c6d-8e7f-901234567890",
  );
  await expect(card.locator("form[data-golden-form]")).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Rebuild golden", includeHidden: true })).toBeDisabled();
  // Removal still works.
  await card.getByRole("button", { name: "Remove golden" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove golden" }).click();
  await expect(page.locator("[data-golden-removed]")).toContainText("Removed shared-golden");
  // Running sandboxes stay listed and stoppable.
  await page.goto("/sandboxes");
  await expect(page.getByRole("link", { name: "bx_alice_running" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up a provider" })).toBeVisible();
});

test("a build the page tracks keeps its form while the org has no provider; an untracked org resumes setup", async ({
  page,
}) => {
  await post("/__test/reset", { orionOrg: true });
  await signIn(page, "carol@example.com", `/orgs/${ORION}/setup`);
  await page.goto("/goldens");
  await expect(page).toHaveURL(`/orgs/${ORION}/setup`);
  const key = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
  await page.goto(`/goldens?build-key.create.${ORION}=${key}`);
  await expect(page).toHaveURL(/\/goldens\?/);
  await expect(page.locator('[data-setup-state="pending"]')).toBeVisible();
  await expect(page.locator('form[data-golden-form="create"]')).toHaveCount(1);
  // The stale key settles without an active job; the form still cannot submit a new build.
  await expect(
    page.locator('form[data-golden-form="create"]').getByRole("button", { name: "Build golden" }),
  ).toBeDisabled();
  // The form only reads the tracked job; no new build reaches the server.
  expect((await post("/__test/state")).goldenCalls).toHaveLength(0);
});

for (const mobile of [false, true]) {
  test(`setup renders on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await post("/__test/reset", { orionOrg: true });
    await signIn(page, "carol@example.com", `/orgs/${ORION}/setup`);
    await expect(page.locator('[data-setup-state="pending"]')).toBeVisible();
    await page.screenshot({
      path: `test-results/onboarding-admin-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page.getByText("Modal", { exact: true }).click();
    await page.screenshot({
      path: `test-results/onboarding-modal-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page.context().clearCookies();
    await signIn(page, "bob@example.com", `/orgs/${ORION}/setup`);
    await page.getByRole("button", { name: "Switch to Orion" }).click();
    await expect(page.locator('[data-setup-state="waiting"]')).toBeVisible();
    await page.screenshot({
      path: `test-results/onboarding-member-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
  });
}
