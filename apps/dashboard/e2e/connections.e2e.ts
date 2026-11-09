import { expect, type Page, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

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

const card = (page: Page, name: string) => page.locator(`[data-connection="${name}"]`);

async function openAdd(page: Page) {
  await page.getByRole("button", { name: "Add connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an MCP connection" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(reset);

for (const mobile of [false, true]) {
  test(`personal and org connections are listed apart, scoped to the viewer (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "alice@example.com", "/connections");
    const personal = page.getByRole("region", { name: "Your connections" });
    const shared = page.getByRole("region", { name: "Acme connections" });
    await expect(personal.locator('[data-connection="Alice Linear"]')).toContainText("alice@linear.test");
    await expect(personal.locator('[data-connection="Alice Linear"]')).toContainText(
      "21 tools · 0 resources · 1 prompt",
    );
    await expect(shared.locator('[data-connection="Acme Docs"]')).toContainText("Connected");
    await expect(shared.locator('[data-connection="Acme Sentry"]')).toContainText("Needs reconnect");
    await expect(shared.locator('[data-connection="Acme Sentry"]')).toContainText("refresh token was revoked");
    await expect(page.getByText("Bob Notes")).toHaveCount(0);
    await page.screenshot({ path: `test-results/connections-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });

    const dialog = await openAdd(page);
    await expect(dialog.getByLabel("Authentication")).toHaveValue("auto");
    await expect(dialog.getByRole("option", { name: "Auto-detect (recommended)" })).toHaveCount(1);
    await expect(dialog).toBeInViewport();
    await page.screenshot({
      path: `test-results/connections-add-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Add connection" })).toBeFocused();
  });
}

test("a member manages personal connections only and cannot add org ones", async ({ page }) => {
  await signIn(page, "bob@example.com", "/connections");
  await expect(card(page, "Bob Notes")).toBeVisible();
  await expect(card(page, "Alice Linear")).toHaveCount(0);
  await expect(card(page, "Acme Docs")).toContainText("Managed by the org's admins.");
  await expect(card(page, "Acme Docs").getByRole("button")).toHaveCount(0);
  const dialog = await openAdd(page);
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeDisabled();
  await expect(dialog.getByText("Only an org admin adds these.")).toBeVisible();
});

test("a pasted URL auto-detects OAuth, signs in through the server and reports the stored status", async ({ page }) => {
  await signIn(page, "alice@example.com", "/connections");
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
  await expect(page).toHaveURL(/\/connections\?connection=[0-9a-f-]{36}&oauth=returned$/);
  const notice = page.locator('[data-oauth-return="connected"]');
  await expect(notice).toContainText("Acme Tracker is connected");
  await expect(notice).toContainText("Signed in as service@oauth.test");
  await expect(card(page, "Acme Tracker")).toContainText("OAuth");
  await expect(card(page, "Acme Tracker")).toContainText("9 tools");

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
  await expect(page).toHaveURL(/\/connections\?oauth=failed$/);
  await expect(page.locator('[data-oauth-return="failed"]')).toContainText("Sign-in could not be completed");
  await expect(page.locator("body")).not.toContainText(String(relayed?.body.code));

  // Declining at the server comes back as a cancelled sign-in, without the provider's own text.
  await card(page, "Acme Sentry").getByRole("button", { name: "Reconnect" }).click();
  await page.getByRole("link", { name: "Deny" }).click();
  await expect(page).toHaveURL(/\/connections\?oauth=denied$/);
  await expect(page.locator('[data-oauth-return="failed"]')).toContainText("Sign-in was cancelled");
  await expect(page.locator("body")).not.toContainText("The user said no");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/oauth-denied-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  // A crafted return link cannot claim success: the page rereads the real status.
  await page.goto(`/connections?connection=${ALICE_LINEAR.replace("61", "99")}&oauth=returned`);
  await expect(page.locator('[data-oauth-return="failed"]')).toContainText("could not be found");
  await page.goto(`/connections?connection=00000000-0000-4000-8000-000000000063&oauth=returned`);
  await expect(page.locator('[data-oauth-return="failed"]')).toContainText("Acme Sentry is not connected");

  dialog = await openAdd(page);
  await expect(dialog.getByLabel("Name")).toHaveValue("");
});

test("a callback without a dashboard session goes to sign-in and keeps nothing of the code", async ({ page }) => {
  await page.goto("/auth/mcp/callback?state=pending-state-1&code=one-time-code&iss=https%3A%2F%2Fissuer.test");
  await expect(page).toHaveURL(/\/login\?next=%2Fconnections$/);
  expect(page.url()).not.toContain("one-time-code");
  expect((await mockState()).controlCalls.filter((call) => call.operation === "oauth/callback")).toEqual([]);
});

test("disabling a connection takes it out of launches until it is enabled again", async ({ page }) => {
  await signIn(page, "alice@example.com", "/connections");
  const docs = card(page, "Acme Docs");
  await docs.getByRole("button", { name: "Disable Acme Docs" }).click();
  await expect(docs.getByRole("status")).toContainText("Acme Docs is disabled. New launches cannot select it.");
  await expect(docs).toContainText("Disabled");
  await docs.screenshot({ path: "test-results/connection-disabled.png", animations: "disabled" });
  expect((await mockState()).controlCalls.find((call) => call.operation === "set-enabled")?.body).toEqual({
    org: ACME,
    id: ACME_DOCS,
    enabled: false,
  });

  await page.goto("/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "Acme Docs" })).toBeDisabled();
  await expect(page.getByRole("dialog").getByText("Disabled. Enable it on the Connections page first.")).toBeVisible();

  await page.goto("/connections");
  await docs.getByRole("button", { name: "Enable Acme Docs" }).click();
  await expect(docs.getByRole("status")).toContainText("Acme Docs is enabled.");
  await expect(docs).toContainText("Connected");

  // A member gets no Disable control on an org connection.
  await page.context().clearCookies();
  await signIn(page, "bob@example.com", "/connections");
  await expect(card(page, "Acme Docs").getByRole("button", { name: "Disable Acme Docs" })).toHaveCount(0);
});

test("a bearer token is write-only: refused tokens are reported, and the field never keeps the value", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/connections");
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
  await expect(row).toContainText("Needs reconnect");
  await expect(row).toContainText("project_ref=abcd");
  await expect(page.locator("body")).not.toContainText("bad-token");
  const state = await mockState();
  expect(state.controlCalls.find((call) => call.operation === "create")?.body.authentication).toBe("bad-token");

  // Editing warns that the stored token is cleared, then reconnects with the new one.
  await row.getByRole("button", { name: "Edit Internal API" }).click();
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
  await expect(row.getByRole("status")).toContainText("Saved. Internal API is connected.");
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

  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(row).toContainText("Not connected");
  await expect(row.getByRole("status")).toContainText("Access revoked");
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete connection" }).click();
  await expect(row).toHaveCount(0);
});

test("a stdio server is imported, must pin its package and is configured for launch, never run here", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/connections");
  const dialog = await openAdd(page);
  await dialog.getByRole("radio", { name: /stdio command/ }).check();
  await expect(dialog.getByText("Runs in each sandbox launched with it")).toBeVisible();
  const importBox = dialog.getByLabel("Import a JSON definition (optional)");
  await importBox.fill(JSON.stringify({ mcpServers: { files: { command: "npx", env: { TOKEN: "x" } } } }));
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Remove the env block");
  await importBox.fill(
    JSON.stringify({
      mcpServers: { files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } },
    }),
  );
  await dialog.getByRole("button", { name: "Import" }).click();
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
  await expect(files).toContainText("npx -y @modelcontextprotocol/server-filesystem@2026.1.14 /workspace");
  await expect(files).toContainText("stdio (in sandbox)");
  await expect(files.locator("[data-connection-status]")).toHaveText("Configured for launch");
  await expect(files).toContainText("Available in sandbox");
  await expect(files.getByRole("button", { name: /^Check/ })).toHaveCount(0);
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
  await files.getByRole("button", { name: "Edit files" }).click();
  const edit = page.getByRole("dialog", { name: "Edit files" });
  await edit.getByLabel("Arguments, one per line").fill("-y\n@modelcontextprotocol/server-filesystem@2026.2.1\n/srv");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(files.getByRole("status")).toContainText("Saved. files is configured for launch.");
  expect((await mockState()).controlCalls.find((call) => call.operation === "update")?.body).toMatchObject({
    scope: "personal",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2026.2.1", "/srv"],
    authType: "none",
  });

  // A stdio connection saved before the registry configured it offers Configure, which uses the connect route.
  const legacy = card(page, "Repo Files");
  await expect(legacy.locator("[data-connection-status]")).toHaveText("Not configured");
  await legacy.getByRole("button", { name: "Configure Repo Files" }).click();
  await expect(legacy.getByRole("status")).toContainText("Repo Files is configured for launch.");

  await page.goto("/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page
    .getByRole("dialog")
    .getByRole("radio", { name: /^Private/ })
    .check();
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "files", exact: true })).toBeEnabled();
  await expect(page.getByRole("dialog").getByText("Starts inside the sandbox").first()).toBeVisible();
});

test("a launch picks connections; personal ones need a private sandbox even from a shared golden", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  const dialog = page.getByRole("dialog");
  const linear = dialog.getByRole("checkbox", { name: "Alice Linear" });
  const docs = dialog.getByRole("checkbox", { name: "Acme Docs" });
  await expect(dialog.getByRole("radio", { name: /^Org/ })).toBeChecked();
  await expect(linear).toBeDisabled();
  await expect(dialog.getByText("Personal: uses your own account, so it needs a private sandbox.")).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Acme Sentry" })).toBeDisabled();
  await page.screenshot({ path: "test-results/launch-connections-desktop.png", animations: "disabled" });

  // Keyboard: choose Private with the arrow keys of the radio group, then tick the personal connection.
  await dialog.getByRole("radio", { name: /^Org/ }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("radio", { name: /^Private/ })).toBeChecked();
  await linear.focus();
  await page.keyboard.press("Space");
  await docs.check();
  await expect(linear).toBeChecked();
  await dialog.getByRole("radio", { name: /^Org/ }).check();
  await expect(dialog.getByText("A personal connection was unselected")).toBeVisible();
  await expect(linear).not.toBeChecked();
  await expect(docs).toBeChecked();
  await dialog.getByRole("radio", { name: /^Private/ }).check();
  await linear.check();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: "test-results/launch-connections-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();

  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Private (only its owner)")).toBeVisible();
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
  expect(launch).toMatchObject({ visibility: "private", connections: [ALICE_LINEAR, ACME_DOCS] });
  // The default repository context sends no repo at all.
  expect(launch).not.toHaveProperty("repo");

  // A forged org launch with a personal connection is refused before it reaches the server.
  await page.goto("/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page
    .getByRole("dialog")
    .locator('input[name="visibility"]')
    .evaluate((input) => {
      const forged = document.createElement("input");
      forged.type = "hidden";
      forged.name = "connections";
      forged.value = "00000000-0000-4000-8000-000000000061";
      input.after(forged);
    });
  await page.getByRole("dialog").getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Alice Linear: Personal: uses your own account, so it needs a private sandbox.",
  );
  expect((await mockState()).launches).toHaveLength(1);
});

test("switching organization switches the connections and their launch choices", async ({ page }) => {
  await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ multiOrg: true }) });
  await signIn(page, "alice@example.com", "/connections");
  await page.getByLabel("Active organization").selectOption(ZENITH);
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(card(page, "Zenith Search")).toBeVisible();
  await expect(card(page, "Acme Docs")).toHaveCount(0);
  await expect(card(page, "Alice Linear")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add connection" })).toBeVisible();
  // Alice is only a member in Zenith: its org connections are read-only for her.
  await expect(card(page, "Zenith Search")).toContainText("Managed by the org's admins.");
  const lists = (await mockState()).controlCalls.filter((call) => call.operation === "list");
  expect(lists.at(-1)?.body).toEqual({ org: ZENITH });
});

test("a sandbox's applied connections come from the registry, and a failed read is not shown as none", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const section = page.locator("[data-slot=card]", { hasText: "MCP connections" });
  await expect(section).toContainText("Launched without MCP connections you can see.");
  await expect(page.getByText("Org (every member)")).toBeVisible();
  await fetch(`${MOCK}/__test/fail-sandbox-connections`, { method: "POST" });
  await page.reload();
  await expect(section.getByRole("alert")).toContainText("could not be loaded");
  await expect(section).not.toContainText("Launched without");
});
