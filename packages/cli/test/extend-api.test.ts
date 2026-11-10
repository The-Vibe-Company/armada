import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

// Owns the CLI transport/duration contract, not the server's authorization or lifetime policy.
// An incorrect route/unit conversion or accepting malformed input must fail before any real network I/O.
test("extend posts the parsed lifetime and preserves JSON output, rejecting invalid durations locally", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const org = "22222222-2222-4222-8222-222222222222";
  const result = { id, expiresAt: "2026-11-10T16:00:00.000Z", ttlSeconds: 14_400 };
  const calls: Request[] = [];
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
  const auth = {
    ...io,
    env: { ARMADA_TOKEN: "fixture-token", ARMADA_URL: "https://armada.test" },
    session: memorySessionStore(),
    now: () => new Date("2026-11-10T12:00:00Z"),
    open: () => {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      return Response.json(result);
    },
  };
  expect(await run(["extend", id, "--ttl", "4h", "--org", org, "--json"], io, { auth })).toBe(0);
  expect(err).toBe("");
  expect(JSON.parse(out)).toEqual(result);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://armada.test/api/v1/sandbox/extend");
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer fixture-token");
  expect(await calls[0]?.json()).toEqual({ id, org, ttl_seconds: 14_400 });

  out = "";
  err = "";
  expect(await run(["extend", id, "--ttl", "tomorrow", "--org", org, "--json"], io, { auth })).toBe(2);
  expect(out).toBe("");
  expect(JSON.parse(err).error.message).toContain("not a duration");
  expect(calls).toHaveLength(1);
});
