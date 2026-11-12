import { expect, type Page, test } from "@playwright/test";
import { alert, goldenPanel, goldenRow, LABELS, leaveCreate, MOCK, openCreate, signIn } from "./helpers";

/**
 * Sandbox providers (#598): Settings connects, replaces and disconnects the active organization's Boat and Modal, as
 * the server reports them on every visit; new builds, rebuilds and launches follow the exact providers connected.
 */

const ACME = "00000000-0000-4000-8000-000000000010";
const ZENITH = "00000000-0000-4000-8000-000000000011";
const ORION = "00000000-0000-4000-8000-000000000013";
const BOAT_KEY = "bk_live_e2e_value_123";
const MODAL_ID = "ak-AbCdEf123456";
const MODAL_SECRET = "as-ZyXwVu987654";

async function post(path: string, body: object = {}) {
  const response = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return response.json();
}

type Call = { route: string; body: Record<string, unknown>; authorized: boolean };
async function writes(): Promise<Call[]> {
  return ((await post("/__test/state")).providerCalls as Call[]).filter((call) => call.route !== "org/provider/status");
}

const providers = (page: Page) => page.locator('[data-settings="providers"]');
const row = (page: Page, provider: "boat" | "modal") => page.locator(`[data-provider-row="${provider}"]`);

async function connectModal(page: Page) {
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  await row(page, "modal").getByLabel("Token ID").fill(MODAL_ID);
  await row(page, "modal").getByLabel("Token secret").fill(MODAL_SECRET);
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  await expect(row(page, "modal")).toHaveAttribute("data-provider-state", "connected");
}

test.beforeEach(async () => {
  await post("/__test/reset", { multiOrg: true, orionOrg: true });
});

test("a new org connects its first provider in Settings; new work waits for it; a rejected key is not echoed", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/orgs");
  await page.getByRole("button", { name: "New org", exact: true }).click();
  await page.getByLabel("Name").fill("Side Project");
  await page.getByRole("button", { name: "Create org" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Sandbox providers for Side Project" })).toBeVisible();
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "not-connected");
  await expect(row(page, "modal")).toHaveAttribute("data-provider-state", "not-connected");
  const org = String((await post("/__test/state")).providerCalls.at(-1).body.org);
  // New work leads to Settings; the older setup address does too, for the active org.
  for (const path of ["/environments", "/sandboxes", `/orgs/${org}/setup`]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/settings$/);
  }

  await row(page, "boat").getByRole("button", { name: "Connect Boat" }).click();
  await expect(row(page, "boat").getByLabel("Boat API key")).toBeFocused();
  await expect(row(page, "boat").getByLabel("Boat API key")).toHaveAttribute("type", "password");
  await row(page, "boat").getByLabel("Boat API key").fill(`${BOAT_KEY}-rejected`);
  await row(page, "boat").getByRole("button", { name: "Connect Boat" }).click();
  await expect(alert(page)).toHaveText("Boat refused these credentials.");
  await expect(page.locator("body")).not.toContainText(BOAT_KEY);
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "not-connected");
  expect(await writes()).toEqual([
    { route: "org/provider/connect", body: { org, provider: "boat", value: `${BOAT_KEY}-rejected` }, authorized: true },
  ]);

  // Only Modal's pair is sent for Modal; the org can then build on Modal alone, without a choice.
  await connectModal(page);
  await expect(row(page, "modal")).toContainText("Modal connected.");
  const sent = (await writes()).at(-1);
  expect(sent?.body.provider).toBe("modal");
  expect(JSON.parse(String(sent?.body.value))).toEqual({ token_id: MODAL_ID, token_secret: MODAL_SECRET });
  await expect(page.locator("body")).not.toContainText(MODAL_SECRET);
  await page.goto("/environments");
  await expect((await openCreate(page)).locator('[data-provider-fixed="modal"]')).toBeVisible();
  await expect(page.locator("[data-capacity-provider]")).toHaveCount(1);
});

test("an admin adds a second provider and new goldens offer both; a rejected replacement keeps the key", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/settings");
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "connected");
  await connectModal(page);
  await page.goto("/environments");
  const form = await openCreate(page);
  await expect(form.locator("[data-provider-choice]")).toHaveCount(2);

  await page.goto("/settings");
  await row(page, "boat").getByRole("button", { name: "Replace key" }).click();
  await row(page, "boat").getByLabel("Boat API key").fill(`${BOAT_KEY}-rejected`);
  await row(page, "boat").getByRole("button", { name: "Save and replace" }).click();
  await expect(alert(page)).toHaveText("Boat refused these credentials. The connected key is unchanged.");
  expect((await post("/__test/state")).orgBoatKeys).toContain(ACME);
  await page.reload();
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "connected");
});

test("disconnecting one provider keeps its goldens and sandboxes; disconnecting the last pauses new work", async ({
  page,
}) => {
  await post("/__test/reset", { acmeModal: true });
  await signIn(page, "alice@example.com", "/environments");
  await expect(page.getByRole("button", { name: "Launch from shared-golden" })).toBeVisible();
  await page.goto("/settings");
  await row(page, "boat").getByRole("button", { name: "Disconnect" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Disconnect Boat from Acme?");
  await confirm.getByRole("button", { name: "Disconnect Boat" }).click();
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "not-connected");
  await expect(row(page, "modal")).toHaveAttribute("data-provider-state", "connected");
  expect((await writes()).map((call) => [call.route, call.body.provider])).toEqual([
    ["org/provider/disconnect", "boat"],
  ]);

  // The Boat golden stays listed with its provider; its launch and rebuild ask for Boat; new goldens use Modal.
  await page.goto("/environments");
  const card = goldenRow(page, "shared-golden");
  await expect(card).toHaveAttribute("data-golden-provider", "boat");
  await expect(card.getByRole("link", { name: "Connect Boat to launch" })).toHaveAttribute("href", "/settings");
  // The strip names the fix once, for every environment waiting on it.
  await expect(page.locator('[data-blocker="connect-boat"]')).toContainText("Connect Boat");
  await expect((await goldenPanel(page, "shared-golden")).locator("[data-rebuild-paused]")).toHaveText(
    "Rebuilding needs Boat connected.",
  );
  await expect((await openCreate(page)).locator('[data-provider-fixed="modal"]')).toHaveCount(1);
  await leaveCreate(page);
  await expect(page.locator("[data-capacity-provider]")).toHaveCount(1);
  await expect(page.locator('[data-capacity-provider="modal"]')).toBeVisible();

  await page.goto("/settings");
  await row(page, "modal").getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect Modal" }).click();
  await expect(row(page, "modal")).toHaveAttribute("data-provider-state", "not-connected");
  // Goldens to manage: no redirect, no new build; running sandboxes stay listed.
  await page.goto("/environments");
  await expect(page).toHaveURL(/\/environments$/);
  await expect(page.locator('[data-blocker="provider"]')).toContainText("Connect a sandbox provider");
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.goto("/sandboxes");
  await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveAttribute("href", "/settings");
});

test("a member sees the status and whom to ask, with no credential field or action", async ({ page }) => {
  await signIn(page, "bob@example.com", "/settings");
  await expect(providers(page)).toContainText("Only an admin changes them.");
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "connected");
  await expect(providers(page).getByRole("button")).toHaveCount(0);
  await expect(providers(page).locator('input[type="password"]')).toHaveCount(0);

  await page.getByLabel("Active organization").selectOption(ORION);
  await expect(providers(page)).toContainText("Orion");
  await expect(providers(page).locator("[data-provider-admins]").getByRole("link")).toHaveAttribute(
    "href",
    "mailto:carol@example.com",
  );
});

test("a form left open for another org, or forged for one, is refused before it reaches the server", async ({
  page,
  context,
}) => {
  await signIn(page, "alice@example.com", "/settings");
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  // Another tab switches the active organization; this tab's form still names Acme.
  const other = await context.newPage();
  await other.goto("/settings");
  await other.getByLabel("Active organization").selectOption(ZENITH);
  await expect(other.locator('[data-settings="providers"]')).toContainText("Zenith");
  await other.close();
  await row(page, "modal").getByLabel("Token ID").fill(MODAL_ID);
  await row(page, "modal").getByLabel("Token secret").fill(MODAL_SECRET);
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  await expect(alert(page)).toHaveText("Switch to that organization first.");

  // Zenith is now active, where Alice is a member: a forged admin post is refused too.
  await page.goto("/settings");
  await expect(providers(page).getByRole("button")).toHaveCount(0);
  expect(await writes()).toHaveLength(0);
});

test("a deep link to another org's setup offers the switch, then opens its providers in Settings", async ({ page }) => {
  await signIn(page, "carol@example.com", `/orgs/${ORION}/setup`);
  await expect(page).toHaveURL(/\/settings$/);
  await page.goto(`/orgs/${ACME}/setup`);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await page.context().clearCookies();
  await signIn(page, "bob@example.com", `/orgs/${ORION}/setup`);
  await page.getByRole("button", { name: "Switch to Orion" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(providers(page)).toContainText("Orion");
});

test("an unavailable status is a retryable error: never unconfigured, never retried on its own", async ({ page }) => {
  await post("/__test/provider-status-fail", {
    fail: { status: 503, code: "unavailable", message: "Try again soon." },
  });
  await signIn(page, "alice@example.com", "/settings");
  await expect(providers(page).locator('[data-setup-state="unavailable"]').first()).toContainText("Try again soon.");
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "unavailable");
  await expect(providers(page).getByRole("button")).toHaveCount(0);
  await expect(providers(page).getByRole("link", { name: "Check again" })).toBeVisible();

  await page.goto("/environments");
  await expect(page).toHaveURL(/\/environments$/);
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  const card = goldenRow(page, "shared-golden");
  await expect(card.locator("[data-launch-paused]")).toHaveText("Launch paused. The provider status is unavailable.");
  await expect((await goldenPanel(page, "shared-golden")).locator("[data-rebuild-paused]")).toHaveText(
    "Rebuilding paused: provider status unavailable.",
  );

  await post("/__test/provider-status-fail", {});
  await page.goto("/settings");
  await expect(row(page, "boat")).toHaveAttribute("data-provider-state", "connected");
  expect(await writes()).toHaveLength(0);
});

test("an edge 404 while no deployment serves is a temporary outage, and Check again restores the controls", async ({
  page,
}) => {
  await post("/__test/provider-status-fail", {
    fail: { status: 404, message: "", html: "<html><body>Application not found</body></html>" },
  });
  await signIn(page, "alice@example.com", "/environments");
  const alert = page.locator('[data-setup-state="unavailable"]');
  await expect(alert).toContainText("The Armada server could not be reached just now. Check again in a moment.");
  await expect(alert).not.toContainText("does not offer");
  await expect(alert).not.toContainText("Application not found");
  const card = goldenRow(page, "shared-golden");
  await expect(card.locator("[data-launch-paused]")).toHaveText("Launch paused. The provider status is unavailable.");
  const detail = await goldenPanel(page, "shared-golden");
  await expect(detail.locator("[data-rebuild-paused]")).toHaveText("Rebuilding paused: provider status unavailable.");

  await post("/__test/provider-status-fail", {});
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await alert.getByRole("link", { name: "Check again" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Launch from shared-golden" })).toBeVisible();
  await expect(card.locator("[data-launch-paused]")).toHaveCount(0);
  expect(await writes()).toHaveLength(0);
});

test("a launch from a page rendered while Boat was connected is refused once Boat is disconnected", async ({
  page,
}) => {
  await post("/__test/reset", { acmeModal: true });
  await signIn(page, "alice@example.com", "/environments");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Task").fill("Ship it");
  // Modal stays connected: the launch still needs the golden's own provider.
  await post("/__test/clear-legacy-boat", { org: ACME });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Boat is not connected for this organization. An admin connects it in Settings.",
  );
  expect((await post("/__test/state")).launches).toHaveLength(0);
});

test("a build the page tracks keeps its form while the org has no provider", async ({ page }) => {
  await signIn(page, "carol@example.com", "/settings");
  const key = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
  await page.goto(`/environments?build-key.create.${ORION}=${key}`);
  await expect(page).toHaveURL(/\/environments\?/);
  await expect(page.locator('[data-blocker="provider"]')).toBeVisible();
  // The tracked build reopens the create dialog.
  const form = page.locator('form[data-golden-form="create"]');
  await expect(form).toBeVisible();
  await expect(form).toHaveCount(1);
  await expect(form.getByRole("button", { name: "Build golden" })).toBeDisabled();
  expect((await post("/__test/state")).goldenCalls).toHaveLength(0);
});

test("keyboard: open, cancel and confirm with the keyboard; focus returns to the opener", async ({ page }) => {
  await signIn(page, "alice@example.com", "/settings");
  const open = row(page, "modal").getByRole("button", { name: "Connect Modal" });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "modal").getByLabel("Token ID")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row(page, "modal").getByLabel("Token secret")).toBeFocused();
  await row(page, "modal").getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expect(open).toBeFocused();

  await row(page, "boat").getByRole("button", { name: "Disconnect" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(row(page, "boat").getByRole("button", { name: "Disconnect" })).toBeFocused();
  expect(await writes()).toHaveLength(0);

  // Confirmed from the keyboard: the dialog leaves with its button, so focus lands on the row's Connect button.
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect Boat" }).focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "boat").getByRole("status")).toHaveText("Boat disconnected.");
  await expect(row(page, "boat").getByRole("button", { name: "Connect Boat" })).toBeFocused();
});

test("a row's message never outlives a later change: no stale success after disconnect, no stale error on reopen", async ({
  page,
}) => {
  await signIn(page, "carol@example.com", "/settings");
  await page.getByLabel("Active organization").selectOption(ORION);
  await expect(providers(page)).toContainText("Orion");
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  await row(page, "modal").getByLabel("Token ID").fill(`${MODAL_ID}rejected`);
  await row(page, "modal").getByLabel("Token secret").fill(MODAL_SECRET);
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  await expect(row(page, "modal").getByRole("alert")).toHaveText("Modal refused these credentials.");
  await row(page, "modal").getByRole("button", { name: "Cancel" }).click();
  await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
  await expect(row(page, "modal").getByRole("alert")).toHaveCount(0);
  await row(page, "modal").getByRole("button", { name: "Cancel" }).click();

  await connectModal(page);
  await expect(row(page, "modal").getByRole("status")).toHaveText("Modal connected.");
  await row(page, "modal").getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect Modal" }).click();
  await expect(row(page, "modal")).toHaveAttribute("data-provider-state", "not-connected");
  await expect(row(page, "modal").getByRole("status")).toHaveText("Modal disconnected.");
});

for (const mobile of [false, true]) {
  test(`providers render on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const name = mobile ? "mobile" : "desktop";
    await signIn(page, "alice@example.com", "/settings");
    await row(page, "modal").getByRole("button", { name: "Connect Modal" }).click();
    await page.screenshot({ path: `test-results/providers-admin-${name}.png`, fullPage: true });
    await page.context().clearCookies();
    await signIn(page, "carol@example.com", "/settings");
    await page.getByLabel("Active organization").selectOption(ORION);
    await expect(providers(page)).toContainText("Orion");
    await page.screenshot({ path: `test-results/providers-empty-${name}.png`, fullPage: true });
    await page.context().clearCookies();
    await signIn(page, "bob@example.com", "/settings");
    await page.screenshot({ path: `test-results/providers-member-${name}.png`, fullPage: true });
  });
}
