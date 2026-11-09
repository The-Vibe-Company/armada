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
  await expect(claude.getByText("Launch preselects Anthropic API key, the org's only account.")).toBeVisible();

  await addAccount(page, "Work", WORK_TOKEN, false);
  await expect(claude.getByText("Launch preselects Work, your only account.")).toBeVisible();
  await addAccount(page, "Home", HOME_TOKEN, true);
  await expect(claude.locator("[data-launch-uses]")).toHaveText("Launch preselects Home, your default.");
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

  await side.getByRole("button", { name: "Make default, Side project" }).click();
  await expect(claude.locator("[data-launch-uses]")).toHaveText("Launch preselects Side project, your default.");

  await claude.locator('[data-account="Side project"]').getByRole("button", { name: "Remove Side project" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove account" }).click();
  await expect(claude.locator('[data-account="Side project"]')).toHaveCount(0);
  // Work is now the only personal account: launches use it, and say why.
  await expect(claude.locator("[data-launch-uses]")).toHaveText("Launch preselects Work, your only account.");
  const ids = ((await mock("/__test/accounts")).calls as { route: string; body: Row }[])
    .filter((call) => /^creds\/accounts\/(set|rename|default|remove)$/.test(call.route))
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
    seed: [account(1, "Work"), account(2, "Home"), account(3, "Old", { status: "revoked" })],
  });
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunch(page);
  const select = dialog.getByLabel("Account");
  await expect(select.locator("option:checked")).toHaveText("Choose an account");
  await expect(dialog.locator('[data-account-field="ambiguous"]')).toHaveText(
    "No default for this agent: choose who is billed.",
  );
  await expect(select.locator("option", { hasText: "Old" })).toBeDisabled();
  await expect(select.locator("option", { hasText: "Old" })).toHaveText("Old (Claude subscription, revoked)");

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
  // #624 v1 Window: a stable id and a source-derived label beside the native kind.
  const window = (used: number | null) => ({
    id: "five_hour",
    label: "5-hour limit",
    kind: "five_hour",
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
      account(6, "Spend only"),
      account(7, "Revoked", { status: "revoked" }),
    ],
    usage: {
      [String(account(1, "").id)]: report(1, {
        windows: [
          window(35),
          { id: "seven_day", label: "Weekly limit", kind: "seven_day", usedPercent: null, resetsAt: null },
          { surface: "unknown" },
        ],
        extraUsage: { enabled: true, currency: "USD", usedMinor: 450, limitMinor: 2000, used: 4.5, limit: 20 },
      }),
      [String(account(2, "").id)]: report(2, {}),
      [String(account(3, "").id)]: report(3, { status: "unavailable", windows: [] }),
      [String(account(4, "").id)]: { fail: 503 },
      // Spend with no rolling windows; the revoked account's report must never be asked for.
      [String(account(6, "").id)]: report(6, {
        windows: [],
        extraUsage: { enabled: true, currency: "EUR", usedMinor: 1250, limitMinor: null, used: 12.5, limit: null },
      }),
      [String(account(7, "").id)]: report(7, {}),
    },
  });
  await signIn(page, "alice@example.com", "/credentials");
  const card = (name: string) => page.locator(`[data-account="${name}"]`);

  await expect(card("Fresh").locator('[data-usage="fresh"]')).toContainText("65% left");
  await expect(card("Fresh")).toContainText("35% used, resets in");
  // A null reading is the provider saying "unavailable" for that window; an unrecognized sibling is counted, not shown.
  await expect(card("Fresh")).toContainText("5-hour limit");
  await expect(card("Fresh")).toContainText("Weekly limitUnavailable");
  await expect(card("Fresh")).toContainText("Reading unavailable");
  await expect(card("Fresh")).toContainText("1 window in a form this dashboard cannot read yet.");
  await expect(card("Fresh")).toContainText("Extra usage: $4.50 of $20.00");
  // Reported under the token before it was replaced: still shown, but as last known.
  await expect(card("Rotated").locator('[data-usage="stale"]')).toContainText("Last known");
  await expect(card("Token only").locator('[data-usage="unavailable"]')).toContainText("Usage unavailable");
  await expect(card("Failing").locator('[data-usage="error"]')).toContainText("Usage not read");
  await expect(card("Older server").locator('[data-usage="unknown"]')).toContainText("Usage unknown");
  for (const name of ["Token only", "Failing", "Older server"]) await expect(card(name)).not.toContainText("%");
  // Reported spend alone: shown as spend, with no invented window and no zero allowance.
  await expect(card("Spend only").locator('[data-usage="fresh"]')).toContainText("Extra usage: €12.50");
  await expect(card("Spend only")).not.toContainText("%");
  await expect(card("Spend only")).not.toContainText("Usage unavailable");
  // A revoked account has nothing to read: no usage block, and its usage is never requested.
  await expect(card("Revoked").locator("[data-usage]")).toHaveCount(0);
  const asked = ((await mock("/__test/accounts")).calls as { route: string; body: Row }[])
    .filter((call) => call.route === "creds/accounts/usage")
    .map((call) => call.body.id);
  expect(asked).not.toContain(account(7, "").id);
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

  // A server that does not report a terminal sign-in offers paste only, never a command it did not name.
  await mock("/__test/accounts", { authCapabilities: null });
  await page.reload();
  await page.getByRole("button", { name: "Add account" }).click();
  await page
    .getByRole("dialog")
    .getByRole("radio", { name: /ChatGPT subscription/ })
    .check();
  await expect(page.getByRole("dialog").locator("[data-terminal-login]")).toHaveCount(0);
  await expect(page.getByRole("dialog").getByLabel("auth.json")).toBeVisible();
});
