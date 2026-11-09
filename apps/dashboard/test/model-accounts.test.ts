import { describe, expect, test } from "bun:test";
import { accountsFromList, createAccountControl } from "../src/lib/account-control.ts";
import {
  type AccountUsage,
  checkAccountChoice,
  launchDefault,
  type ModelAccount,
  parseAuthCapabilities,
  parseUsage,
  terminalLogin,
  usageView,
} from "../src/lib/model-accounts.ts";
import producer from "./fixtures/model-usage-v3.json";

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
    ["a malformed id", ready(work), "claude", "not-a-uuid", { ok: false, error: "That request is not valid." }],
    [
      "an unreadable list",
      { state: "error", message: "Timed out." } as const,
      "claude",
      work.id,
      { ok: false, error: "Model accounts could not be loaded: Timed out. Reload and try again." },
    ],
    ["no Armada server", { state: "not-configured" } as const, "claude", "", { ok: false }],
  ] as const)("%s", (_name, list, harness, requested, expected) => {
    expect(checkAccountChoice(list, harness, requested, NOW)).toMatchObject(expected);
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
    // An explicit null major amount is the producer saying it could not tell: no conversion of its own.
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

describe("#624 v3 native credits and meters, as the producer reports them", () => {
  type Case = Exclude<keyof typeof producer, "$comment">;
  /** The producer's own response for a case and the view of it, read under the same account version. */
  const read = (name: Case) => {
    const usage = parseUsage(producer[name].usage);
    const view = usageView(usage, { version: 1 });
    if (!("credits" in view)) throw new Error(`${name} reads as ${view.kind}`);
    return view;
  };

  test.each([
    ["creditOnlyZero", { hasCredits: false, unlimited: false, balance: "0" }],
    ["creditOnlyDecimal", { hasCredits: true, unlimited: false, balance: "9007199254740993.0012300" }],
    ["creditOnlyUnlimited", { hasCredits: false, unlimited: true, balance: null }],
  ] as const)("a %s reading is a reading on its own, kept exactly as the provider sent it", (name, credits) => {
    const view = read(name);
    expect(view.kind).toBe("fresh");
    // One meter, once: the summary and its identical map view are the same reading. The string is never a number.
    expect(view.credits).toEqual([
      { key: "summary", sourceId: "codex", label: "codex", ...credits, observedAt: "2026-11-09T12:00:16.000Z" },
    ]);
    expect(view.windows).toEqual([]);
    expect(view.extra).toBeNull();
  });

  test("every meter is shown once; a meter's own view that differs from the summary is shown and named as such", () => {
    const view = read("meters");
    expect(
      view.windows.map((window) => [window.label, window.sourceId, window.usedPercent, window.durationMins]),
    ).toEqual([
      ["Primary", "codex", 25, 300],
      ["Secondary", "codex", 50, 10080],
      ["Review · primary", "review", 42, null],
      ["Review · secondary", "review", 7, null],
      ["codex · Primary (meter view)", "codex", 26, 300],
    ]);
    expect(new Set(view.windows.map((window) => window.id)).size).toBe(view.windows.length);
    // Balances per meter, never added up: the summary's "0" and the codex map's "1.200" are both actual readings.
    expect(view.credits.map((meter) => [meter.label, meter.sourceId, meter.balance, meter.unlimited])).toEqual([
      ["codex", "codex", "0", false],
      ["codex (meter view)", "codex", "1.200", false],
      ["Review", "review", "12.3400", false],
      ["extra", "extra", null, true],
    ]);
  });

  test("a sparse update keeps older parts with their own read time, and the report reads as last known", () => {
    const view = read("sparseStale");
    expect(view.kind).toBe("stale");
    expect(view.observedAt).toBe("2026-11-09T12:01:33.000Z");
    expect(view.windows.map((window) => [window.sourceId, window.usedPercent, window.observedAt])).toEqual([
      ["codex", 31, "2026-11-09T12:01:33.000Z"],
      ["review", 42, "2026-11-09T12:00:16.000Z"],
    ]);
    // The retained balances keep the time they were read, not the time of the update that left them out.
    expect(view.credits.map((meter) => [meter.sourceId, meter.balance, meter.observedAt])).toEqual([
      ["codex", "0.000", "2026-11-09T12:00:16.000Z"],
      ["review", "12.3400", "2026-11-09T12:00:16.000Z"],
    ]);
  });

  test("malformed credits are left out rather than read as zero, and a shape it cannot read is counted", () => {
    expect(usageView(parseUsage(producer.malformedCredits.usage), { version: 1 }).kind).toBe("unavailable");
    const { usage } = producer.creditOnlyZero;
    const numeric = parseUsage({
      ...usage,
      credits: { hasCredits: true, unlimited: false, balance: 12.5 },
      buckets: [],
    });
    expect(numeric?.credits).toEqual([]);
    expect(numeric?.hiddenCredits).toBe(1);
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
