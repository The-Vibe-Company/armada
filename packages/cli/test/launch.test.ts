import { describe, expect, test } from "bun:test";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

describe("new command", () => {
  test("launch is an unknown command", async () => {
    const calls: string[] = [];
    const result = await capture(["launch", "web", "--provider", "modal", "--agent", "codex"], {
      auth: offlineAuth(calls),
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command 'launch'");
    expect(calls).toEqual([]);
  });

  test("bad flags and a missing credential fail before anything starts", async () => {
    const calls: string[] = [];
    const base = { auth: offlineAuth(calls) };
    expect((await capture(["new", "web", "--provider", "boat"], base)).err).toContain("Pass --agent claude or codex");
    expect((await capture(["new", "web", "--provider", "boat", "--agent", "not-a-harness"], base)).code).toBe(2);
    expect(
      (await capture(["new", "web", "--provider", "boat", "--agent", "claude", "--ttl", "soon"], base)).err,
    ).toContain("is not a duration");
    expect((await capture(["new", "--provider", "boat", "--agent", "claude"], base)).code).toBe(2);
    expect((await capture(["new", "web", "--provider", "boat", "--agent", "claude", "a", "b"], base)).code).toBe(2);
    const repeatedRepo = await capture(
      ["new", "web", "--provider", "boat", "--agent", "claude", "--repo", "acme/web", "--repo", "acme/api"],
      base,
    );
    expect(repeatedRepo.code).toBe(2);
    expect(repeatedRepo.err).toContain("--repo can only be set once.");
    const effort = await capture(
      ["new", "web", "--provider", "boat", "--agent", "claude", "--reasoning-effort", "ultra"],
      base,
    );
    expect(effort.err).toContain("Use one of: low, medium, high, xhigh, max");
    const antigravityCarbonXhigh = await capture(
      [
        "new",
        "web",
        "--provider",
        "modal",
        "--agent",
        "antigravity",
        "--model",
        "gemini-4-carbon",
        "--reasoning-effort",
        "xhigh",
      ],
      base,
    );
    expect(antigravityCarbonXhigh.code).toBe(2);
    expect(antigravityCarbonXhigh.err).toContain("Use one of: default, low, medium, high");
    const antigravityNeonXhigh = await capture(
      [
        "new",
        "web",
        "--provider",
        "modal",
        "--agent",
        "antigravity",
        "--model",
        "gemini-4-neon",
        "--reasoning-effort",
        "xhigh",
      ],
      base,
    );
    expect(antigravityNeonXhigh.code).toBe(3);
    expect(antigravityNeonXhigh.err).toContain("You are not signed in. Run armada login.");
    expect(calls).toEqual([]);
  });

  test("a provider selection still requires Armada authentication, not local provider credentials", async () => {
    const calls: string[] = [];
    const result = await capture(["new", "web", "--agent", "claude", "--provider", "modal"], {
      auth: offlineAuth(calls),
    });
    expect(result.code).toBe(3);
    expect(result.err).toContain("You are not signed in. Run armada login.");
    expect(calls).toEqual([]);
  });
});

function offlineAuth(calls: string[]): AuthIo {
  return {
    env: {},
    session: memorySessionStore(),
    out: () => undefined,
    err: () => undefined,
    now: () => new Date(),
    open: () => undefined,
    fetch: async (input) => {
      calls.push(String(input));
      throw new Error("no network");
    },
  };
}

async function capture(argv: string[], deps: Parameters<typeof run>[2]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, deps);
  return { code, out, err };
}
