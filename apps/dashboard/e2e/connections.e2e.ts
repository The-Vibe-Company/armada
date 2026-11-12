import { expect, type Page, test } from "@playwright/test";
import { IDS, MOCK, openLaunch, reset, signIn } from "./helpers";

const ACME = "00000000-0000-4000-8000-000000000010";
const ZENITH = "00000000-0000-4000-8000-000000000011";
const ALICE_LINEAR = "00000000-0000-4000-8000-000000000061";
const ACME_DOCS = "00000000-0000-4000-8000-000000000060";

type MockState = {
  controlCalls: { operation: string; body: Record<string, unknown> }[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  launches: Record<string, unknown>[];
  connections: Record<string, unknown>[];
};

async function mockState(): Promise<MockState> {
  return (await (await fetch(`${MOCK}/__test/state`)).json()) as MockState;
}

/** A connection's row in the Tools list, and its detail panel (hidden until the row is selected). */
const card = (page: Page, name: string) => page.locator(`[data-connection="${name}"]`).filter({ visible: true });
const panelOf = (page: Page, name: string) =>
  page.locator(`[data-connection-panel="${name}"]`).filter({ visible: true });

/** Selects a connection's row, unless its panel already shows, and returns the panel. */
async function panel(page: Page, name: string) {
  const open = panelOf(page, name);
  if (!(await open.isVisible())) {
    await leavePanel(page);
    await card(page, name).locator("[data-select-item]").click();
  }
  await expect(open).toBeVisible();
  return open;
}

async function leavePanel(page: Page) {
  const detail = page.getByRole("dialog").filter({ has: page.locator("[data-resource-panel]") });
  if (await detail.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
  }
}

/** Opens the Add server dialog and returns its custom server form. */
async function openAdd(page: Page) {
  await leavePanel(page);
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add a custom server" }).locator("form[data-add-connection]");
  await expect(form).toBeVisible();
  return form;
}

/** Opens a connection's panel and runs one of its actions. */
async function menu(page: Page, name: string, item: string) {
  await (await panel(page, name)).getByRole("button", { name: item, exact: true }).click();
}

/** The Services section under the list: the one place a catalog service is connected. */
async function openServices(page: Page) {
  await leavePanel(page);
  const services = page.getByRole("region", { name: "Services" });
  await expect(services).toBeVisible();
  return services;
}

test.beforeEach(reset);

for (const mobile of [false, true]) {
  test(`personal and org tools share one list, scoped to the viewer, what needs a fix first (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "alice@example.com", "/tools");
    const linear = card(page, "Alice Linear");
    await expect(linear).toContainText("Personal");
    await expect(linear).toContainText("Linear");
    // The identity and tool count are the row's fact: the panel shows them on a narrow screen.
    const facts = mobile ? await panel(page, "Alice Linear") : linear;
    await expect(facts).toContainText("alice@linear.test");
    await expect(facts).toContainText("21 tools");
    if (mobile) await page.keyboard.press("Escape");
    await expect(card(page, "Acme Docs")).toContainText("Org");
    await expect(card(page, "Acme Docs")).toContainText("Connected");
    await expect(card(page, "Acme Sentry")).toContainText("Needs reconnect");
    await expect(card(page, "Acme Sentry")).toContainText("refresh token was revoked");
    await expect(page.getByText("Bob Notes")).toHaveCount(0);
    // Needs a fix first, then ready. The services are offered once, in their own section, not as rows.
    await expect(page.getByRole("list", { name: "Tools" }).locator(":scope > li")).toHaveText([
      /^A?Acme Search/,
      /^A?Acme Sentry/,
      /^R?Repo Files/,
      /^A?Acme Docs/,
      /^L?Alice Linear/,
    ]);
    const services = await openServices(page);
    await expect(services.locator("[data-service]")).toHaveCount(3);
    await expect(services.locator('[data-service="notion"]')).toContainText("Not added");
    // The strip names each fix and opens the row's panel, where its button is.
    const strip = page.locator("[data-readiness]");
    await expect(strip.getByRole("link")).toHaveText([
      /^Configure Repo Files/,
      /^Retry Acme Search/,
      /^Reconnect Acme Sentry/,
    ]);
    await strip.getByRole("link", { name: /^Reconnect Acme Sentry/ }).click();
    await expect(panelOf(page, "Acme Sentry").getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panelOf(page, "Acme Sentry")).toBeHidden();
    await page.screenshot({ path: `test-results/connections-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });

    const dialog = await openAdd(page);
    await expect(dialog.getByLabel("Authentication")).toHaveValue("auto");
    await expect(dialog.getByRole("option", { name: "Auto-detect (recommended)" })).toHaveCount(1);
    // A dialog over the list, not a panel beside it: the catalog is not repeated, and on a laptop the whole form
    // shows without scrolling, its irreversible choice marked.
    await expect(page.getByRole("dialog").locator("[data-service]")).toHaveCount(0);
    await expect(dialog.getByRole("group", { name: /Who uses it/ })).toContainText("Cannot be changed later");
    if (!mobile) await expect(dialog.getByRole("button", { name: "Add and connect" })).toBeInViewport({ ratio: 1 });
    if (!mobile) {
      // The stdio path fits too: its importer is folded, so the scope choice and the submit stay in view.
      await dialog.getByRole("radio", { name: /stdio command/ }).check();
      await expect(dialog.getByText("Runs in each sandbox launched with it")).toBeVisible();
      await expect(dialog.getByRole("radio", { name: /Personal/ })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Add connection" })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: "test-results/connections-add-stdio-desktop.png", animations: "disabled" });
      await dialog.getByRole("radio", { name: /Remote URL/ }).check();
    }
    // On a phone the form scrolls inside the dialog, but nothing overflows its width.
    await expect(dialog.getByText("stdio command")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1280);
    await page.screenshot({
      path: `test-results/connections-add-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeFocused();
  });
}

test("a member manages personal connections only and cannot add org ones", async ({ page }) => {
  await signIn(page, "bob@example.com", "/tools");
  await expect(card(page, "Bob Notes")).toBeVisible();
  await expect(card(page, "Alice Linear")).toHaveCount(0);
  // Only the row's select target: no action, and the panel holds no control either.
  await expect(card(page, "Acme Docs").getByRole("link")).toHaveCount(1);
  await expect(card(page, "Acme Docs").getByRole("button")).toHaveCount(0);
  const docs = await panel(page, "Acme Docs");
  await expect(docs).toContainText("Managed by the org's admins.");
  await expect(docs.getByRole("button")).toHaveCount(0);
  await expect(docs.getByRole("switch")).toHaveCount(0);
  const dialog = await openAdd(page);
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeDisabled();
  await expect(dialog.getByText("Only an org admin adds these.")).toBeVisible();
});

test("a pasted URL auto-detects OAuth, signs in through the server and reports the stored status", async ({ page }) => {
  await signIn(page, "alice@example.com", "/tools");
  let dialog = await openAdd(page);
  await dialog.getByRole("radio", { name: /Org \(Acme\)/ }).check();
  await expect(dialog.getByText("Sign in with a service account")).toBeVisible();
  await dialog.getByLabel("Name").fill("Acme Tracker");
  await dialog.getByLabel("Server URL").fill("https://tracker.oauth.test/mcp");
  await dialog.getByRole("button", { name: "Add and connect" }).click();

  await expect(page.getByRole("heading", { name: "Authorize Armada for Acme Tracker" })).toBeVisible();
  const callbacks: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/auth/mcp/callback")) callbacks.push(request.url());
  });
  await page.getByRole("link", { name: "Allow" }).click();
  await expect(page).toHaveURL(/\/tools\?connection=[0-9a-f-]{36}&oauth=returned&item=[0-9a-f-]{36}$/);
  // Ignore React streaming staging nodes; assert the notice rendered to the user.
  const notice = page.locator('[data-oauth-return="connected"]').filter({ visible: true });
  await expect(notice).toContainText("Acme Tracker is connected");
  await expect(notice).toContainText("Signed in as service@oauth.test");
  await expect(card(page, "Acme Tracker")).toContainText("OAuth");
  await expect(card(page, "Acme Tracker")).toContainText("9 tools");
  // Back from the sign-in, the panel shows the connection it was for.
  await expect(panelOf(page, "Acme Tracker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panelOf(page, "Acme Tracker")).toBeHidden();
  await page.reload();
  await expect(panelOf(page, "Acme Tracker")).toBeHidden();
  await expect(page.locator('[data-oauth-return="connected"]').filter({ visible: true })).toBeVisible();

  const calls = (await mockState()).controlCalls;
  expect(calls.find((call) => call.operation === "create")?.body).toEqual({
    org: ACME,
    scope: "org",
    name: "Acme Tracker",
    transport: "http",
    url: "https://tracker.oauth.test/mcp",
    args: [],
    authType: "auto",
  });
  // The dashboard relayed the provider's answer server-side with the viewer's bearer; the API resolved the org.
  const relayed = calls.find((call) => call.operation === "oauth/callback");
  expect(relayed?.body).toEqual({ state: expect.any(String), code: expect.stringMatching(/^code-/), issuer: MOCK });
  const callbackUrl = new URL(callbacks[0] ?? "");
  expect(callbackUrl.searchParams.get("code")).toBe(relayed?.body.code as string);

  // The same code again (a replayed or reloaded callback) is refused and nothing of it is shown.
  await page.goto(callbackUrl.pathname + callbackUrl.search);
  await expect(page).toHaveURL(/\/tools\?oauth=failed$/);
  await expect(page.locator('[data-oauth-return="failed"]').filter({ visible: true })).toContainText(
    "Sign-in could not be completed",
  );
  await expect(page.locator("body")).not.toContainText(String(relayed?.body.code));

  // Declining at the server comes back as a cancelled sign-in, without the provider's own text.
  await card(page, "Acme Sentry").getByRole("button", { name: "Reconnect" }).click();
  await page.getByRole("link", { name: "Deny" }).click();
  await expect(page).toHaveURL(/\/tools\?oauth=denied$/);
  await expect(page.locator('[data-oauth-return="failed"]').filter({ visible: true })).toContainText(
    "Sign-in was cancelled",
  );
  await expect(page.locator("body")).not.toContainText("The user said no");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/oauth-denied-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  // A crafted return link cannot claim success: the page rereads the real status.
  await page.goto(`/tools?connection=${ALICE_LINEAR.replace("61", "99")}&oauth=returned`);
  await expect(page.locator('[data-oauth-return="failed"]').filter({ visible: true })).toContainText(
    "could not be found",
  );
  await page.goto(`/tools?connection=00000000-0000-4000-8000-000000000063&oauth=returned`);
  await expect(page.locator('[data-oauth-return="failed"]').filter({ visible: true })).toContainText(
    "Acme Sentry is not connected",
  );

  dialog = await openAdd(page);
  await expect(dialog.getByLabel("Name")).toHaveValue("");
});

test("a callback without a dashboard session goes to sign-in and keeps nothing of the code", async ({ page }) => {
  await page.goto("/auth/mcp/callback?state=pending-state-1&code=one-time-code&iss=https%3A%2F%2Fissuer.test");
  await expect(page).toHaveURL(/\/login\?next=%2Ftools$/);
  expect(page.url()).not.toContain("one-time-code");
  expect((await mockState()).controlCalls.filter((call) => call.operation === "oauth/callback")).toEqual([]);
});

test("disabling a connection takes it out of launches until it is enabled again", async ({ page }) => {
  await signIn(page, "alice@example.com", "/tools");
  const docs = card(page, "Acme Docs");
  await menu(page, "Acme Docs", "Disable");
  await expect(panelOf(page, "Acme Docs").getByRole("status")).toContainText(
    "Acme Docs is disabled. New launches cannot select it.",
  );
  await expect(docs).toContainText("Disabled");
  await docs.screenshot({ path: "test-results/connection-disabled.png", animations: "disabled" });
  expect((await mockState()).controlCalls.find((call) => call.operation === "set-enabled")?.body).toEqual({
    org: ACME,
    id: ACME_DOCS,
    enabled: false,
  });

  await page.goto("/environments");
  await openLaunch(page, "shared-golden");
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "Acme Docs" })).toBeDisabled();
  await expect(page.getByRole("dialog").getByText("Disabled. Enable it on the Tools page first.")).toBeVisible();

  await page.goto("/tools");
  await menu(page, "Acme Docs", "Enable");
  await expect(panelOf(page, "Acme Docs").getByRole("status")).toContainText("Acme Docs is enabled.");
  await expect(docs).toContainText("Connected");

  // A member gets no Disable control on an org connection.
  await page.context().clearCookies();
  await signIn(page, "bob@example.com", "/tools");
  await expect((await panel(page, "Acme Docs")).getByRole("button", { name: "Disable" })).toHaveCount(0);
});

test("a bearer token is write-only: refused tokens are reported, and the field never keeps the value", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/tools");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name").fill("Internal API");
  await dialog.getByLabel("Server URL").fill("https://api.internal.test/mcp?api_key=abc");
  await dialog.getByLabel("Authentication").selectOption("bearer");
  await dialog.getByLabel("Bearer token").fill("bad-token");
  await dialog.getByRole("button", { name: "Add and connect" }).click();
  await expect(dialog.getByRole("alert")).toContainText('Remove "api_key" from the URL');
  // The refused submission keeps what is not secret and empties the secret.
  await expect(dialog.getByLabel("Server URL")).toHaveValue("https://api.internal.test/mcp?api_key=abc");
  await expect(dialog.getByLabel("Bearer token")).toHaveValue("");

  await dialog.getByLabel("Server URL").fill("https://api.internal.test/mcp?project_ref=abcd&read_only=true");
  await dialog.getByLabel("Bearer token").fill("bad-token");
  await dialog.getByRole("button", { name: "Add and connect" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Needs reconnect. The server refused the token (401).");
  await expect(dialog.getByLabel("Bearer token")).toHaveValue("");
  await page.keyboard.press("Escape");

  const row = card(page, "Internal API");
  const details = panelOf(page, "Internal API");
  await expect(row).toContainText("Needs reconnect");
  await expect(row).toContainText("api.internal.test");
  await expect(await panel(page, "Internal API")).toContainText("project_ref=abcd");
  await expect(page.locator("body")).not.toContainText("bad-token");
  const state = await mockState();
  expect(state.controlCalls.find((call) => call.operation === "create")?.body.authentication).toBe("bad-token");

  // Editing warns that the stored token is cleared, then reconnects with the new one.
  await menu(page, "Internal API", "Edit server");
  const edit = page.getByRole("dialog", { name: "Edit Internal API" });
  await expect(edit.getByText("Any saved sign-in, token or headers are deleted, not kept")).toBeVisible();
  // The complete definition is shown and resubmitted: the registry's save is a full replace.
  await expect(edit.getByLabel("Server URL")).toHaveValue(
    "https://api.internal.test/mcp?project_ref=abcd&read_only=true",
  );
  await expect(edit.getByLabel("Bearer token")).toHaveValue("");
  await edit.getByLabel("Bearer token").fill("good-token");
  await edit.getByRole("button", { name: "Save and reconnect" }).click();
  await expect(edit).toBeHidden();
  await expect(details.getByRole("status")).toContainText("Saved. Internal API is connected.");
  const update = (await mockState()).controlCalls.find((call) => call.operation === "update");
  expect(update?.body).toEqual({
    org: ACME,
    id: expect.any(String),
    scope: "personal",
    name: "Internal API",
    transport: "http",
    url: "https://api.internal.test/mcp?project_ref=abcd&read_only=true",
    args: [],
    authType: "bearer",
    authentication: "good-token",
  });

  await menu(page, "Internal API", "Revoke access");
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke access" }).click();
  await expect(row).toContainText("Not connected");
  await expect(details.getByRole("status")).toContainText("Access revoked");
  await menu(page, "Internal API", "Delete");
  await page.getByRole("button", { name: "Delete connection" }).click();
  await expect(row).toHaveCount(0);
});

test("a stdio server is imported, must pin its package and is configured for launch, never run here", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/tools");
  const dialog = await openAdd(page);
  await dialog.getByRole("radio", { name: /stdio command/ }).check();
  await expect(dialog.getByText("Runs in each sandbox launched with it")).toBeVisible();
  await dialog.getByRole("button", { name: "Import JSON definition" }).click();
  const importBox = dialog.getByLabel("JSON definition");
  await importBox.fill(JSON.stringify({ mcpServers: { files: { command: "npx", env: { TOKEN: "x" } } } }));
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Remove the env block");
  await importBox.fill(
    JSON.stringify({
      mcpServers: { files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } },
    }),
  );
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByLabel("Name")).toHaveValue("files");
  await expect(dialog.getByRole("textbox", { name: "Command" })).toHaveValue("npx");
  await dialog.getByRole("button", { name: "Add connection" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Pin the npm package to an exact version");
  await dialog
    .getByLabel("Arguments, one per line")
    .fill("-y\n@modelcontextprotocol/server-filesystem@2026.1.14\n/workspace");
  await dialog.getByRole("button", { name: "Add connection" }).click();
  await expect(dialog.getByRole("status").last()).toContainText("Added. files is configured for launch.");
  await expect(dialog.getByLabel("Name")).toHaveValue("");
  await page.keyboard.press("Escape");
  const files = card(page, "files");
  await expect(files).toContainText("npx");
  await expect(files).toContainText("stdio (in sandbox)");
  await expect(files.locator("[data-connection-status]")).toHaveText("Configured for launch");
  const filesPanel = await panel(page, "files");
  await expect(filesPanel).toContainText("npx -y @modelcontextprotocol/server-filesystem@2026.1.14 /workspace");
  await expect(filesPanel.getByRole("button", { name: "Edit server" })).toBeVisible();
  await expect(filesPanel.getByRole("button", { name: "Check", exact: true })).toHaveCount(0);
  // Escape closes the panel and gives the focus back to its row.
  await page.keyboard.press("Escape");
  await expect(filesPanel).toBeHidden();
  await expect(files.locator("[data-select-item]")).toBeFocused();
  const created = (await mockState()).controlCalls.find((call) => call.operation === "create");
  expect(created?.body).toEqual({
    org: ACME,
    scope: "personal",
    name: "files",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "/workspace"],
    authType: "none",
  });

  // An edit is a full replace with the stored scope, and leaves it configured for launch again.
  await menu(page, "files", "Edit server");
  const edit = page.getByRole("dialog", { name: "Edit files" });
  await edit.getByLabel("Arguments, one per line").fill("-y\n@modelcontextprotocol/server-filesystem@2026.2.1\n/srv");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(filesPanel.getByRole("status")).toContainText("Saved. files is configured for launch.");
  expect((await mockState()).controlCalls.find((call) => call.operation === "update")?.body).toMatchObject({
    scope: "personal",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2026.2.1", "/srv"],
    authType: "none",
  });

  // A stdio connection saved before the registry configured it offers Configure, which uses the connect route.
  await leavePanel(page);
  const legacy = card(page, "Repo Files");
  await expect(legacy.locator("[data-connection-status]")).toHaveText("Not configured");
  await legacy.getByRole("button", { name: "Configure Repo Files" }).click();
  await expect(legacy.getByRole("status")).toContainText("Repo Files is configured for launch.");

  await page.goto("/environments");
  await openLaunch(page, "shared-golden");
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "files", exact: true })).toBeEnabled();
  await expect(page.getByRole("dialog").getByText("Starts inside the sandbox").first()).toBeVisible();
});

test("a launch picks personal and org connections alike, from any golden, with no visibility choice", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  const dialog = await openLaunch(page, "shared-golden");
  const linear = dialog.getByRole("checkbox", { name: "Alice Linear" });
  const docs = dialog.getByRole("checkbox", { name: "Acme Docs" });
  // Who may open the sandbox is its owner and the admins (#680): there is nothing to choose.
  await expect(dialog.getByRole("radio", { name: /^(Org|Private)/ })).toHaveCount(0);
  await expect(dialog.getByText("Who sees the sandbox")).toHaveCount(0);
  // Untouched, the selection is the #681 defaults: the personal default goes even into a sandbox of a shared golden.
  await expect(linear).toBeChecked();
  await expect(docs).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Acme Sentry" })).toBeDisabled();
  await page.screenshot({ path: "test-results/launch-connections-desktop.png", animations: "disabled" });
  // Keyboard: tick the org connection.
  await docs.focus();
  await page.keyboard.press("Space");
  await expect(docs).toBeChecked();
  await expect(linear).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: "test-results/launch-connections-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();

  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  // Who may open a sandbox is its owner and the admins (#680): the page states no per-sandbox visibility.
  const facts = page.locator("dl").first();
  await expect(facts).toContainText("Owner");
  await expect(facts.getByText("Visibility")).toHaveCount(0);
  expect((await mockState()).controlCalls.find((call) => call.operation === "sandbox-connections")?.body).toEqual({
    org: ACME,
    id: page.url().split("/").pop(),
  });
  const applied = page.getByRole("list", { name: "Applied connections" });
  await expect(applied).toContainText("Alice Linear");
  await expect(applied).toContainText("Acme Docs");
  await page.screenshot({ path: "test-results/sandbox-connections-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/sandbox-connections-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  const [launch] = (await mockState()).launches;
  expect(launch).toMatchObject({ connections: [ALICE_LINEAR, ACME_DOCS] });
  // The deprecated visibility is no longer sent, and the default repository context sends no repo at all.
  expect(launch).not.toHaveProperty("visibility");
  expect(launch).not.toHaveProperty("repo");

  // A forged launch naming a connection that is not connected is refused before it reaches the server.
  await page.goto("/environments");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page
    .getByRole("dialog")
    .locator('input[name="golden"]')
    .evaluate((input) => {
      const forged = document.createElement("input");
      forged.type = "hidden";
      forged.name = "connections";
      forged.value = "00000000-0000-4000-8000-000000000063";
      input.after(forged);
      // An explicit choice: an untouched form names no connections and leaves the defaults to the server.
      const choice = input.closest("form")?.querySelector<HTMLInputElement>('input[name="connections-choice"]');
      if (choice) choice.value = "explicit";
    });
  await page.getByRole("dialog").getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Acme Sentry: Needs reconnect.");
  expect((await mockState()).launches).toHaveLength(1);
});

test("switching organization switches the connections and their launch choices", async ({ page }) => {
  await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ multiOrg: true }) });
  await signIn(page, "alice@example.com", "/tools");
  await page.getByLabel("Active organization").selectOption(ZENITH);
  await expect(page).toHaveURL(/\/tools$/);
  await expect(card(page, "Zenith Search")).toBeVisible();
  await expect(card(page, "Acme Docs")).toHaveCount(0);
  await expect(card(page, "Alice Linear")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeVisible();
  // Alice is only a member in Zenith: its org connections are read-only for her.
  await expect(await panel(page, "Zenith Search")).toContainText("Managed by the org's admins.");
  const lists = (await mockState()).controlCalls.filter((call) => call.operation === "list");
  expect(lists.at(-1)?.body).toEqual({ org: ZENITH });
});

test("a sandbox's applied connections come from the registry, and a failed read is not shown as none", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const section = page.locator("[data-slot=card]", { hasText: "MCP connections" });
  await expect(section).toContainText("Launched without MCP connections you can see.");
  await fetch(`${MOCK}/__test/fail-sandbox-connections`, { method: "POST" });
  await page.reload();
  await expect(section.getByRole("alert")).toContainText("could not be loaded");
  await expect(section).not.toContainText("Launched without");
});

test("a catalog service adds a second named account through its sign-in, and Slack shows its setup instead", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/tools");
  // Each service has one card; Slack's says what the server still needs instead of offering Connect.
  const services = await openServices(page);
  const slack = services.locator('[data-service="slack"]');
  await expect(slack).toContainText("Needs server setup");
  await expect(slack).toContainText("Registered confidential OAuth client required");
  await expect(slack.getByRole("button")).toHaveCount(0);
  await expect(slack.getByRole("link", { name: "Setup guide" })).toHaveAttribute(
    "href",
    "https://docs.slack.dev/ai/slack-mcp-server/",
  );
  await expect(services.locator('[data-service="linear"]')).toContainText("1 account in your list");

  await services.getByRole("button", { name: "Connect another Linear account" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Linear" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Linear");
  await dialog.getByLabel("Name").fill("Work Linear");
  await dialog.getByLabel("Include in new launches by default").check();
  await page.screenshot({ path: "test-results/connect-service-desktop.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Continue to Linear" }).click();

  await expect(page.getByRole("heading", { name: "Authorize Armada for Work Linear" })).toBeVisible();
  await page.getByRole("link", { name: "Allow" }).click();
  await expect(page.locator('[data-oauth-return="connected"]').filter({ visible: true })).toContainText(
    "Work Linear is connected",
  );
  // Two accounts of one service are two connections: each keeps its own nickname and its verified account.
  await expect(card(page, "Work Linear")).toContainText("Signed in as service@oauth.test");
  await expect(card(page, "Alice Linear")).toContainText("Signed in as alice@linear.test");
  await expect(card(page, "Work Linear")).toContainText("Default");
  await expect(
    (await panel(page, "Work Linear")).getByRole("switch", { name: "Include Work Linear by default" }),
  ).toHaveAttribute("aria-checked", "true");
  await openServices(page);
  await expect(services.locator('[data-service="linear"]')).toContainText("2 accounts in your list");
  await page.screenshot({ path: "test-results/connections-catalog-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/connections-catalog-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  let state = await mockState();
  const created = state.connections.find((row) => row.name === "Work Linear");
  expect(created?.id).not.toBe(ALICE_LINEAR);
  // Only the service id travels: the server owns the URL and the sign-in.
  expect(state.controlCalls.find((call) => call.operation === "create")?.body).toEqual({
    org: ACME,
    scope: "personal",
    name: "Work Linear",
    serviceId: "linear",
  });
  expect(state.controlCalls.find((call) => call.operation === "metadata")?.body).toEqual({
    org: ACME,
    id: created?.id,
    defaultForLaunch: true,
  });

  // A forged form for a service that still needs setup is refused before anything is created.
  await services.getByRole("button", { name: "Connect Notion" }).click();
  const notion = page.getByRole("dialog", { name: "Connect Notion" });
  await notion.locator('input[name="service"]').evaluate((input) => {
    (input as HTMLInputElement).value = "slack";
  });
  await notion.getByRole("button", { name: "Continue to Notion" }).click();
  await expect(notion.getByRole("alert")).toContainText("Slack needs setup on this Armada server first.");
  state = await mockState();
  expect(state.controlCalls.filter((call) => call.operation === "create")).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(services.getByRole("button", { name: "Connect Notion" })).toBeFocused();

  // Once the connection exists, a failed sign-in start is finished on its row: the dialog offers no second submit,
  // and opens again on a fresh form.
  await fetch(`${MOCK}/__test/fail-connect`, { method: "POST" });
  await services.getByRole("button", { name: "Connect Notion" }).click();
  await notion.getByRole("button", { name: "Continue to Notion" }).click();
  await expect(notion.getByRole("alert")).toContainText(
    "Notion was added, but connecting failed: The authorization server did not answer.",
  );
  await expect(notion.getByRole("button", { name: "Continue to Notion" })).toHaveCount(0);
  await notion.locator("[data-service-outcome]").getByRole("button", { name: "Close" }).click();
  await expect(card(page, "Notion").getByRole("button", { name: "Connect Notion" })).toBeVisible();
  await services.getByRole("button", { name: "Connect another Notion account" }).click();
  await expect(notion.getByLabel("Name")).toHaveValue("Notion 2");
  await expect(notion.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  state = await mockState();
  expect(state.controlCalls.filter((call) => call.operation === "create")).toHaveLength(2);

  // A server without the catalog still lists every connection and offers a custom server.
  await fetch(`${MOCK}/__test/fail-catalog`, { method: "POST" });
  await page.goto("/tools");
  await expect(card(page, "Work Linear")).toBeVisible();
  await openAdd(page);
  await expect(page.locator("[data-catalog-unavailable]")).toContainText("does not offer the service catalog yet");
});

test("rename and include-by-default change metadata only, and an unreachable server offers Retry", async ({ page }) => {
  await signIn(page, "alice@example.com", "/tools");
  await menu(page, "Alice Linear", "Rename");
  const dialog = page.getByRole("dialog", { name: "Rename Alice Linear" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Alice Linear");
  await dialog.getByLabel("Name").fill("Personal Linear");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  const linear = card(page, "Personal Linear");
  const linearPanel = panelOf(page, "Personal Linear");
  await expect(linearPanel.getByRole("status")).toContainText("Renamed to Personal Linear.");
  await expect(linear).toContainText("Connected");
  await expect(linear).toContainText("Signed in as alice@linear.test");
  await expect(linearPanel.getByRole("button", { name: "Rename" })).toBeFocused();

  const docs = await panel(page, "Acme Docs");
  const toggle = docs.getByRole("switch", { name: "Include Acme Docs by default" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(docs.getByRole("status")).toContainText("Acme Docs is included in new launches by default.");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(card(page, "Acme Docs")).toContainText("Connected");
  await docs.screenshot({ path: "test-results/connection-default.png", animations: "disabled" });
  // Neither change went through the full replace, the enable switch or a new sign-in, which would drop the grant.
  const calls = (await mockState()).controlCalls.filter((call) =>
    ["metadata", "update", "set-enabled", "connect", "revoke"].includes(call.operation),
  );
  expect(calls.map((call) => [call.operation, call.body])).toEqual([
    ["metadata", { org: ACME, id: ALICE_LINEAR, name: "Personal Linear" }],
    ["metadata", { org: ACME, id: ACME_DOCS, defaultForLaunch: true }],
  ]);

  await leavePanel(page);
  const search = card(page, "Acme Search");
  await expect(search).toContainText("Unavailable");
  await expect(search).toContainText("The server did not answer.");
  await search.getByRole("button", { name: "Retry Acme Search" }).click();
  await expect(search.getByRole("status")).toContainText("Acme Search is connected.");
  await expect(search.getByRole("button", { name: "Retry Acme Search" })).toBeHidden();
});

test("only a deliberate choice sends connections, even none; otherwise the server applies the defaults", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  const open = async () => {
    return openLaunch(page, "shared-golden");
  };

  // Deliberately unticking the default sends an explicit empty selection.
  let dialog = await open();
  await expect(dialog.getByRole("checkbox", { name: "Alice Linear" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Alice Linear" }).uncheck();
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  // Untouched, the launch names no connections: the server snapshots the defaults, personal ones included (#681).
  await page.goto("/environments");
  dialog = await open();
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("list", { name: "Applied connections" })).toContainText("Alice Linear");

  // A list that could not be loaded is not a choice of none: the launch still leaves the defaults to the server. (Only
  // the dashboard's list read fails here; in a full registry outage the server refuses the launch instead.)
  await fetch(`${MOCK}/__test/fail-connection-list`, { method: "POST" });
  await page.goto("/environments");
  dialog = await open();
  await expect(dialog.getByRole("alert")).toContainText("A launch uses your default connections");
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  const launches = (await mockState()).launches;
  expect(launches.map((launch) => ("connections" in launch ? launch.connections : "server defaults"))).toEqual([
    [],
    "server defaults",
    "server defaults",
  ]);
});

test("a default that is not connected holds the launch until it is reconnected or left out", async ({ page }) => {
  await signIn(page, "alice@example.com", "/tools");
  // One connected and one disconnected org default, and a personal default that is not configured.
  for (const name of ["Acme Docs", "Acme Sentry", "Repo Files"]) {
    const toggle = (await panel(page, name)).getByRole("switch", { name: `Include ${name} by default` });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  }

  await page.goto("/environments");
  const open = () => openLaunch(page, "shared-golden");
  let dialog = await open();
  const held = dialog.locator("[data-unready-defaults]");
  const docs = dialog.getByRole("checkbox", { name: "Acme Docs" });
  const launch = dialog.getByRole("button", { name: "Launch", exact: true });
  await expect(docs).toBeChecked();
  // The personal default is held too, whatever the golden (#681): neither is dropped silently.
  await expect(held).toContainText("are defaults but are not connected.");
  await expect(held).toContainText("Acme Sentry");
  await expect(held).toContainText("Repo Files");
  await expect(held.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/tools");
  await expect(launch).toBeDisabled();
  // Changing other connections is not a decision about the missing default: the launch stays held.
  await docs.uncheck();
  await docs.check();
  await expect(held).toBeVisible();
  await expect(launch).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await held.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/launch-unready-default-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Continuing without it is the explicit choice; then the selection is exactly what is ticked.
  await held.getByRole("button", { name: "Continue without them" }).click();
  await expect(held).toHaveCount(0);
  // Launch is the next step, so focus moves there.
  await expect(launch).toBeFocused();
  await expect(docs).toBeChecked();
  await launch.click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  // A deliberate empty selection launches with none.
  await page.goto("/environments");
  dialog = await open();
  await dialog.locator("[data-unready-defaults]").getByRole("button", { name: "Continue without them" }).click();
  await dialog.getByRole("checkbox", { name: "Acme Docs" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Alice Linear" }).uncheck();
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  expect((await mockState()).launches.map((launch) => launch.connections)).toEqual([[ALICE_LINEAR, ACME_DOCS], []]);
});
