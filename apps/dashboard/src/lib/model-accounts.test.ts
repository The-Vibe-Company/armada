import { describe, expect, test } from "bun:test";
import producer from "../../test/fixtures/model-usage-v3.json";
import { createAccountControl } from "./account-control.ts";
import {
  ACCOUNT_KINDS,
  type AccountUsage,
  accountState,
  accountsFor,
  accountsFromList,
  checkAccountChoice,
  checkDefaultChoice,
  KIND_INFO,
  kindFor,
  launchAccounts,
  launchDefault,
  type ModelAccount,
  modelAccountFailure,
  monthlyApiSpendLabel,
  orderAccounts,
  PASTE_SIGN_IN,
  parseAuthCapabilities,
  parseUsage,
  terminalLogin,
  usageView,
} from "./model-accounts.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function account(n: number, fields: Partial<ModelAccount> = {}) {
  return {
    id: uuid(n),
    scope: "user",
    kind: "claude_oauth",
    name: `Account ${n}`,
    isDefault: false,
    status: "active",
    expiresAt: null,
    updatedAt: "2026-11-08T10:00:00.000Z",
    version: 1,
    ...fields,
  } satisfies ModelAccount;
}

describe("the account a launch bills", () => {
  test.each([
    [
      "the personal default wins over the org's",
      [account(1), account(2, { isDefault: true }), account(3, { scope: "org", isDefault: true })],
      { state: "resolved", id: 2, why: "personal-default" },
    ],
    [
      "a single personal account needs no default",
      [account(1), account(3, { scope: "org", isDefault: true })],
      { state: "resolved", id: 1, why: "personal-only" },
    ],
    [
      "two personal accounts and no default ask, even with an org default",
      [account(1), account(2), account(3, { scope: "org", isDefault: true })],
      { state: "ambiguous" },
    ],
    [
      "no personal account falls to the org's only one",
      [account(3, { scope: "org" })],
      { state: "resolved", id: 3, why: "org-only" },
    ],
    [
      "an expired default is named, never skipped for another",
      [account(1, { isDefault: true, expiresAt: "2026-11-01T00:00:00.000Z" }), account(2)],
      { state: "unusable", id: 1 },
    ],
    [
      "another agent's accounts do not count",
      [account(1, { kind: "codex_auth", isDefault: true }), account(2, { kind: "openai" })],
      { state: "none" },
    ],
  ] as const)("%s", (_name, accounts, expected) => {
    const resolved = launchDefault(accounts, "claude", NOW);
    expect(resolved.state).toBe(expected.state);
    if ("id" in expected && "account" in resolved) expect(resolved.account.id).toBe(uuid(expected.id));
    if ("why" in expected && resolved.state === "resolved") expect(resolved.why).toBe(expected.why);
  });
});

describe("the account a launch request bills, as the server action checks it", () => {
  const ready = (...accounts: ModelAccount[]) => ({ state: "ready", orgId: "org", orgName: "Acme", accounts }) as const;
  const work = account(1, { name: "Work" });
  const other = account(2, { kind: "codex_auth", name: "Codex" });

  test.each([
    ["a listed, usable account", ready(work, other), "claude", work.id, { ok: true, id: work.id }],
    [
      "a server older than named accounts sends none",
      { state: "legacy" } as const,
      "claude",
      "",
      { ok: true, id: undefined },
    ],
    ["an agent with no account sends none", ready(other), "claude", "", { ok: true, id: undefined }],
    ["a blank choice", ready(work), "claude", "", { ok: false, error: "Choose which account the agent runs on." }],
    ["another agent's account", ready(work, other), "claude", other.id, { ok: false }],
    ["an id that is not listed (another org's)", ready(work), "claude", uuid(99), { ok: false }],
    ["any id when the agent has no account", ready(other), "claude", uuid(99), { ok: false }],
    [
      "an expired account",
      ready(account(3, { name: "Old", expiresAt: "2026-11-01T00:00:00.000Z" })),
      "claude",
      uuid(3),
      { ok: false, error: "Old is expired. Replace its token or choose another." },
    ],
    ["a revoked account", ready(account(4, { status: "revoked" })), "claude", uuid(4), { ok: false }],
    [
      "a Morph account whose models could not be loaded",
      ready(account(5, { kind: "morph" })),
      "codex",
      uuid(5),
      { ok: false, error: "Morph models could not be loaded. Reload and try again." },
    ],
    ["a malformed id", ready(work), "claude", "not-a-uuid", { ok: false, error: "That request is not valid." }],
    [
      "an unreadable list",
      { state: "error", message: "HTTP 503: credential_version unavailable" } as const,
      "claude",
      work.id,
      { ok: false, error: "Model accounts could not be loaded. Reload Models and try again." },
    ],
    ["no Armada server", { state: "not-configured" } as const, "claude", "", { ok: false }],
  ] as const)("%s", (_name, list, harness, requested, expected) => {
    expect(checkAccountChoice(list, harness, requested, NOW)).toMatchObject(expected);
  });
});

describe("an account that may become the default", () => {
  const accounts = [
    account(1, { name: "Work" }),
    account(2, { name: "Old", status: "revoked" }),
    account(3, { name: "Lapsed", expiresAt: "2026-11-09T11:00:00.000Z" }),
  ];
  test.each([
    ["a usable account", 1, { ok: true }],
    [
      "a revoked account",
      2,
      { ok: false, error: "Old cannot run now (revoked). Reconnect it before making it the default." },
    ],
    [
      "an expired account",
      3,
      { ok: false, error: "Lapsed cannot run now (expired). Reconnect it before making it the default." },
    ],
    ["an account no longer listed", 9, { ok: false, error: "That account no longer exists. Reload the page." }],
  ] as const)("%s", (_name, n, expected) => {
    expect(checkDefaultChoice(accounts, uuid(n), NOW)).toEqual(expected);
  });
});

describe("creds/list as accounts", () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    id: uuid(n),
    kind: "claude_oauth",
    name: `Account ${n}`,
    isDefault: false,
    status: "active",
    expiresAt: null,
    updatedAt: "2026-11-08T10:00:00.000Z",
    version: 1,
    ...extra,
  });

  test("scope is where a row sits; another org, hosting singletons and stray fields are left out", () => {
    const { accounts, legacy } = accountsFromList(
      {
        user: [
          row(1, {
            scope: "org",
            value_enc: "\\x0102",
            modelLimits: { "morph-kimik3": 2 },
            modelCounts: { "morph-kimik3": { runningAgents: 1, waitingAgents: 3 } },
          }),
        ],
        orgs: [
          { id: uuid(10), credentials: [row(2), { kind: "boat", createdAt: null }] },
          { id: uuid(11), credentials: [row(3)] },
        ],
      },
      uuid(10),
    );
    expect(accounts.map((item) => [item.id, item.scope])).toEqual([
      [uuid(1), "user"],
      [uuid(2), "org"],
    ]);
    expect(accounts[0]?.modelLimits).toEqual({ "morph-kimik3": 2 });
    expect(accounts[0]?.modelCounts).toEqual({ "morph-kimik3": { runningAgents: 1, waitingAgents: 3 } });
    expect(Object.keys(accounts[0] ?? {})).not.toContain("value_enc");
    expect(legacy).toBe(false);
  });

  test("preserves the exact monthly API subtotal on personal and organization accounts", () => {
    const monthlySpend = { periodStart: "2026-11-01", usd: "312.00000000000000001", unpricedTurns: 2 };
    const { accounts } = accountsFromList(
      {
        user: [row(1, { kind: "openai", monthlySpend })],
        orgs: [{ id: uuid(10), credentials: [row(2, { kind: "anthropic", monthlySpend })] }],
      },
      uuid(10),
    );
    expect(accounts.map((account) => account.monthlySpend)).toEqual([monthlySpend, monthlySpend]);
  });

  test.each([
    ["openai", undefined, "API: — USD this month"],
    ["anthropic", { usd: "0", unpricedTurns: 0 }, "API: 0 USD this month"],
    ["opencode", { usd: "0", unpricedTurns: 1 }, "API: — USD this month (1 unpriced turn)"],
    [
      "openai",
      { usd: "312.00000000000000001", unpricedTurns: 2 },
      "API: 312.00000000000000001 USD this month (2 unpriced turns)",
    ],
    ["openai", { usd: 312, unpricedTurns: 0 }, "API: — USD this month"],
    ["codex_auth", undefined, null],
    ["morph", undefined, null],
  ] as const)("renders monthly ledger data for %s with %j", (kind, spend, label) => {
    const monthlySpend = spend && { periodStart: "2026-11-01", ...spend };
    const { accounts } = accountsFromList({ user: [row(1, { kind, monthlySpend })] }, uuid(10));
    expect(accounts.map(monthlyApiSpendLabel)).toEqual([label]);
  });

  test("model rows without ids are a server older than named accounts, not an empty list", () => {
    expect(accountsFromList({ user: [{ kind: "claude_oauth", createdAt: "2026-11-01" }], orgs: [] }, uuid(10))).toEqual(
      {
        accounts: [],
        legacy: true,
      },
    );
  });
});

describe("usage", () => {
  const report = (fields: Partial<AccountUsage> = {}) =>
    ({
      accountId: uuid(1),
      version: 1,
      status: "fresh",
      observedAt: "2026-11-09T11:58:00.000Z",
      windows: [{ id: "five_hour", label: "Five hour", usedPercent: 40, resetsAt: "2026-11-09T14:00:00.000Z" }],
      extraUsage: null,
      credits: [],
      hiddenWindows: 0,
      hiddenCredits: 0,
      ...fields,
    }) as AccountUsage;

  test.each([
    ["a server that does not report usage", null, "unknown"],
    ["a failed read", report({ status: "error", windows: [] }), "error"],
    ["an account that reports no allowance", report({ status: "unavailable", windows: [] }), "unavailable"],
    ["a current report", report(), "fresh"],
    ["a report the server marks stale", report({ status: "stale" }), "stale"],
    ["a report from before the token was replaced", report({ version: 0 }), "stale"],
    [
      "reported spend with no rolling windows",
      report({ windows: [], extraUsage: { used: 12.5, limit: null, currency: "EUR" } }),
      "fresh",
    ],
    ["a fresh read with neither windows nor spend", report({ windows: [] }), "unavailable"],
  ] as const)("%s reads as %s", (_name, usage, kind) => {
    const view = usageView(usage, { version: 1 });
    expect(view.kind).toBe(kind);
    expect("windows" in view).toBe(kind === "fresh" || kind === "stale");
  });

  test("extra usage is minor units in the reported currency, shown only when enabled with a currency", () => {
    const base = { accountId: uuid(1), version: 1, status: "fresh", observedAt: null, windows: [] };
    const extra = (fields: object) => parseUsage({ ...base, extraUsage: fields })?.extraUsage;
    expect(extra({ enabled: true, currency: "USD", usedMinor: 450, limitMinor: 2000 })).toEqual({
      used: 4.5,
      limit: 20,
      currency: "USD",
    });
    expect(extra({ enabled: true, currency: "JPY", usedMinor: 450, limitMinor: null })).toEqual({
      used: 450,
      limit: null,
      currency: "JPY",
    });
    expect(
      extra({ enabled: true, currency: "HUF", usedMinor: 45000, limitMinor: null, used: 450, limit: null }),
    ).toEqual({ used: 450, limit: null, currency: "HUF" });
    expect(
      extra({ enabled: true, currency: "HUF", usedMinor: 45000, limitMinor: null, used: null, limit: null }),
    ).toBeNull();
    expect(extra({ enabled: false, currency: "USD", usedMinor: 450, limitMinor: 2000 })).toBeNull();
    expect(extra({ enabled: true, currency: null, usedMinor: 450, limitMinor: 2000 })).toBeNull();
  });

  test("#624 windows: a null reading is kept as unavailable, unreadable siblings are counted, never all dropped", () => {
    const report = { accountId: uuid(1), version: 1, status: "fresh", observedAt: "2026-11-09T11:58:00.000Z" };
    const parsed = parseUsage({
      ...report,
      windows: [
        { kind: "five_hour", usedPercent: 40, resetsAt: "2026-11-09T14:00:00.000Z", severity: "normal" },
        { kind: "seven_day", usedPercent: 12, resetsAt: null, model: "opus" },
        { kind: "seven_day", usedPercent: null, resetsAt: null, model: "sonnet" },
        { kind: "monthly", utilization: 0.4 },
      ],
    });
    expect(parsed?.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Five hour", 40],
      ["Seven day (opus)", 12],
      ["Seven day (sonnet)", null],
    ]);
    expect(parsed?.hiddenWindows).toBe(1);
    const view = parsed && usageView(parsed, { version: 1 });
    expect(view?.kind).toBe("fresh");
    const repeated = parseUsage({
      ...report,
      windows: [
        { kind: "five_hour", usedPercent: 10, resetsAt: null, group: "team" },
        { kind: "five_hour", usedPercent: 20, resetsAt: null, group: "team" },
      ],
    });
    expect(repeated?.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Five hour (team)", 10],
      ["Five hour (team)", 20],
    ]);
    expect(new Set(repeated?.windows.map((window) => window.id)).size).toBe(2);
    expect(repeated?.hiddenWindows).toBe(0);
    const v1 = parseUsage({
      ...report,
      windows: [{ id: "five_hour", label: "5-hour limit", kind: "five_hour", usedPercent: 30, resetsAt: null }],
    });
    expect(v1?.windows.map((window) => [window.id, window.label])).toEqual([["five_hour", "5-hour limit"]]);
    expect(parseUsage({ ...report, windows: [{ kind: "monthly", utilization: 0.4 }] })).toBeNull();
  });

  test("a server that does not offer usage is null; a failure for the account itself is an error", async () => {
    const answer = (status: number, message: string, code?: string) =>
      createAccountControl({
        serverUrl: "https://armada.test/mcp",
        token: "session",
        fetch: (async () => Response.json({ error: { code, message } }, { status })) as unknown as typeof fetch,
      });
    expect(await answer(404, "Unknown route.", "unknown_route").usage(uuid(1))).toBeNull();
