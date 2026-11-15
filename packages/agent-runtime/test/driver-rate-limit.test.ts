import { expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "../src/claude.ts";
import { OpenCodeDriver } from "../src/opencode.ts";
import type { DriverEvent } from "../src/protocol.ts";

// The local stdio/export fixture does not implement OpenCode's separate HTTP event server.
// Observer wire/auth/filter behavior has its own fake-stream boundary test (no network).
const createRetryObserver = async () => ({
  args: ["acp"],
  env: {},
  observation: { ready: async () => {}, failed: new Promise<never>(() => {}), close: async () => {} },
});

for (const kind of ["claude", "opencode"] as const)
  for (const status of [429, 529]) {
    test(`${kind} terminal ${status} continues the same turn after a fake-clock backoff`, async () => {
      const root = await mkdtemp(join(tmpdir(), "model-retry-"));
      const driver =
        kind === "claude"
          ? new ClaudeDriver({
              executable: `${import.meta.dir}/fixtures/claude-process.ts`,
              cwd: import.meta.dir,
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                ARMADA_THROTTLE_CASE: status === 429 ? "rate_limit" : "overloaded",
              },
            })
          : new OpenCodeDriver({
              createRetryObserver,
              executable: `${import.meta.dir}/fixtures/opencode.ts`,
              root: join(root, "native"),
              cwd: root,
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                OPENCODE_THROTTLE_STATE: join(root, "throttle"),
                OPENCODE_THROTTLE_STATUS: String(status),
              },
              redact: (text) => text,
            });
      const events: DriverEvent[] = [];
      const sessions: string[] = [];
      try {
        const turn = driver.start({
          request: { sandboxId: "s", harness: kind, text: "original" },
          signal: new AbortController().signal,
          session: (id) => sessions.push(id),
          emit: (event) => {
            events.push(event);
            if (event.kind === "other" && event.type === "armada/modelRateLimit") {
              jest.useFakeTimers();
              queueMicrotask(() => jest.advanceTimersByTime(300_000));
            }
          },
        });
        expect(await turn.done).toBe("finished");
        expect(events.filter((e) => e.kind === "other" && e.type === "armada/modelRateLimit")).toHaveLength(1);
        expect(new Set(sessions).size).toBe(1);
      } finally {
        jest.useRealTimers();
        await driver.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

test("Claude native API retries are reported without starting an Armada backoff", async () => {
  const driver = new ClaudeDriver({
    executable: `${import.meta.dir}/fixtures/claude-process.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_THROTTLE_CASE: "native-retry" },
  });
  const events: DriverEvent[] = [];
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "claude", text: "original" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (e) => events.push(e),
    });
    expect(await turn.done).toBe("finished");
    expect(events.filter((e) => e.kind === "other" && e.type === "armada/modelRateLimit")).toMatchObject([
      { data: { retryCount: 1, delayMs: 20000, totalWaitMs: 20000 } },
    ]);
  } finally {
    await driver.close();
  }
});

test("OpenCode does not reuse a preceding throttle when the resumed process fails before new output", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-retry-stale-"));
  const driver = new OpenCodeDriver({
    createRetryObserver,
    executable: `${import.meta.dir}/fixtures/opencode.ts`,
    root: join(root, "native"),
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OPENCODE_THROTTLE_STATE: join(root, "throttle"),
      OPENCODE_THROTTLE_STATUS: "429",
      OPENCODE_THROTTLE_SECOND_FAIL: "1",
    },
    redact: (text) => text,
  });
  let retries = 0;
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "original" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (event) => {
        if (event.kind === "other" && event.type === "armada/modelRateLimit") {
          retries++;
          jest.useFakeTimers();
          queueMicrotask(() => jest.advanceTimersByTime(300000));
        }
      },
    });
    await expect(turn.done).rejects.toThrow("harness_failed");
    expect(retries).toBe(1);
  } finally {
    jest.useRealTimers();
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
