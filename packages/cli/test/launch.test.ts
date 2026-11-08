import { describe, expect, test } from "bun:test";
import type { GoldenActor } from "@armada/core";
import { run } from "../src/run.ts";

// armada launch now does its own credential and provider resolution on the server
// (POST /api/v1/sandbox/launch), not in the CLI process: the scenarios this file used to cover
// client-side (the user's credential winning over the org's, Codex's auth.json, a failing init,
// GitHub identity in the fork's environment, a missing credential or snapshot) are covered where
// that resolution now actually runs — packages/core/test/launch.test.ts (launchSandbox itself) and
// packages/mcp-server/test/control.test.ts ("sandbox/launch ...") — and the CLI's own HTTP call is
// covered by launch-api.test.ts. What is left here, genuinely CLI-only and still true today, is
// argument validation that happens before any network call.
describe("launch command", () => {
  test("bad flags and a missing credential fail before anything starts", async () => {
    const calls: string[] = [];
    const base = {
      actor: {
        userId: "22222222-2222-4222-8222-222222222222",
        orgId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      } as GoldenActor,
      store: { list: async () => [], findByName: async () => [] } as never,
      sandboxes: {} as never,
      fetch: (async () => {
        calls.push("fetch");
        throw new Error("no network");
      }) as unknown as typeof fetch,
    };
    expect((await capture(["launch", "web"], base)).err).toContain("Pass --agent claude or codex");
    expect((await capture(["launch", "web", "--agent", "opencode"], base)).code).toBe(2);
    expect((await capture(["launch", "web", "--agent", "claude", "--ttl", "soon"], base)).err).toContain(
      "is not a duration",
    );
    expect((await capture(["launch", "--agent", "claude"], base)).code).toBe(2);
    expect((await capture(["launch", "web", "--agent", "claude", "a", "b"], base)).code).toBe(2);
    expect(calls).toEqual([]);
  });
});

async function capture(argv: string[], deps: Parameters<typeof run>[2]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, deps);
  return { code, out, err };
}
