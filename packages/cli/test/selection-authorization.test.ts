import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError } from "@armada/auth";
import type { AuthIo } from "../src/auth-commands.ts";
import { filePreferences } from "../src/preferences.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

import { loginAuthorized, loginStarted } from "./device-login.fixture.ts";

const org = "11111111-1111-4111-8111-111111111111";
function harness(fetch: AuthIo["fetch"]) {
  let out = "";
  let err = "";
  let time = 0;
  const opened: string[] = [];
  const auth: AuthIo = {
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "test-bearer" },
    fetch,
    session: memorySessionStore(),
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    now: () => new Date(time),
    sleep: async (ms) => {
      time += ms;
    },
    open: (url) => {
      opened.push(url);
    },
  };
  return {
    auth,
    opened,
    output: () => ({ out, err }),
    run: (args: string[]) => run(args, { out: auth.out, err: auth.err }, { auth }),
  };
}

test("login --org persists a validated UUID per server and scopes commands while explicit org wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-selection-"));
  try {
    const bodies: unknown[] = [];
    const h = harness(async (input, init) => {
      const request = new Request(String(input), init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/auth/device/start")) return loginStarted();
      if (path.endsWith("/auth/device/poll")) return loginAuthorized();
      if (path.endsWith("/org/list")) expect(request.headers.get("authorization")).toBe("Bearer new-access");
      bodies.push(await request.json());
      return Response.json(
        new URL(request.url).pathname === "/api/v1/org/list"
          ? { orgs: [{ id: org, name: "Team", role: "admin" }] }
          : new URL(request.url).pathname.startsWith("/api/v1/org/provider/")
            ? { org: { id: org, name: "Team", role: "admin" }, ready: false, providers: [] }
            : { sandboxes: [] },
      );
    });
    const path = join(directory, "preferences.json");
    h.auth.preferences = filePreferences(path);
    expect(await h.run(["login", "--org", "Team"])).toBe(0);
    h.auth.preferences = filePreferences(path);
    expect(await h.run(["ls"])).toBe(0);
    expect(bodies.at(-1)).toEqual({ org });
    expect(await h.run(["ls", "--org", "override"])).toBe(0);
    expect(bodies.at(-1)).toEqual({ org: "override" });
    expect(await h.run(["org", "setup"])).toBe(0);
    expect(bodies.at(-1)).toEqual({ org });
    expect(
      await run(
        ["org", "connect", "boat"],
        { out: h.auth.out, err: h.auth.err },
        { auth: h.auth, readStdin: async () => "selection-test-value" },
      ),
    ).toBe(0);
    expect(bodies.at(-1)).toEqual({ org, provider: "boat", value: "selection-test-value" });
    expect(await h.run(["org", "setup", "--org", "override"])).toBe(0);
    expect(bodies.at(-1)).toEqual({ org: "override" });
    expect(await h.auth.preferences.read("https://another.test")).toBeUndefined();
    expect(await h.run(["login", "--org", "outsider"])).toBe(2);
    expect(await h.auth.preferences.read("https://armada.test")).toBe(org);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("login --org none clears the selected organization after authorization", async () => {
  const h = harness(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/device/start")) return loginStarted();
    if (path.endsWith("/auth/device/poll")) return loginAuthorized();
    throw new Error("Unexpected request");
  });
  let selected: string | undefined = org;
  h.auth.preferences = {
    read: async () => selected,
    write: async (origin, value) => {
      expect(origin).toBe("https://armada.test");
      selected = value;
    },
  };
  expect(await h.run(["login", "--org", "none", "--json"])).toBe(0);
  expect(selected).toBeUndefined();
  expect(h.output().out.trim().split("\n").at(-1)).toBe('{"authenticated":true}');
});

test("a failed login organization write preserves the previous identity", async () => {
  const h = harness(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/device/start")) return loginStarted();
    if (path.endsWith("/auth/device/poll")) return loginAuthorized();
    throw new Error("Unexpected request");
  });
  const previous = {
    armadaUrl: "https://armada.test",
    accessToken: "previous-access",
    refreshToken: "previous-refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  await h.auth.session.write(previous);
  h.auth.preferences = {
    read: async () => org,
    write: async () => {
      throw new AuthError("Could not save organization preferences.", "unavailable");
    },
  };

  expect(await h.run(["login", "--org", "none"])).toBe(1);
  expect(await h.auth.session.read()).toEqual(previous);
  expect(h.output().err).toContain("Could not save organization preferences.");
});

test("org current is rejected before an API request", async () => {
  const h = harness(async () => {
    throw new Error("Unexpected request");
  });
  expect(await h.run(["org", "current"])).toBe(2);
  expect(h.output().err).toContain("unknown command 'org current'. Run 'armada --help'.");
});

test("org use saves or clears the default organization using the existing session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-org-use-"));
  try {
    const paths: string[] = [];
    const h = harness(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Response.json({ orgs: [{ id: org, name: "Team", role: "admin" }] });
    });
    h.auth.preferences = filePreferences(join(directory, "preferences.json"));
    expect(await h.run(["org", "use", "team"])).toBe(0);
    expect(paths).toEqual(["/api/v1/org/list"]);
    expect(await h.auth.preferences.read("https://armada.test")).toBe(org);
    expect(h.output().out).toContain(`Default organization set to Team (${org}).`);

    expect(await h.run(["org", "use", "none", "--json"])).toBe(0);
    expect(await h.auth.preferences.read("https://armada.test")).toBeUndefined();
    expect(JSON.parse(h.output().out.trim().split("\n").at(-1)!)).toEqual({ org: null });

    expect(await h.run(["org", "use", "unknown"])).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("login auto-saves default org when the user belongs to exactly one org and skips when multiple", async () => {
  const secondOrg = "22222222-2222-4222-8222-222222222222";
  for (const orgs of [
    [{ id: org, name: "Solo", role: "admin" }],
    [
      { id: org, name: "One", role: "admin" },
      { id: secondOrg, name: "Two", role: "member" },
    ],
  ]) {
    let saved: string | undefined;
    const h = harness(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/auth/device/start")) return loginStarted();
      if (path.endsWith("/auth/device/poll")) return loginAuthorized();
      if (path.endsWith("/org/list")) return Response.json({ orgs });
      throw new Error(`Unexpected ${path}`);
    });
    h.auth.preferences = {
      read: async () => saved,
      write: async (_origin, value) => {
        saved = value;
      },
    };
    expect(await h.run(["login"])).toBe(0);
    expect(saved).toBe(orgs.length === 1 ? org : undefined);
  }
});

test("GitHub connect waits for its own completed authorization, not a pre-existing connected account", async () => {
  let polls = 0;
  const h = harness(async (input, init) => {
    const request = new Request(String(input), init);
    if (request.url.endsWith("connect"))
      return Response.json({
        flowId: "flow",
        authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
      });
    expect(await request.json()).toEqual({ flowId: "flow" });
    return Response.json({
      flowStatus: ++polls === 2 ? "connected" : "pending",
      connection: { status: "connected", installations: [] },
    });
  });
  expect(await h.run(["account", "login", "github"])).toBe(0);
  expect(h.opened).toHaveLength(1);
  expect(polls).toBe(2);
});

test.each([
  ["ls", "status", { connection: { status: "connected", installations: [] } }],
  ["rm", "disconnect", { ok: true }],
] as const)("account %s github returns the GitHub response", async (verb, route, response) => {
  const h = harness(async (input, init) => {
    const request = new Request(String(input), init);
    expect(new URL(request.url).pathname).toBe(`/api/v1/github/${route}`);
    expect(await request.json()).toEqual({});
    return Response.json(response);
  });
  expect(await h.run(["account", verb, "github", "--json"])).toBe(0);
  expect(JSON.parse(h.output().out)).toEqual(response);
});

test("account add github waits for a new installation", async () => {
  const previous = { id: 1, account: "old", account_type: "User" };
  let checked = 0;
  const h = harness(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/github/install") {
      expect(checked).toBe(1);
      return Response.json({ authorizationUrl: "https://github.com/apps/armada/installations/new" });
    }
    expect(path).toBe("/api/v1/github/status");
    checked++;
    const installations = checked < 3 ? [previous] : [previous, { ...previous, id: 2 }];
    return Response.json({ connection: { status: "connected", installations } });
  });
  expect(await h.run(["account", "add", "github", "--no-browser", "--json"])).toBe(0);
  expect(h.opened).toEqual([]);
  expect(h.output().err).toContain("https://github.com/apps/armada/installations/new");
  expect(JSON.parse(h.output().out).connection.installations).toHaveLength(2);
});

test("structured Modal and Codex credentials accept file whitespace and stay write-only", async () => {
  for (const [kind, content] of [
    ["modal", '{\n "token_id": "ak-testtoken01",\n "token_secret": "as-testsecret01"\n}'],
    ["codex-auth", '{\n "tokens": { "access_token": "test-only-value" }\n}'],
  ]) {
    let body: Record<string, unknown> = {};
    const h = harness(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ ok: true });
    });
    expect(
      await run(
        ["account", "add", kind ?? "", "--file", "credential-input.json", "--json"],
        { out: h.auth.out, err: h.auth.err },
        { auth: h.auth, readFile: async () => content ?? "" },
      ),
    ).toBe(0);
    expect(body.kind).toBe(kind);
    expect(typeof body.value).toBe("string");
    expect(h.output().out).toBe('{"ok":true}\n');
    expect(h.output().err).toBe("");
  }
});

test.each([
  ["default", "default"],
  ["rm", "remove"],
] as const)("account %s sends the selected account ID and scope", async (verb, action) => {
  const response = { ok: true };
  const h = harness(async (input, init) => {
    const request = new Request(String(input), init);
    expect(new URL(request.url).pathname).toBe(`/api/v1/creds/accounts/${action}`);
    expect(await request.json()).toEqual({ scope: "org", org, id: "account-id" });
    return Response.json(response);
  });
  expect(await h.run(["account", verb, "account-id", "--org", org])).toBe(0);
  expect(JSON.parse(h.output().out)).toEqual(response);
});

test("account login codex requires a name before starting native device authorization", async () => {
  const h = harness(async () => {
    throw new Error("A missing name must fail locally");
  });
  expect(await h.run(["account", "login", "codex"])).toBe(2);
  expect(h.output().err).toContain("Creating an account requires --name.");
});

test("account ls uses the selected organization with flags before or after the verb", async () => {
  const h = harness(async (input, init) => {
    const request = new Request(String(input), init);
    expect(new URL(request.url).pathname).toBe("/api/v1/creds/list");
    expect(await request.json()).toEqual({ org });
    return Response.json({ user: [], orgs: [] });
  });
  h.auth.preferences = { read: async () => org, write: async () => {} };
  expect(await h.run(["account", "ls", "--json"])).toBe(0);
  expect(await h.run(["account", "--json", "ls"])).toBe(0);
});
