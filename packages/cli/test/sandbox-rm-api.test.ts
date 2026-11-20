import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const sandboxId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

async function runRm(args: string[]) {
  const requests: { method: string | undefined; path: string }[] = [];
  let stdout = "";
  let stderr = "";
  const auth = {
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-token" },
    session: memorySessionStore(),
    now: () => new Date("2026-11-20T00:00:00Z"),
    open: () => {},
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      stderr += text;
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method, path: url.pathname + url.search });
      return Response.json({ id: sandboxId, status: "deleted" });
    },
  };
  const exit = await run(["rm", sandboxId, "--org", orgId, ...args], auth, { auth, stdoutIsTTY: false });
  return { exit, stdout, stderr, requests };
}

test("rm requires explicit confirmation before sending a request", async () => {
  const result = await runRm([]);
  expect(result.exit).toBe(2);
  expect(result.requests).toEqual([]);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.message).toContain("Pass --yes to confirm");
});

test("rm --yes deletes the selected sandbox in the selected organization", async () => {
  const result = await runRm(["--yes"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.requests).toEqual([{ method: "DELETE", path: `/api/v1/sandboxes/${sandboxId}?org=${orgId}` }]);
  expect(JSON.parse(result.stdout)).toEqual({ id: sandboxId, status: "deleted" });
});
