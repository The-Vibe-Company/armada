import { expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import type { AuthIo } from "../src/auth-commands.ts";
import { completion } from "../src/command-catalog.ts";
import { prepareLaunch } from "../src/devx.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

function fixture(responses: Record<string, unknown>) {
  let out = "";
  let err = "";
  const paths: string[] = [];
  let hostOrg: string | undefined;
  const auth: AuthIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    env: { ARMADA_TOKEN: "test-only" },
    session: memorySessionStore(),
    now: () => new Date(0),
    open: () => {},
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/api/v1/docker/hosts/list" && hostOrg) {
        expect(JSON.parse(String(init?.body))).toEqual({ org: hostOrg });
      }
      if (!(path in responses)) throw new Error(`Unexpected API: ${path}`);
      const response = responses[path];
      return response instanceof Response
        ? Response.json(await response.json(), { status: response.status })
        : Response.json(response);
    },
  };
  return {
    auth,
    paths,
    errors: () => err,
    run: (argv: string[], options?: Parameters<typeof run>[2]) => run(argv, auth, { auth, ...options }),
    output: () => out,
    expectHostOrg: (org: string) => {
      hostOrg = org;
    },
  };
}

test.each([VERSION, "0.0.1", null])(
  "setup status reports session, server, GitHub and host version diagnostics (%s) in one table",
  async (hostVersion) => {
    const f = fixture({
      "/api/v1/account/status": {
        userId: "user",
        authentication: "service",
        version: "99.0.0",
        orgs: [{ orgId: "org", role: "member" }],
      },
      "/api/v1/docker/hosts/list": {
        placement: true,
        hosts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "desk",
            state: "online",
            lastSeenAt: null,
            version: hostVersion,
            protocol: 1,
            upgradeRequired: false,
            sandboxes: 0,
          },
        ],
      },
      "/api/v1/creds/list": { user: [{ id: "model", name: "Work", kind: "openai", status: "active" }], orgs: [] },
      "/api/v1/github/status": {
        connection: {
          status: "connected",
          login: "owner",
          installations: [
            { account: "The-Vibe-Company", repository_selection: "selected" },
            { account: "owner", repository_selection: "all" },
          ],
        },
      },
    });
    expect(await f.run(["info"])).toBe(0);
    expect(f.output()).toMatch(/CHECK\s+STATUS\s+DETAIL \/ NEXT STEP/);
    expect(f.output()).toMatch(/Session\s+ok\s+Signed in as user \(service\)/);
    expect(f.output()).toMatch(/Organization\s+ok\s+org/);
    expect(f.output()).toContain("npm i -g @the-vibe-company/armada@99.0.0");
    expect(f.output()).toContain(`online; daemon ${hostVersion ?? "unknown"}`);
    expect(f.output()).toMatch(
      new RegExp(`Host desk\\s+${hostVersion === VERSION ? "ok" : hostVersion ? "warning" : "unknown"}\\s+`),
    );
    if (hostVersion && hostVersion !== VERSION)
      expect(f.output()).toContain("On the host machine, check the status of the daemon instance for this server.");
    expect(f.output()).toMatch(/Account Work\s+active/);
    expect(f.output()).toMatch(/GitHub\s+ok\s+Connected as owner/);
    expect(f.output()).toContain("The-Vibe-Company (selected repositories), owner (all repositories)");
    expect(f.output()).toContain("Per-repository access is checked at launch");
  },
);

test("setup status names the uninstall for a draining host instead of telling the user to inspect the machine", async () => {
  const f = fixture({
    "/api/v1/account/status": {
      userId: "user",
      authentication: "service",
      version: VERSION,
      orgs: [{ orgId: "org", role: "member" }],
    },
    "/api/v1/docker/hosts/list": {
      placement: true,
      hosts: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "desk",
          state: "draining",
          lastSeenAt: null,
          version: VERSION,
          protocol: 1,
          upgradeRequired: false,
          sandboxes: 0,
        },
      ],
    },
    "/api/v1/creds/list": { user: [{ id: "model", name: "Work", kind: "openai", status: "active" }], orgs: [] },
    "/api/v1/github/status": { connection: { status: "not_connected", login: null } },
  });
  expect(await f.run(["info", "--json"])).toBe(0);
  const host = JSON.parse(f.output()).checks.find((row: { check: string }) => row.check === "Host desk");
  expect(host.detail).toContain("draining for uninstall");
  expect(host.detail).not.toContain("Check the host machine");
});

test.each([
  [{ status: "not_connected", login: null }, "warning", "armada account login github"],
  [{ status: "not_connected", login: null, configured: false }, "unknown", "server operator"],
  [{ status: "needs_reconnect", login: "owner" }, "warning", "armada account login github"],
  [{ status: "connected", login: "owner", installations: [] }, "warning", "armada account add github"],
  [{ status: "unavailable", login: null, configured: false }, "unknown", "server operator"],
  [{ status: "unavailable", login: "owner", configured: true }, "unknown", "Could not confirm GitHub access"],
] as const)(
  "setup status reports actionable GitHub state %j without claiming repository proof",
  async (connection, status, detail) => {
    const f = fixture({
      "/api/v1/account/status": { userId: "user", authentication: "service", version: VERSION, orgs: [] },
      "/api/v1/github/status": { connection },
    });
    expect(await f.run(["info", "--json"])).toBe(0);
    expect(JSON.parse(f.output()).checks.find((row: { check: string }) => row.check === "GitHub")).toMatchObject({
      status,
      detail: expect.stringContaining(detail),
    });
  },
);

test("setup status reports personal-login GitHub requirement when a service bearer is refused", async () => {
  const f = fixture({
    "/api/v1/account/status": { userId: "user", authentication: "service", version: VERSION, orgs: [] },
    "/api/v1/github/status": Response.json({ error: "forbidden" }, { status: 403 }),
  });
  expect(await f.run(["info", "--json"])).toBe(0);
  expect(f.output()).toContain("unset ARMADA_TOKEN");
  expect(JSON.parse(f.output()).checks.find((row: { check: string }) => row.check === "GitHub")).toMatchObject({
    status: "unknown",
    detail: expect.stringContaining("run armada login as a person"),
  });
});

test.each([true, false])("setup status diagnoses failed session for token mode %s", async (token) => {
  const f = fixture({});
  if (!token) f.auth.env = {};
  expect(await f.run(["info", "--json"])).toBe(1);
  expect(f.errors()).toBe("");
  expect(JSON.parse(f.output()).checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        check: "Session",
        status: "failed",
        detail: expect.stringContaining(token ? "Check or replace ARMADA_TOKEN" : "Run armada login"),
      }),
      expect.objectContaining({ check: "Hosts", status: "unknown" }),
    ]),
  );
});

test("info --setup skips the current sandbox and uses an explicit organization", async () => {
  const f = fixture({
    "/api/v1/account/status": {
      userId: "user",
      authentication: "service",
      version: VERSION,
      orgs: [{ orgId: "explicit", role: "member" }],
    },
    "/api/v1/github/status": { connection: { status: "not_connected", login: null } },
    "/api/v1/docker/hosts/list": { placement: true, hosts: [] },
    "/api/v1/creds/list": { user: [{ id: "model", kind: "openai" }], orgs: [] },
  });
  f.auth.env.ARMADA_SANDBOX = "11111111-1111-4111-8111-111111111111";
  f.auth.preferences = { read: async () => "saved", write: async () => {} };
  f.expectHostOrg("explicit");

  expect(await f.run(["info", "--setup", "--org", "explicit"], { stdoutIsTTY: false })).toBe(0);
  expect(JSON.parse(f.output()).checks).toContainEqual({ check: "Organization", status: "ok", detail: "explicit" });
  expect(f.paths).toContain("/api/v1/docker/hosts/list");
  expect(f.paths).not.toContain("/api/v1/sandbox/status");
});

test("doctor is an unknown command and performs no API calls", async () => {
  const f = fixture({});
  expect(await f.run(["doctor"])).toBe(2);
  expect(f.errors()).toContain("unknown command 'doctor'");
  expect(f.paths).toEqual([]);
});

test.each(["bash", "zsh", "fish"])(
  "completion %s emits a command- and subcommand-scoped shell registration without API access",
  (shell) => {
    const f = fixture({});
    expect(completion([shell], f.auth)).toBe(0);
    expect(f.output()).toContain("armada");
    expect(f.output()).toMatch(/\bnew\b/);
    expect(f.output()).toContain("keep-after-merge");
    expect(f.output()).not.toContain("complete -W ");
    if (shell === "fish") {
      expect(f.output()).toContain("__fish_seen_subcommand_from org");
      expect(f.output()).toContain("-a 'list use setup connect'");
      expect(f.output()).toContain("-r -l 'profile'");
      expect(f.output()).toMatch(
        /__fish_seen_subcommand_from ls; and not __fish_seen_subcommand_from [^']*host[^']*' -l 'wide'/,
      );
    } else {
      expect(f.output()).toContain('"org:use")');
      expect(f.output()).toContain('"ls:"*)');
      expect(f.output()).not.toContain("--short");
    }
    expect(f.paths).toEqual([]);
  },
);

test.each([
  [VERSION, "ok", ""],
  ["0.0.1", "info", "is ahead of server 0.0.1"],
  ["99.0.0", "warning", "npm i -g @the-vibe-company/armada@99.0.0"],
] as const)("info --setup compares semver for server %s", async (serverVersion, expectedStatus, expectedDetail) => {
  const f = fixture({
    "/api/v1/account/status": { userId: "user", authentication: "service", version: serverVersion, orgs: [] },
    "/api/v1/github/status": { connection: { status: "not_connected", login: null } },
    "/api/v1/creds/list": { user: [{ id: "model", kind: "openai" }], orgs: [] },
  });
  expect(await f.run(["info", "--setup", "--json"])).toBe(0);
  const server = JSON.parse(f.output()).checks.find((row: { check: string }) => row.check === "Server");
  expect(server.status).toBe(expectedStatus);
  if (expectedDetail) expect(server.detail).toContain(expectedDetail);
  if (expectedStatus === "info") expect(server.detail).not.toContain("npm i -g");
});

test("guided launch fills missing choices from visible API catalogs and persists nonsecret selections", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const f = fixture({
    "/api/v1/org/list": { orgs: [{ id: org, name: "Team", role: "admin" }] },
    "/api/v1/launch/options": {
      providers: [{ id: "modal", enabled: true, capabilities: { launch: true }, harnesses: ["codex"] }],
      harnesses: [{ id: "codex", credentialKinds: ["openai"] }],
    },
    "/api/v1/golden/list": { goldens: [{ name: "app", provider: "modal", config: { repos: [], init: [] } }] },
    "/api/v1/creds/list": { user: [{ id: "account", kind: "openai", name: "Work", status: "active" }], orgs: [] },
  });
  const remembered = new Map<string, string>();
  f.auth.interactive = true;
  f.auth.chooseLaunch = async () => {
    throw Error("Only one choice; no question needed");
  };
  f.auth.launchPreferences = {
    read: async (key) => remembered.get(key),
    write: async (key, value) => {
      if (value) remembered.set(key, value);
    },
  };
  expect(await prepareLaunch([], f.auth)).toEqual([
    "app",
    "--org",
    org,
    "--provider",
    "modal",
    "--agent",
    "codex",
    "--credential-id",
    "account",
  ]);
  expect(remembered.size).toBe(5);
});

test("noninteractive, JSON and fully specified launches never perform interactive discovery", async () => {
  const f = fixture({});
  expect(await prepareLaunch([], f.auth)).toEqual([]);
  f.auth.interactive = true;
  f.auth.chooseLaunch = async () => {
    throw Error("Must not prompt");
  };
  expect(await prepareLaunch(["--json"], f.auth)).toEqual(["--json"]);
  for (const explicit of [
    ["app", "--provider", "boat", "--agent", "codex", "--credential-id", "account", "--org", "org"],
    ["app", "--provider", "modal", "--agent", "codex"],
    ["--provider", "docker", "--host", "workstation", "--agent", "codex"],
  ]) {
    expect(await prepareLaunch(explicit, f.auth)).toEqual(explicit);
  }
  expect(f.paths).toEqual([]);
});

test("guided Docker launch respects explicit organization and remembered visible host without asking for an image", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const first = "22222222-2222-4222-8222-222222222222";
  const selected = "33333333-3333-4333-8333-333333333333";
  const f = fixture({
    "/api/v1/org/list": { orgs: [{ id: org, name: "Team", role: "admin" }] },
    "/api/v1/launch/options": {
      providers: [{ id: "docker", enabled: true, capabilities: { launch: true }, harnesses: ["codex"] }],
      harnesses: [{ id: "codex", credentialKinds: ["openai"] }],
    },
    "/api/v1/docker/hosts/list": {
      placement: true,
      hosts: [first, selected].map((id, i) => ({
        id,
        name: `host-${i}`,
        state: "online",
        lastSeenAt: null,
        protocol: 1,
        upgradeRequired: false,
        sandboxes: 0,
      })),
    },
    "/api/v1/creds/list": { user: [{ id: "account", kind: "openai", status: "active" }], orgs: [] },
  });
  f.expectHostOrg(org);
  f.auth.interactive = true;
  f.auth.launchPreferences = {
    read: async (key) => (key.endsWith("/host") ? selected : undefined),
    write: async () => {},
  };
  let questions = 0;
  f.auth.chooseLaunch = async (title, choices, preferred) => {
    questions++;
    expect(title).toContain("Host");
    expect(choices.map((c) => c.value)).toEqual([first, selected]);
    expect(preferred).toBe(selected);
    return preferred ?? "";
  };
  expect(await prepareLaunch(["--org", "team"], f.auth)).toEqual([
    "--org",
    "team",
    "--provider",
    "docker",
    "--agent",
    "codex",
    "--host",
    selected,
    "--credential-id",
    "account",
  ]);
  expect(questions).toBe(1);
  expect(f.paths).toContain("/api/v1/org/list");
  expect(f.paths).not.toContain("/api/v1/golden/list");
});
