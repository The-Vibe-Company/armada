import { expect, test } from "bun:test";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const sandboxId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

async function runRm(
  args: string[],
  opts: {
    includeId?: boolean;
    env?: Record<string, string>;
    sandboxFile?: { read: () => Promise<string>; write: () => Promise<void> };
  } = {},
) {
  const requests: { method: string | undefined; path: string }[] = [];
  let stdout = "";
  let stderr = "";
  const auth: AuthIo = {
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-token", ...opts.env },
    session: memorySessionStore(),
    now: () => new Date("2026-11-20T00:00:00Z"),
    open: () => {},
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      stderr += text;
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method, path: url.pathname + url.search });
      return Response.json({ id: sandboxId, status: "deleted" });
    },
  };
  const argv = opts.includeId === false ? ["rm", ...args] : ["rm", sandboxId, "--org", orgId, ...args];
  const exit = await run(argv, auth, {
    auth,
    stdoutIsTTY: false,
    ...(opts.sandboxFile ? { sandboxFile: opts.sandboxFile } : {}),
  });
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

test("rm --yes requires an explicit sandbox ID and never falls back to ARMADA_SANDBOX or .armada/sandbox", async () => {
  let fileReads = 0;
  const result = await runRm(["--yes"], {
    includeId: false,
    env: { ARMADA_SANDBOX: sandboxId },
    sandboxFile: {
      read: async () => {
        fileReads++;
        return sandboxId;
      },
      write: async () => {},
    },
  });
  expect([result.exit, result.requests.length, fileReads]).toEqual([2, 0, 0]);
  expect(JSON.parse(result.stderr).error.message).toContain("armada rm <sandbox-id>");
});
