import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthIo } from "../src/auth-commands.ts";
import { filePreferences } from "../src/preferences.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

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

test("org use persists a validated UUID per server and scopes commands while explicit org wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-selection-"));
  try {
    const bodies: unknown[] = [];
    const h = harness(async (input, init) => {
      const request = new Request(String(input), init);
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
    expect(await h.run(["org", "use", "Team"])).toBe(0);
    h.auth.preferences = filePreferences(path); // a new CLI process re-opens the preference file
    expect(await h.run(["list"])).toBe(0);
    expect(bodies.at(-1)).toEqual({ org });
    expect(await h.run(["list", "--org", "override"])).toBe(0);
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
    expect(await h.run(["org", "use", "outsider"])).toBe(2);
    expect(await h.auth.preferences.read("https://armada.test")).toBe(org);
    expect(await h.run(["org", "use", "none"])).toBe(0);
    expect(await h.auth.preferences.read("https://armada.test")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP connect opens once and polls authenticated canonical status until actually connected", async () => {
  let polls = 0;
  const requests: { path: string; body: unknown }[] = [];
  const h = harness(async (input, init) => {
    const request = new Request(String(input), init);
    expect(request.headers.get("authorization")).toBe("Bearer test-bearer");
    const path = new URL(request.url).pathname;
    requests.push({ path, body: await request.json() });
    if (path.endsWith("connect"))
      return Response.json({
        connection: { id: "connection", status: "not_connected" },
        authorizationUrl: "https://issuer.test/authorize?state=opaque",
      });
    return Response.json({ connection: { id: "connection", status: ++polls === 2 ? "connected" : "not_connected" } });
  });
  expect(await h.run(["mcp", "connect", "connection", "--org", org])).toBe(0);
  expect(h.opened).toHaveLength(1);
  expect(polls).toBe(2);
  expect(requests.map((r) => r.path)).toEqual(["/api/v1/mcp/connect", "/api/v1/mcp/status", "/api/v1/mcp/status"]);
  expect(requests.every((r) => JSON.stringify(r.body) === JSON.stringify({ org, id: "connection" }))).toBe(true);
  expect(JSON.parse(h.output().out).connection.status).toBe("connected");
});

test("MCP no-browser timeout never prints connected and enable/disable uses set-enabled", async () => {
  const bodies: unknown[] = [];
  const h = harness(async (input, init) => {
    const request = new Request(String(input), init);
    bodies.push(await request.json());
    if (request.url.endsWith("set-enabled")) return Response.json({ ok: true });
    return Response.json({
      connection: { id: "connection", status: "not_connected" },
      authorizationUrl: "https://issuer.test/authorize",
    });
  });
  expect(await h.run(["mcp", "connect", "connection", "--org", org, "--no-browser", "--timeout", "0"])).toBe(1);
  expect(h.opened).toEqual([]);
  expect(h.output().out).toBe("");
  expect(h.output().err).toContain("https://issuer.test/authorize");
  expect(await h.run(["mcp", "disable", "connection", "--org", org])).toBe(0);
  expect(bodies.at(-1)).toEqual({ org, id: "connection", enabled: false });
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
  expect(await h.run(["github", "connect"])).toBe(0);
  expect(h.opened).toHaveLength(1);
  expect(polls).toBe(2);
});

test("MCP reconnect revokes through the backend before starting a new authorization", async () => {
  const paths: string[] = [];
  const h = harness(async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("revoke")) return Response.json({ ok: true });
    if (path.endsWith("connect")) return Response.json({ connection: { id: "connection", status: "connected" } });
    return Response.json({ connection: { id: "connection", status: "connected" } });
  });
  expect(await h.run(["mcp", "reconnect", "connection", "--org", org])).toBe(0);
  expect(paths).toEqual(["/api/v1/mcp/revoke", "/api/v1/mcp/connect", "/api/v1/mcp/status"]);
  expect(h.opened).toEqual([]);
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
        ["creds", "set", kind ?? "", "--file", "credential-input.json", "--json"],
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
