import { describe, expect, test } from "bun:test";
import { accountsFromList, createAccountControl } from "../src/lib/account-control.ts";
import {
  type AccountUsage,
  launchDefault,
  type ModelAccount,
  parseAuthCapabilities,
  parseUsage,
  terminalLogin,
  usageView,
} from "../src/lib/model-accounts.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function account(n: number, fields: Partial<ModelAccount> = {}): ModelAccount {
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
  };
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
        user: [row(1, { scope: "org", value_enc: "\\x0102" })],
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
    expect(Object.keys(accounts[0] ?? {})).not.toContain("value_enc");
    expect(legacy).toBe(false);
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
      hiddenWindows: 0,
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
    // Only a report with windows ever carries numbers; nothing else becomes zero.
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
    // A zero-decimal currency is not divided by 100.
    expect(extra({ enabled: true, currency: "JPY", usedMinor: 450, limitMinor: null })).toEqual({
      used: 450,
      limit: null,
      currency: "JPY",
    });
    // The producer's major-unit aliases win over our own exponent table (HUF is 2 in ISO, 0 for some processors).
    expect(
      extra({ enabled: true, currency: "HUF", usedMinor: 45000, limitMinor: null, used: 450, limit: null }),
    ).toEqual({ used: 450, limit: null, currency: "HUF" });
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
    // Repeated identities are all shown under distinct keys, and none is counted as unreadable.
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
    // #624 v1 sends its own stable id and source-derived label: used as they are.
    const v1 = parseUsage({
      ...report,
      windows: [{ id: "five_hour", label: "5-hour limit", kind: "five_hour", usedPercent: 30, resetsAt: null }],
    });
    expect(v1?.windows.map((window) => [window.id, window.label])).toEqual([["five_hour", "5-hour limit"]]);
    // Only a report none of whose windows can be read is an unrecognized format.
    expect(parseUsage({ ...report, windows: [{ kind: "monthly", utilization: 0.4 }] })).toBeNull();
  });

  test("a server that does not offer usage is null; a failure for the account itself is an error", async () => {
    const answer = (status: number, message: string) =>
      createAccountControl({
        serverUrl: "https://armada.test/mcp",
        token: "session",
        fetch: (async () => Response.json({ error: { message } }, { status })) as unknown as typeof fetch,
      });
    expect(await answer(404, "Unknown route.").usage(uuid(1))).toBeNull();
    // The server's read worked but its window is not one this dashboard reads: not a failure, not "no allowance".
    const unreadable = createAccountControl({
      serverUrl: "https://armada.test/mcp",
      token: "session",
      fetch: (async () =>
        Response.json({
          usage: { accountId: uuid(1), version: 1, status: "fresh", observedAt: null, windows: [{ utilization: 0.4 }] },
        })) as unknown as typeof fetch,
    });
    expect(usageView(await unreadable.usage(uuid(1)), { version: 1 }).kind).toBe("unreadable");
    await expect(answer(404, "No such account.").usage(uuid(1))).rejects.toThrow("No such account.");
  });
});

test("the terminal sign-in is only the command the server reports, with the name as one literal argument", () => {
  // #604's nested shape: the documented `--name <name>` template is canonicalized to its allowlisted base.
  const reported = parseAuthCapabilities({
    hostedOAuth: false,
    claude: { login: null, import: "armada creds import claude --name <name> --file <private-token-file>" },
    codex: { login: "armada creds login codex --name <name>" },
  });
  expect(reported?.hostedOAuth).toBe(false);
  expect(terminalLogin(reported, "codex_auth", "Work")).toBe("armada creds login codex --name Work");
  expect(terminalLogin(reported, "codex_auth", `Bob's $HOME`)).toBe(
    `armada creds login codex --name 'Bob'\\''s $HOME'`,
  );
  // A command that is not a plain `armada creds login`, or a server that reports nothing, offers no terminal path.
  expect(terminalLogin(reported, "claude_oauth", "Work")).toBeNull();
  expect(terminalLogin(null, "codex_auth", "Work")).toBeNull();
  // Arbitrary shell, another placeholder or an extra flag is never shown, in either shape.
  for (const command of [
    "armada creds login codex; curl https://example.test",
    "armada creds login codex --name <name> --org <org>",
    "armada creds login codex --name $(whoami)",
  ]) {
    expect(parseAuthCapabilities({ codex: { login: command } })?.terminal).toEqual({});
    expect(parseAuthCapabilities({ nativeCLI: [{ kind: "codex_auth", command }] })?.terminal).toEqual({});
  }
  expect(parseAuthCapabilities({ nativeCLI: { codex_auth: "armada creds login codex" } })?.terminal).toEqual({
    codex_auth: "armada creds login codex",
  });
});
