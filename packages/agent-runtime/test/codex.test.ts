import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDriver, type DriverEvent, type Turn } from "../src/index.ts";

const nativeTest = process.platform === "linux" ? test : test.skip;

// Audit: actual JSONL child-process transport owns request/notification races and restart steering.
// Runtime fake tests cannot detect duplicate delivery or response-vs-terminal ordering here.
nativeTest("Codex waits for interrupt terminal then sends steer once on the same resumed thread", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let turn: Turn | undefined;
  let steering: Promise<void> | undefined;
  const events: DriverEvent[] = [];
  const sessions: string[] = [];
  try {
    turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "initial" },
      sessionId: "persisted-thread",
      signal: new AbortController().signal,
      session: (id) => sessions.push(id),
      emit: (event) => {
        events.push(event);
        if (event.kind === "message" && event.partial && !steering) steering = turn?.steer("redirect");
      },
    });
    expect(await turn.done).toBe("finished");
    await steering;
    expect(sessions).toEqual(["persisted-thread"]);
    // Account notifications have no threadId and must survive thread filtering.
    expect(events.filter((e) => e.kind === "other" && e.type === "account/rateLimits/updated")).toEqual([
      {
        kind: "other",
        type: "account/rateLimits/updated",
        data: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1794268800 },
            secondary: null,
          },
        },
      },
    ]);
    expect(events.filter((e) => e.kind === "message" && e.text === "redirect delivered once")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "other" && e.type === "turn/completed")).toHaveLength(2);
  } finally {
    await driver.close();
  }
});

// Sanitized terminal captured from pinned 0.167.0 in opt-in Boat smoke. No provider text or credentials.
nativeTest.each([
  ["recorded-failure", "harness_failed"],
  ["unauthorized", "authentication_failed"],
  ["usageLimitExceeded", "usage_limit_exceeded"],
  ["rateLimitExceeded", "rate_limited"],
])("Codex terminal %s is a typed failure, never successful completion", async (text, code) => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENAI_API_KEY: "synthetic-not-a-real-key" },
  });
  const events: DriverEvent[] = [];
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text },
      signal: new AbortController().signal,
      session: () => {},
      emit: (e) => {
        events.push(e);
      },
    });
    await expect(turn.done).rejects.toMatchObject({ code });
    expect(events.filter((e) => e.kind === "other" && e.type === "turn/completed")).toHaveLength(1);
  } finally {
    await driver.close();
  }
});

// JSONL process boundary is independent of the Claude SDK's argv serialization risk.
nativeTest(
  "Codex delivers MCP header and stdio env only through private JSONL, not native argv or global env",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-codex-mcp-"));
    const receipt = join(root, "inspection.json");
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CODEX_HOME: root, ARMADA_MCP_INSPECTION: receipt },
    });
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "redirect" },
        signal: AbortSignal.timeout(3000),
        session: () => {},
        emit: () => {},
        mcp: {
          revision: "r1",
          servers: {
            remote: {
              type: "http",
              url: "https://example.invalid/mcp",
              headers: { Authorization: "mcp-header-fixture-sensitive" },
            },
            local: {
              type: "stdio",
              command: "fixture-command",
              env: { PRIVATE_MCP_VALUE: "mcp-env-fixture-sensitive" },
            },
          },
        },
      });
      expect(await turn.done).toBe("finished");
      expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
        argvLeak: false,
        environmentLeak: false,
        configured: true,
      });
    } finally {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
