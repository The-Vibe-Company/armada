import { expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import type { AuthIo } from "../src/auth-commands.ts";
import { completion, doctor, prepareLaunch } from "../src/devx.ts";
import { memorySessionStore } from "../src/session.ts";

function fixture(responses: Record<string, unknown>) {
  let out = "";
  const paths: string[] = [];
  const auth: AuthIo = {
    out: (text) => {
      out += text;
    },
    err: () => {},
    env: { ARMADA_TOKEN: "test-only" },
    session: memorySessionStore(),
    now: () => new Date(0),
    open: () => {},
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (!(path in responses)) throw new Error(`Unexpected API: ${path}`);
      const response = responses[path];
      return response instanceof Response
        ? Response.json(await response.json(), { status: response.status })
        : Response.json(response);
    },
  };
  return { auth, paths, output: () => out };
}

test.each([VERSION, "0.0.1", null])(
  "doctor reports session, server, GitHub and host version diagnostics (%s) in one table",
  async (hostVersion) => {
    const f = fixture({
      "/api/v1/account/status": { version: "0.0.1", orgs: [{ orgId: "org", name: "Team" }] },
      "/api/v1/docker/hosts/list": {
        placement: true,
        hosts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "desk",
            state: "online",
            lastSeenAt: null,
            version: hostVersion,
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
    expect(await doctor([], f.auth)).toBe(0);
    expect(f.output()).toContain("CHECK\tSTATUS\tDETAIL / NEXT STEP");
    expect(f.output()).toContain("npm i -g @the-vibe-company/armada");
    expect(f.output()).toContain(`online; daemon ${hostVersion ?? "unknown"}`);
    expect(f.output()).toContain(
      `Host desk\t${hostVersion === VERSION ? "ok" : hostVersion ? "warning" : "unknown"}\t`,
    );
    if (hostVersion && hostVersion !== VERSION)
      expect(f.output()).toContain("Check the host installation with armada host status on the host machine.");
    expect(f.output()).toContain("Account Work\tactive");
    expect(f.output()).toContain("GitHub\tok\tConnected as owner");
    expect(f.output()).toContain("The-Vibe-Company (selected repositories), owner (all repositories)");
    expect(f.output()).toContain("Per-repository access is checked at launch");
  },
);

test.each([
  [{ status: "not_connected", login: null }, "warning", "armada github connect"],
  [{ status: "not_connected", login: null, configured: false }, "unknown", "server operator"],
  [{ status: "needs_reconnect", login: "owner" }, "warning", "armada github reconnect"],
  [{ status: "connected", login: "owner", installations: [] }, "warning", "armada github install"],
  [{ status: "unavailable", login: null, configured: false }, "unknown", "server operator"],
  [{ status: "unavailable", login: "owner", configured: true }, "unknown", "Could not confirm GitHub access"],
] as const)(
  "doctor reports actionable GitHub state %j without claiming repository proof",
  async (connection, status, detail) => {
    const f = fixture({
      "/api/v1/account/status": { version: VERSION, orgs: [] },
      "/api/v1/github/status": { connection },
    });
    expect(await doctor(["--json"], f.auth)).toBe(0);
    expect(JSON.parse(f.output()).checks.find((row: { check: string }) => row.check === "GitHub")).toMatchObject({
      status,
      detail: expect.stringContaining(detail),
    });
  },
);

test("doctor reports personal-login GitHub requirement when a service bearer is refused", async () => {
  const f = fixture({
    "/api/v1/account/status": { version: VERSION, orgs: [] },
    "/api/v1/github/status": Response.json({ error: "forbidden" }, { status: 403 }),
  });
  expect(await doctor(["--json"], f.auth)).toBe(0);
  expect(f.output()).toContain("Unset ARMADA_TOKEN");
  expect(JSON.parse(f.output()).checks.find((row: { check: string }) => row.check === "GitHub")).toMatchObject({
    status: "unknown",
    detail: expect.stringContaining("sign in as a person with armada login (not a service token)"),
  });
});

test("doctor fails honestly when health and session cannot be confirmed", async () => {
  const f = fixture({});
  expect(await doctor(["--json"], f.auth)).toBe(1);
  expect(JSON.parse(f.output()).checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        check: "Session",
        status: "failed",
        detail: expect.stringContaining("Run armada login"),
      }),
      expect.objectContaining({ check: "Hosts", status: "unknown" }),
    ]),
  );
});

test.each(["bash", "zsh", "fish"])(
  "completion %s emits a sourceable shell registration without API access",
  (shell) => {
    const f = fixture({});
    expect(completion([shell], f.auth)).toBe(0);
    expect(f.output()).toContain("armada");
    expect(f.output()).toContain("launch");
    expect(f.paths).toEqual([]);
  },
);

test("guided launch fills missing choices from visible API catalogs and persists nonsecret selections", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const f = fixture({
    "/api/v1/org/list": { orgs: [{ id: org, name: "Team" }] },
    "/api/v1/launch/options": {
      providers: [{ id: "modal", enabled: true, capabilities: { launch: true }, harnesses: ["codex"] }],
      harnesses: [{ id: "codex", credentialKinds: ["openai"] }],
    },
    "/api/v1/golden/list": { goldens: [{ name: "app", provider: "modal" }] },
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
  expect(
    await prepareLaunch(["app", "--agent", "codex", "--credential-id", "account", "--org", "org"], f.auth),
  ).toEqual(["app", "--agent", "codex", "--credential-id", "account", "--org", "org"]);
  expect(f.paths).toEqual([]);
});

test("guided Docker launch respects explicit organization and remembered visible host without asking for an image", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const first = "22222222-2222-4222-8222-222222222222";
  const selected = "33333333-3333-4333-8333-333333333333";
  const f = fixture({
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
        sandboxes: 0,
      })),
    },
    "/api/v1/creds/list": { user: [{ id: "account", kind: "openai", status: "active" }], orgs: [] },
  });
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
  expect(await prepareLaunch(["--org", org], f.auth)).toEqual([
    "--org",
    org,
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
  expect(f.paths).not.toContain("/api/v1/org/list");
  expect(f.paths).not.toContain("/api/v1/golden/list");
});
