import { expect, test } from "bun:test";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const origin = "https://armada.example";
const expiresAt = "2099-04-01T00:00:00.000Z";

function fixture(fetch: AuthIo["fetch"], env: AuthIo["env"] = {}) {
  const auth: AuthIo = {
    env,
    fetch,
    now: () => new Date("2026-11-20T00:00:00Z"),
    open: () => {},
    out: () => {},
    err: () => {},
    preferences: { read: async () => "11111111-1111-4111-8111-111111111111", write: async () => {} },
    session: memorySessionStore({
      accessToken: "saved-login",
      refreshToken: "refresh",
      armadaUrl: origin,
      expiresAt,
    }),
  };
  return async (argv: string[]) => {
    let out = "";
    let err = "";
    const io = {
      out: (text: string) => {
        out += text;
      },
      err: (text: string) => {
        err += text;
      },
    };
    const code = await run(argv, io, { auth: { ...auth, ...io } });
    return { code, out, err };
  };
}

test("whoami uses ARMADA_TOKEN in preference to a saved login", async () => {
  const identity = { userId: "user", auth: "key", key: { name: "worker", expiresAt } };
  const cli = fixture(
    async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      expect(request.url).toBe(`${origin}/api/v1/token/whoami`);
      expect(request.headers.get("authorization")).toBe("Bearer key-fixture");
      return Response.json(identity);
    },
    { ARMADA_URL: origin, ARMADA_TOKEN: "key-fixture" },
  );
  const result = await cli(["whoami", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual(identity);
});

test("whoami works with a saved login and organization", async () => {
  const cli = fixture(async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    expect(request.url).toBe(`${origin}/api/v1/token/whoami`);
    expect(request.headers.get("authorization")).toBe("Bearer saved-login");
    return Response.json({ userId: "user", auth: "login" });
  });

  expect(await cli(["whoami"])).toEqual({ code: 0, out: "user (saved login)\n", err: "" });
});

test("whoami wraps malformed server responses into a typed exit-1 error", async () => {
  const cli = fixture(async () => Response.json({ unexpected: true }));
  const result = await cli(["whoami", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.err).error).toMatchObject({
    code: "unavailable",
    message: expect.stringContaining("invalid whoami"),
  });
});
