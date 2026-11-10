import { expect, type Page, test } from "@playwright/test";
import producer from "../test/fixtures/model-usage-v3.json" with { type: "json" };
import { MOCK, openLaunch as openLaunchDialog, reset, signIn } from "./helpers";

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
  await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /Claude subscription/ }).check();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("OAuth token").fill(token);
  if (makeDefault) await dialog.getByLabel(/Make it the default/).check();
  await dialog.getByRole("button", { name: "Add subscription" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openLaunch(page: Page) {
  await page.goto("/goldens");
  return openLaunchDialog(page, "shared-golden");
}

test("two accounts of one service: the deliberate default is preselected, and the chosen one is sent by id", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/harness");
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
  await dialog.getByRole("radio", { name: "Codex" }).check();
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
  await signIn(page, "alice@example.com", "/harness");
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
  await expect(page.getByRole("alertdialog")).toContainText(
    "New launches can no longer use it. Sandboxes launched with it keep their files and conversations, but new messages to them are refused; a new launch needs another usable account.",
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove account" }).click();
  await expect(claude.locator('[data-account="Side project"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="toast"]')).toContainText("Removed Side project.");
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
  await signIn(page, "bob@example.com", "/harness");
  const org = page.locator('[data-account="Anthropic API key"]');
  await expect(org).toContainText("Acme");
  await expect(org.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
  // Only an admin adds an org account: a member has no scope choice.
  await expect(page.getByRole("dialog").getByRole("radio", { name: /Acme/ })).toHaveCount(0);
});

test("replacing a token keeps the account and names the version seen; a replacement from a stale page is refused", async ({
  page,
}) => {
  const work = account(41, "Work", { is_default: true });
  await mock("/__test/accounts", { seed: [work] });
  await signIn(page, "alice@example.com", "/harness");
  // A second tab read the same version before the first one replaced the token.
  const stale = await page.context().newPage();
  await stale.goto("/harness");

  const replace = async (on: Page, token: string) => {
    await on.getByRole("button", { name: "Replace token, Work" }).click();
    const dialog = on.getByRole("dialog");
    // #612 pins a sandbox to the account version it launched with: a replacement refuses new messages to those
    // sandboxes and keeps their files and conversations.
    await expect(dialog.locator("[data-replace-effect]")).toHaveText(
      "Saving a new OAuth token creates a new version of Work. Sandboxes launched with the current version keep their files and conversations, but new messages to them are refused. Launch a new sandbox to use the new version.",
    );
    // The effect is part of the dialog's accessible description, so a screen reader announces it on open.
    await expect(dialog).toHaveAccessibleDescription(/new messages to them are refused/);
    await dialog.getByLabel("OAuth token").fill(token);
    await dialog.getByRole("button", { name: "Save OAuth token" }).click();
    return dialog;
  };
  await expect(await replace(page, HOME_TOKEN)).toHaveCount(0);
  const calls = ((await mock("/__test/accounts")).calls as { route: string; body: Row }[]).filter(
    (call) => call.route === "creds/accounts/set",
  );
  expect(calls).toEqual([
    {
      route: "creds/accounts/set",
      body: expect.objectContaining({ scope: "user", id: work.id, expectedVersion: 1, name: "Work", value: "[sent]" }),
    },
  ]);
  const row = ((await mock("/__test/credentials")) as unknown as Row[]).find((item) => item.id === work.id);
  expect(row).toMatchObject({ version: 2, is_default: true, name: "Work" });

  const refused = await replace(stale, WORK_TOKEN);
  await expect(refused).toContainText("This account changed elsewhere. Reload the page and try again.");
  await expect(refused).not.toContainText(WORK_TOKEN);
});

test("the launch select names the org on an org account, so equal names still say who is billed", async ({ page }) => {
  // A personal account named like the org's migrated one.
  await mock("/__test/accounts", { seed: [account(42, "Anthropic API key", { kind: "anthropic", is_default: true })] });
  await signIn(page, "alice@example.com", "/harness");
  const select = (await openLaunch(page)).getByLabel("Account");
  await expect(select.locator("option:checked")).toHaveText("Anthropic API key (default)");
  await expect(select.locator('optgroup[label="Acme"] option')).toHaveText(["Anthropic API key (Acme)"]);
});

test("a sized launch keeps the chosen account: the size and the account are both sent, on the sized route only", async ({
  page,
}) => {
  await mock("/__test/reset", { sizePolicies: true });
  const work = account(51, "Work", { is_default: true });
  const home = account(52, "Home");
  await mock("/__test/accounts", { seed: [work, home] });
  await signIn(page, "alice@example.com", "/goldens");
  const open = () => openLaunchDialog(page, "shared-golden");

  let dialog = await open();
  const accountSelect = dialog.getByLabel("Account");
  const size = dialog.getByLabel("Machine size");
  await expect(accountSelect.locator("option:checked")).toHaveText("Work (Claude subscription, default)");
  await expect(size.locator("option").first()).toHaveText("Default · Medium (golden)");
  // Changing one never resets the other.
  await accountSelect.selectOption({ label: "Home (Claude subscription)" });
  await size.selectOption("large");
  await expect(accountSelect).toHaveValue(String(home.id));
  // Switching the agent re-mounts its own fields only: every field is still there exactly once.
  await dialog.getByRole("radio", { name: "Codex" }).check();
  await dialog.getByRole("radio", { name: "Claude Code" }).check();
  for (const label of ["Account", "Model", "Project", "Machine size"])
    await expect(dialog.getByText(label, { exact: true })).toHaveCount(1);
  await accountSelect.selectOption({ label: "Home (Claude subscription)" });
  await expect(size).toHaveValue("large");
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  // The golden's stored default alone also needs the sized route; the preselected account still goes with it.
  await page.goto("/goldens");
  dialog = await open();
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  const state = await mock("/__test/state");
  expect(state.launchRoutes).toEqual(["sandbox/launch-sized-v1", "sandbox/launch-sized-v1"]);
  expect(state.launches).toEqual([
    expect.objectContaining({ credentialId: home.id, size: "large", sizePolicyVersion: 1 }),
    expect.objectContaining({ credentialId: work.id, sizePolicyVersion: 1 }),
  ]);
  expect((state.launches as Row[])[1]).not.toHaveProperty("size");
});

test("a refused launch keeps the chosen account: the retry bills who the person picked, not the default", async ({
  page,
}) => {
  await mock("/__test/reset", { sizePolicies: true, refuseSize: "xlarge" });
  const work = account(53, "Work", { is_default: true });
  const home = account(54, "Home");
  await mock("/__test/accounts", { seed: [work, home] });
  await signIn(page, "alice@example.com", "/goldens");
  const dialog = await openLaunchDialog(page, "shared-golden");
  const accountSelect = dialog.getByLabel("Account");
  await accountSelect.selectOption({ label: "Home (Claude subscription)" });
  await dialog.getByLabel("Machine size").selectOption("xlarge");
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Requested size cannot be allocated.");
  // The form keeps its fields after the refusal; the billing choice is still the one the person made.
  await expect(accountSelect).toHaveValue(String(home.id));
  await expect(accountSelect.locator("option:checked")).toHaveText("Home (Claude subscription)");

  await dialog.getByLabel("Machine size").selectOption("large");
  await dialog.getByRole("button", { name: "Launch", exact: true }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const state = await mock("/__test/state");
  expect(state.launches).toEqual([
    expect.objectContaining({ credentialId: home.id, size: "xlarge" }),
    expect.objectContaining({ credentialId: home.id, size: "large" }),
  ]);
});

test("a server older than named accounts is said plainly, and launches send no account", async ({ page }) => {
  await mock("/__test/accounts", { legacy: true });
  await signIn(page, "alice@example.com", "/harness");
  await expect(page.locator('[data-accounts="legacy"]')).toContainText("This Armada server predates named accounts");
  await expect(page.getByRole("button", { name: "Add a subscription", exact: true })).toHaveCount(0);

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
  await signIn(page, "alice@example.com", "/harness");
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
  // It cannot become the default either: Reconnect leads instead.
  await expect(card("Revoked").getByRole("button", { name: "Make default, Revoked" })).toHaveCount(0);
  await expect(card("Revoked").getByRole("button", { name: "Reconnect, Revoked" })).toBeVisible();
  const asked = ((await mock("/__test/accounts")).calls as { route: string; body: Row }[])
    .filter((call) => call.route === "creds/accounts/usage")
    .map((call) => call.body.id);
  expect(asked).not.toContain(account(7, "").id);
});

test("native credits render as the producer sent them: every meter, exact balances, retained read times", async ({
  page,
}) => {
  // The producer's own v3 responses (test/fixtures/model-usage-v3.json), each addressed to its seeded account.
  const cases = [
    [21, "Meters", "meters"],
    [22, "Zero credits", "creditOnlyZero"],
    [23, "Exact decimal", "creditOnlyDecimal"],
    [24, "Unlimited", "creditOnlyUnlimited"],
    [25, "Sparse", "sparseStale"],
  ] as const;
  const seeded = cases.map(([n, name]) => account(n, name, { kind: "codex_auth" }));
  await mock("/__test/accounts", {
    seed: seeded,
    usage: Object.fromEntries(
      cases.map(([n, , key], index) => [
        String(account(n, "").id),
        { ...producer[key].usage, accountId: seeded[index]?.id },
      ]),
    ),
  });
  await signIn(page, "alice@example.com", "/harness");
  const card = (name: string) => page.locator(`[data-account="${name}"]`);
  const credits = (name: string) => card(name).locator("[data-credits] li");

  // Windows keep their meter and reported length; the codex meter's own differing reading is named, not merged.
  const meters = card("Meters").locator('[data-usage="fresh"]');
  await expect(meters.locator('[data-window="primary"]')).toContainText("Primary · 5 h75% left");
  await expect(meters.locator('[data-window="secondary"]')).toContainText("Secondary · 7 days50% left");
  await expect(meters.locator('[data-window="meter:codex:primary"]')).toContainText("codex · Primary (meter view)");
  await expect(credits("Meters")).toHaveText([
    "codex0 credits",
    "codex (meter view)1.200 credits",
    "Review12.3400 credits",
    "extraUnlimited",
  ]);
  // A balance is a count of credits, never money, and balances are not added up.
  await expect(card("Meters")).not.toContainText("$");
  await expect(card("Meters")).not.toContainText("13.");

  // Credit-only readings are readings: zero is the provider's zero, digits are kept past a number's precision.
  for (const [name, text] of [
    ["Zero credits", "codex0 credits"],
    ["Exact decimal", "codex9007199254740993.0012300 credits"],
    ["Unlimited", "codexUnlimited"],
  ] as const) {
    await expect(card(name).locator('[data-usage="fresh"]')).toBeVisible();
    await expect(credits(name)).toHaveText([text]);
    await expect(card(name)).not.toContainText("Usage unavailable");
    await expect(card(name)).not.toContainText("%");
  }

  // A sparse update: the report is last known, and parts it did not resend keep the time they were read.
  const sparse = card("Sparse").locator('[data-usage="stale"]');
  await expect(sparse).toContainText("Last known");
  await expect(
    sparse.locator('[data-window="review:primary"] [data-read-at="2026-11-09T12:00:16.000Z"]'),
  ).toBeVisible();
  await expect(sparse.locator('[data-window="primary"] [data-read-at]')).toHaveCount(0);
  await expect(sparse.locator('[data-credits] [data-read-at="2026-11-09T12:00:16.000Z"]')).toHaveCount(2);
});

test("a ChatGPT subscription signs in from the terminal; pasting auth.json stays behind a disclosure", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/harness");
  await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
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
  await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("radio", { name: /ChatGPT subscription/ })
    .check();
  await expect(page.getByRole("dialog").locator("[data-terminal-login]")).toHaveCount(0);
  await expect(page.getByRole("dialog").getByLabel("auth.json")).toBeVisible();
});

test("on a phone the terminal sign-in stays inside the add dialog, even for a long name", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", "/harness");
  await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /ChatGPT subscription/ }).check();
  await dialog.getByLabel("Name").fill("A very long account name for the team that shares one ChatGPT plan");
  await expect(dialog.locator("[data-terminal-login]")).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  // The whole command, quoted name included, is on screen: it wraps instead of hiding past a scroll.
  const code = dialog.locator("[data-terminal-login] code");
  await expect(code).toHaveText(
    "armada creds login codex --name 'A very long account name for the team that shares one ChatGPT plan'",
  );
  expect(await code.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  // Nothing pushes the page sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const login = await dialog.locator("[data-terminal-login]").boundingBox();
  expect(login && login.x + login.width <= (box?.x ?? 0) + (box?.width ?? 0)).toBe(true);
});
