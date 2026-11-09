import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const ALICE = "00000000-0000-4000-8000-000000000001";
const WORK_TOKEN = "sk-ant-oat01-work-account-token-e2e";
const HOME_TOKEN = "sk-ant-oat01-home-account-token-e2e";

type Row = Record<string, unknown>;

async function mock(path: string, body: object = {}): Promise<Row> {
  const response = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return (await response.json()) as Row;
}

const launches = async () => (await mock("/__test/state")).launches as Row[];

function account(id: number, name: string, extra: Row = {}): Row {
  const now = "2026-11-08T10:00:00.000Z";
  return {
    id: `00000000-0000-4000-8000-0000000007${String(id).padStart(2, "0")}`,
    scope: "user",
    owner_id: ALICE,
    kind: "claude_oauth",
    value_enc: "\\x0102",
    created_at: now,
    name,
    is_default: false,
    version: 1,
    status: "active",
    expires_at: null,
    updated_at: now,
    ...extra,
  };
}

async function addAccount(page: Page, name: string, token: string, makeDefault: boolean) {
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /Claude subscription/ }).check();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("OAuth token").fill(token);
  if (makeDefault) await dialog.getByLabel(/Make it the default/).check();
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openLaunch(page: Page) {
  await page.goto("/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  return page.getByRole("dialog");
}

test("two accounts of one service: the deliberate default is preselected, and the chosen one is sent by id", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/credentials");
  const claude = page.locator('[data-harness="claude"]');
  // The org's migrated Anthropic key is the only Claude Code account: launches use it until Alice adds hers.
  await expect(claude.getByText("New launches use Anthropic API key, the org's only account.")).toBeVisible();

  await addAccount(page, "Work", WORK_TOKEN, false);
  await expect(claude.getByText("New launches use Work, your only account.")).toBeVisible();
  await addAccount(page, "Home", HOME_TOKEN, true);
  await expect(claude.locator("[data-launch-uses]")).toHaveText("New launches use Home, your default.");
  // A subscription's usage is not reported by this server: it says so, and never shows a number.
  const work = claude.locator('[data-account="Work"]');
  await expect(work.locator('[data-usage="unknown"]')).toContainText("Usage unknown");
  await expect(claude.locator('[data-account="Anthropic API key"] [data-usage]')).toHaveCount(0);

  // The tokens went to the server once, in the request body; the page never holds them.
  await page.reload();
  const html = await page.content();
  expect(html).not.toContain(WORK_TOKEN);
  expect(html).not.toContain(HOME_TOKEN);
  const calls = (await mock("/__test/accounts")).calls as { route: string; body: Row }[];
  const sets = calls.filter((call) => call.route === "creds/accounts/set");
  expect(sets.map((call) => [call.body.scope, call.body.kind, call.body.name, call.body.value])).toEqual([
    ["user", "claude_oauth", "Work", "[sent]"],
    ["user", "claude_oauth", "Home", "[sent]"],
  ]);
  const workId = String((await accountId("Work")) ?? "");

  let dialog = await openLaunch(page);
  const select = dialog.getByLabel("Account");
  await expect(select.locator("option:checked")).toHaveText("Home (Claude subscription, default)");
  await select.selectOption({ label: "Work (Claude subscription)" });
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  expect((await launches()).at(-1)).toMatchObject({ harness: "claude", credentialId: workId });

  // Codex has no account here: the dialog says so and nothing is sent for it.
  dialog = await openLaunch(page);
  await dialog.getByLabel("Agent").selectOption("codex");
  await expect(dialog.locator('[data-account-field="none"]')).toContainText("No Codex account.");
});

async function accountId(name: string): Promise<unknown> {
  const stored = (await (await fetch(`${MOCK}/__test/credentials`)).json()) as Row[];
  return stored.find((row) => row.name === name)?.id;
}

test("rename and default keep the account's id; removing the default leaves the choice to the person", async ({
  page,
}) => {
  await mock("/__test/accounts", { seed: [account(1, "Work", { is_default: true }), account(2, "Home")] });
  await signIn(page, "alice@example.com", "/credentials");
  const claude = page.locator('[data-harness="claude"]');
  const home = claude.locator('[data-account="Home"]');

  await home.getByRole("button", { name: "Rename Home" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Side project");
  await page.getByRole("dialog").getByRole("button", { name: "Save name" }).click();
  const side = claude.locator('[data-account="Side project"]');
  await expect(side.getByRole("status")).toHaveText("Renamed to Side project.");

  await side.getByRole("button", { name: "Make Side project the default" }).click();
  await expect(claude.locator("[data-launch-uses]")).toHaveText("New launches use Side project, your default.");

  await claude.locator('[data-account="Side project"]').getByRole("button", { name: "Remove Side project" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove account" }).click();
  await expect(claude.locator('[data-account="Side project"]')).toHaveCount(0);
  // Work is now the only personal account: launches use it, and say why.
  await expect(claude.locator("[data-launch-uses]")).toHaveText("New launches use Work, your only account.");
  const ids = ((await mock("/__test/accounts")).calls as { route: string; body: Row }[])
    .filter((call) => !["creds/list", "creds/accounts/usage"].includes(call.route))
    .map((call) => [call.route, call.body.id]);
  const sideId = "00000000-0000-4000-8000-000000000702";
  expect(ids).toEqual([
    ["creds/accounts/rename", sideId],
    ["creds/accounts/default", sideId],
    ["creds/accounts/remove", sideId],
  ]);
});

test("several accounts and no default: the launch asks who is billed and the server action refuses a blank choice", async ({
  page,
}) => {
  await mock("/__test/accounts", {
    seed: [account(1, "Work"), account(2, "Home"), account(3, "Old", { status: "expired" })],
  });
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunch(page);
  const select = dialog.getByLabel("Account");
  await expect(select.locator("option:checked")).toHaveText("Choose an account");
  await expect(dialog.locator('[data-account-field="ambiguous"]')).toHaveText(
    "No default for this agent: choose who is billed.",
  );
  await expect(select.locator("option", { hasText: "Old" })).toBeDisabled();

  // A forged blank choice reaches the action, which refuses it rather than letting the server pick.
  await select.evaluate((element) => element.removeAttribute("required"));
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose which account the agent runs on.");
  expect(await launches()).toEqual([]);
});

test("a member sees the org's accounts but only manages their own", async ({ page }) => {
  await signIn(page, "bob@example.com", "/credentials");
  const org = page.locator('[data-account="Anthropic API key"]');
  await expect(org).toContainText("Acme");
  await expect(org.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Add account" }).click();
  // Only an admin adds an org account: a member has no scope choice.
  await expect(page.getByRole("dialog").getByRole("radio", { name: /Acme/ })).toHaveCount(0);
});

test("a server older than named accounts is said plainly, and launches send no account", async ({ page }) => {
  await mock("/__test/accounts", { legacy: true });
  await signIn(page, "alice@example.com", "/credentials");
  await expect(page.locator('[data-accounts="legacy"]')).toContainText("This Armada server predates named accounts");
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);

  const dialog = await openLaunch(page);
  await expect(dialog.getByLabel("Account")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  expect((await launches()).at(-1)).not.toHaveProperty("credentialId");
});

test("usage reads as reported: current windows, last-known after a token change, unavailable, failed, unknown", async ({
  page,
}) => {
  const window = (used: number) => ({
    id: "5h",
    label: "5-hour window",
    usedPercent: used,
    resetsAt: "2099-01-01T00:00:00.000Z",
  });
  const report = (n: number, fields: Row) => ({
    accountId: `00000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`,
    version: 1,
    status: "fresh",
    observedAt: new Date().toISOString(),
    windows: [window(35)],
    ...fields,
  });
  await mock("/__test/accounts", {
    seed: [
      account(1, "Fresh"),
      account(2, "Rotated", { version: 2 }),
      account(3, "Token only"),
      account(4, "Failing"),
      account(5, "Older server"),
    ],
    usage: {
      [String(account(1, "").id)]: report(1, { extraUsage: { used: 4.5, limit: 20, currency: "USD" } }),
      [String(account(2, "").id)]: report(2, {}),
      [String(account(3, "").id)]: report(3, { status: "unavailable", windows: [] }),
      [String(account(4, "").id)]: { fail: 503 },
    },
  });
  await signIn(page, "alice@example.com", "/credentials");
  const card = (name: string) => page.locator(`[data-account="${name}"]`);

  await expect(card("Fresh").locator('[data-usage="fresh"]')).toContainText("65% left");
  await expect(card("Fresh")).toContainText("35% used, resets in");
  await expect(card("Fresh")).toContainText("Extra usage: $4.50 of $20.00");
  // Reported under the token before it was replaced: still shown, but as last known.
  await expect(card("Rotated").locator('[data-usage="stale"]')).toContainText("Last known");
  await expect(card("Token only").locator('[data-usage="unavailable"]')).toContainText("Usage unavailable");
  await expect(card("Failing").locator('[data-usage="error"]')).toContainText("Usage not read");
  await expect(card("Older server").locator('[data-usage="unknown"]')).toContainText("Usage unknown");
  for (const name of ["Token only", "Failing", "Older server"]) await expect(card(name)).not.toContainText("%");
});

test("a ChatGPT subscription signs in from the terminal; pasting auth.json stays behind a disclosure", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/credentials");
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /ChatGPT subscription/ }).check();
  await dialog.getByLabel("Name").fill("Bob's $HOME");
  await expect(dialog.locator("[data-terminal-login] code")).toHaveText(
    "armada creds login codex --name 'Bob'\\''s $HOME'",
  );
  await expect(dialog.getByLabel("auth.json")).toBeHidden();
  await dialog.getByText("Paste auth.json instead").click();
  await expect(dialog.getByLabel("auth.json")).toBeVisible();
  // An org account is an admin's paste: no terminal command for it.
  await dialog.getByRole("radio", { name: /Acme/ }).check();
  await expect(dialog.locator("[data-terminal-login]")).toHaveCount(0);
});
