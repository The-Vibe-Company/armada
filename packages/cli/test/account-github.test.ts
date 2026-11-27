import { expect, test } from "bun:test";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const INSTALL_URL = "https://github.com/apps/armada/installations/new?state=armada_cli_test";
const ORG_A = { id: 10, account: "org-alpha", account_type: "Organization", repository_selection: "all" };
const ORG_B = { id: 20, account: "org-beta", account_type: "Organization", repository_selection: "selected" };

function harness(fetch: AuthIo["fetch"], opts: { stdoutIsTTY?: boolean | undefined; throwOpen?: boolean } = {}) {
  let out = "",
    err = "",
    nowMs = 1_700_000_000_000;
  const sleeps: number[] = [],
    opened: string[] = [];
  const auth: AuthIo = {
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "test-bearer" },
    fetch,
    session: memorySessionStore(),
    out: (s) => (out += s),
    err: (s) => (err += s),
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    open: (url) => {
      if (opts.throwOpen) throw new Error("xdg-open missing");
      opened.push(url);
    },
  };
  return {
    opened,
    sleeps,
    elapsedMs: () => nowMs - 1_700_000_000_000,
    output: () => ({ out, err }),
    run: (argv: string[]) =>
      run(
        argv,
        { out: auth.out, err: auth.err },
        { auth, ...(opts.stdoutIsTTY !== undefined ? { stdoutIsTTY: opts.stdoutIsTTY } : {}) },
      ),
  };
}

test("account ls github lists multiple orgs with scope, next step, and preserves JSON when piped or --json", async () => {
  const payload = {
    connection: {
      status: "connected",
      login: "octocat",
      installations: [ORG_A, ORG_B],
      installUrl: "https://github.com/apps/armada/installations/new",
      configured: true,
    },
  };
  const human = harness(async () => Response.json(payload));
  expect(await human.run(["account", "ls", "github"])).toBe(0);
  expect(human.output().out).toContain("GitHub: connected as octocat (2 installations)");
  expect(human.output().out).toContain("org-alpha");
  expect(human.output().out).toContain("all repositories");
  expect(human.output().out).toContain("org-beta");
  expect(human.output().out).toContain("selected repositories");
  expect(human.output().out).toContain("armada account add github");

  for (const [argv, stdoutIsTTY] of [
    [["account", "ls", "github", "--json"], undefined],
    [["account", "ls", "github"], false],
  ] as const) {
    const machine = harness(async () => Response.json(payload), { stdoutIsTTY });
    expect(await machine.run([...argv])).toBe(0);
    expect(JSON.parse(machine.output().out)).toEqual(payload);
  }
});

test("account ls github formats empty, disconnected, unconfigured, unavailable, and control-char states", async () => {
  const cases: readonly [Record<string, unknown>, string[]][] = [
    [
      { status: "connected", login: "octo\x1b[31mcat", installations: [], installUrl: "https://github.com/apps/a" },
      ["GitHub: connected as octocat (0 installations)", "installations: none", "armada account add github"],
    ],
    [
      { status: "connected", login: "octocat", installations: [ORG_A], installUrl: null },
      ["org-alpha", "not configured on this server"],
    ],
    [
      { status: "not_connected", login: null, installations: [], configured: true },
      ["GitHub: not connected", "armada account login github"],
    ],
    [
      { status: "not_connected", login: null, installations: [], configured: false },
      ["GitHub: not connected", "not configured on this server"],
    ],
    [
      { status: "needs_reconnect", login: "octocat", installations: [] },
      ["GitHub: needs reconnect (octocat)", "armada account login github"],
    ],
    [
      { status: "unavailable", login: "octocat", installations: [ORG_B], configured: true },
      ["GitHub: unavailable (octocat)", "Last known GitHub App installations:", "org-beta", "armada account ls github"],
    ],
  ];
  for (const [connection, snippets] of cases) {
    const h = harness(async () => Response.json({ connection }));
    expect(await h.run(["account", "ls", "github"])).toBe(0);
    for (const text of snippets) expect(h.output().out).toContain(text);
    expect(h.output().out).not.toContain("\x1b[");
  }
});

test("account add github detects a 2nd org via stateful flowId and formats human summary", async () => {
  let statusCalls = 0;
  const h = harness(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path === "/api/v1/github/install") return Response.json({ flowId: "flow-2", authorizationUrl: INSTALL_URL });
    statusCalls++;
    if (statusCalls === 1) {
      expect(body).toEqual({});
      return Response.json({ connection: { status: "connected", login: "octocat", installations: [ORG_A] } });
    }
    expect(body).toEqual({ flowId: "flow-2" });
    return Response.json({
      flowStatus: statusCalls === 2 ? "pending" : "connected",
      connection: {
        status: "connected",
        login: "octocat",
        installations: statusCalls === 2 ? [ORG_A] : [ORG_A, ORG_B],
      },
    });
  });
  expect(await h.run(["account", "add", "github"])).toBe(0);
  expect(h.opened).toEqual([INSTALL_URL]);
  expect(h.sleeps).toEqual([1000]);
  expect(h.output().out).toContain("Connected GitHub App installation: org-beta (selected repositories).");
  expect(h.output().out).toContain("org-alpha");
  expect(h.output().err).toContain("--no-wait");
});

test("account add github detects repository_selection updates and same-org flowId completion without hanging", async () => {
  let calls = 0;
  const updated = harness(async (input) => {
    if (new URL(String(input)).pathname === "/api/v1/github/install")
      return Response.json({ flowId: "flow-upd", authorizationUrl: INSTALL_URL });
    calls++;
    return Response.json({
      flowStatus: "pending",
      connection: {
        status: "connected",
        login: "octocat",
        installations: calls < 3 ? [ORG_A, ORG_B] : [ORG_A, { ...ORG_B, repository_selection: "all" }],
      },
    });
  });
  expect(await updated.run(["account", "add", "github", "--no-browser"])).toBe(0);
  expect(updated.sleeps).toEqual([1000]);
  expect(updated.output().out).toContain("Updated GitHub App installation: org-beta (all repositories).");

  let sameCalls = 0;
  const sameScope = harness(async (input) => {
    if (new URL(String(input)).pathname === "/api/v1/github/install")
      return Response.json({ flowId: "flow-same", authorizationUrl: INSTALL_URL });
    sameCalls++;
    return Response.json({
      flowStatus: sameCalls === 3 ? "connected" : "pending",
      connection: { status: "connected", login: "octocat", installations: [ORG_B] },
    });
  });
  expect(await sameScope.run(["account", "add", "github"])).toBe(0);
  expect(sameScope.sleeps).toEqual([1000]);
  expect(sameScope.output().out).toContain("GitHub App installation flow completed.");
  expect(sameScope.output().out).toContain("admin approval");
});

test("account add github avoids false positive after unavailable pre-check and supports --no-wait", async () => {
  let statusCalls = 0;
  const recovered = harness(async (input) => {
    if (new URL(String(input)).pathname === "/api/v1/github/install")
      return Response.json({ flowId: "flow-rec", authorizationUrl: INSTALL_URL });
    statusCalls++;
    if (statusCalls === 1) return Response.json({ connection: { status: "unavailable", installations: [] } });
    return Response.json({
      flowStatus: statusCalls === 3 ? "connected" : "pending",
      connection: { status: "connected", login: "octocat", installations: [ORG_A] },
    });
  });
  expect(await recovered.run(["account", "add", "github"])).toBe(0);
  expect(statusCalls).toBe(3);

  const calls: string[] = [];
  const noWait = harness(
    async (input) => {
      calls.push(new URL(String(input)).pathname);
      return Response.json({ flowId: "flow-nw", authorizationUrl: INSTALL_URL });
    },
    { throwOpen: true },
  );
  expect(await noWait.run(["account", "add", "github", "--no-wait"])).toBe(0);
  expect(calls).toEqual(["/api/v1/github/install"]);
  expect(noWait.output().err).toContain(INSTALL_URL);
  expect(noWait.output().out).toContain("not waiting for completion");
  expect(noWait.output().out).toContain("armada account ls github");

  const jsonH = harness(async () => Response.json({ flowId: "flow-nw", authorizationUrl: INSTALL_URL }));
  expect(await jsonH.run(["account", "add", "github", "--no-wait", "--no-browser", "--json"])).toBe(0);
  expect(jsonH.opened).toEqual([]);
  expect(JSON.parse(jsonH.output().out)).toEqual({
    status: "pending",
    waiting: false,
    authorizationUrl: INSTALL_URL,
    flowId: "flow-nw",
  });
});

test("account add github handles validation, timeout, flow failure, unconfigured server, and focused help", async () => {
  for (const argv of [
    ["account", "add", "github", "--no-wait", "--timeout", "10"],
    ["account", "add", "github", "--timeout", ""],
    ["account", "add", "github", "--timeout", "601"],
  ]) {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      return Response.json({});
    });
    expect(await h.run(argv)).toBe(2);
    expect(calls).toBe(0);
  }

  const timedOut = harness(async (input) =>
    new URL(String(input)).pathname === "/api/v1/github/install"
      ? Response.json({ flowId: "flow-to", authorizationUrl: INSTALL_URL })
      : Response.json({ flowStatus: "pending", connection: { status: "connected", installations: [ORG_A] } }),
  );
  expect(await timedOut.run(["account", "add", "github", "--timeout", "3", "--no-browser"])).toBe(1);
  expect(timedOut.elapsedMs()).toBe(3000);
  expect(timedOut.output().err).toContain("admin approval");
  expect(timedOut.output().err).toContain("--no-wait");

  const zero = harness(async (input) =>
    new URL(String(input)).pathname === "/api/v1/github/install"
      ? Response.json({ flowId: "flow-0", authorizationUrl: INSTALL_URL })
      : Response.json({ flowStatus: "pending", connection: { status: "connected", installations: [] } }),
  );
  expect(await zero.run(["account", "add", "github", "--timeout", "0", "--no-browser"])).toBe(1);
  expect(zero.sleeps).toEqual([]);

  const expired = harness(async (input) =>
    new URL(String(input)).pathname === "/api/v1/github/install"
      ? Response.json({ flowId: "flow-exp", authorizationUrl: INSTALL_URL })
      : Response.json({ flowStatus: "expired", connection: { status: "connected", installations: [] } }),
  );
  expect(await expired.run(["account", "add", "github", "--no-browser"])).toBe(1);
  expect(expired.output().err).toContain("retry armada account add github");

  const unconfigured = harness(async () =>
    Response.json(
      { error: { code: "dependency_unavailable", message: "GitHub App installation is not configured." } },
      { status: 503 },
    ),
  );
  expect(await unconfigured.run(["account", "add", "github", "--no-wait", "--json"])).toBe(1);
  expect(JSON.parse(unconfigured.output().err).error.code).toBe("dependency_unavailable");

  const unsafe = harness(async () => Response.json({ authorizationUrl: "http://evil.test/install" }));
  expect(await unsafe.run(["account", "add", "github", "--no-wait"])).toBe(1);
  expect(unsafe.output().err).toContain("unsafe authorization URL");

  const help = harness(async () => {
    throw new Error("Help must stay offline");
  });
  expect(await help.run(["account", "add", "github", "--no-wait", "--help"])).toBe(0);
  expect(help.output().out).toContain("--no-wait");
  expect(help.output().out).toContain("admin approval");
});
