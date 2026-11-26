import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

async function capture(argv: string[], failure?: number) {
  let out = "",
    err = "";
  const session = memorySessionStore();
  const code = await run(
    argv,
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    {
      auth: {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
        session,
        env: failure ? { ARMADA_TOKEN: "fixture_token" } : {},
        now: () => new Date("2026-11-16T00:00:00Z"),
        open: () => {},
        preferences: { read: async () => undefined, write: async () => {} },
        fetch: async () =>
          Response.json(
            { error: { code: failure === 401 ? "unauthorized" : "unavailable", message: "fixture failure" } },
            { status: failure ?? 500 },
          ),
      },
    },
  );
  return { code, out, err };
}

test("JSON logout emits only its stable success object", async () => {
  const result = await capture(["logout", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ authenticated: false });
});

test("automaticJson emits valid JSON when piped on whoami, org, host, template, account, and logout", async () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const cases: readonly [string[], Record<string, unknown>][] = [
    [["whoami"], { "/api/v1/token/whoami": { auth: "login", userId: "u1" } }],
    [["org", "list"], { "/api/v1/org/list": { orgs: [{ id: orgId, name: "team", role: "member" }] } }],
    [["host", "ls", "--org", orgId], { "/api/v1/docker/hosts/list": { placement: true, hosts: [] } }],
    [["template", "list", "--org", orgId], { "/api/v1/templates/list": { items: [] } }],
    [["account", "ls"], { "/api/v1/creds/list": { user: [], orgs: [] } }],
    [["logout"], {}],
  ];
  for (const [argv, responses] of cases) {
    let out = "",
      err = "";
    const code = await run(
      argv,
      { out: (t) => (out += t), err: (t) => (err += t) },
      {
        stdoutIsTTY: false,
        auth: {
          out: (t) => (out += t),
          err: (t) => (err += t),
          session: memorySessionStore(),
          env: { ARMADA_TOKEN: "fixture_token" },
          now: () => new Date(0),
          open: () => {},
          fetch: async (input) => Response.json(responses[new URL(String(input)).pathname] ?? {}),
        },
      },
    );
    expect([argv, code, err]).toEqual([argv, 0, ""]);
    expect(() => JSON.parse(out)).not.toThrow();
  }
});

test("human and JSON diagnostics distinguish authentication, server and usage exits", async () => {
  for (const json of [false, true]) {
    for (const [argv, failure, code] of [
      [["ls"], undefined, 3],
      [["ls"], 401, 3],
      [["template", "list", "--org", "11111111-1111-4111-8111-111111111111"], 401, 3],
      [["ls"], 503, 1],
      [["stop", "sandbox", "--ttl", "4h"], undefined, 2],
    ] as const) {
      const result = await capture([...argv, ...(json ? ["--json"] : [])], failure);
      expect(result.code).toBe(code);
      expect(result.out).toBe("");
      if (json) expect(JSON.parse(result.err).error.code).toBeString();
    }
  }
});
