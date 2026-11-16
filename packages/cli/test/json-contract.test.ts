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

test("JSON clearing and logout emit only their stable success objects", async () => {
  for (const [argv, expected] of [
    [["org", "use", "none", "--json"], { org: null }],
    [["logout", "--json"], { authenticated: false }],
  ] as const) {
    const result = await capture([...argv]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(expected);
  }
});

test("human and JSON diagnostics distinguish authentication, server and usage exits", async () => {
  for (const json of [false, true]) {
    for (const [argv, failure, code] of [
      [["list"], undefined, 3],
      [["list"], 401, 3],
      [["template", "list", "--org", "11111111-1111-4111-8111-111111111111"], 401, 3],
      [["list"], 503, 1],
      [["stop", "sandbox", "--ttl", "4h"], undefined, 2],
    ] as const) {
      const result = await capture([...argv, ...(json ? ["--json"] : [])], failure);
      expect(result.code).toBe(code);
      expect(result.out).toBe("");
      if (json) expect(JSON.parse(result.err).error.code).toBeString();
    }
  }
});
