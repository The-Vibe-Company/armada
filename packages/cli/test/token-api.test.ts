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

test("token create, ls and revoke use the saved login and only creation prints the key", async () => {
  const token = "one-time-fixture";
  const summary = { id: "key-id", label: "worker", orgName: "Team", expiresAt };
  const cli = fixture(async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    expect(request.headers.get("authorization")).toBe("Bearer saved-login");
    switch (new URL(request.url).pathname) {
      case "/api/v1/token/create":
        expect(await request.json()).toEqual({ org: "Team", label: "worker", expires: "90d" });
        return Response.json({ ...summary, token });
      case "/api/v1/token/list":
        return Response.json({ tokens: [{ ...summary, lastUsedAt: null, revokedAt: null, createdAt: "2099-01-01" }] });
      case "/api/v1/token/revoke":
        expect(await request.json()).toEqual({ id: "key-id" });
        return Response.json({ ok: true });
      default:
        throw new Error("Unexpected token request");
    }
  });
  expect(await cli(["token", "create", "--name", "worker", "--org", "Team", "--expires", "90d"])).toEqual({
    code: 0,
    out: `${token}\n`,
    err: "",
  });
  const listed = await cli(["token", "ls", "--json"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)).toMatchObject({ tokens: [summary] });
  expect(listed.out).not.toContain(token);
  expect(await cli(["token", "revoke", "key-id"])).toMatchObject({ code: 0, out: "Revoked key-id.\n" });
});

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
