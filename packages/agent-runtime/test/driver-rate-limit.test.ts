import { expect, jest, test } from "bun:test";
import { AcpDriver } from "../src/acp.ts";
import { ClaudeDriver } from "../src/claude.ts";
import type { DriverEvent } from "../src/protocol.ts";

for (const kind of ["claude", "opencode"] as const)
  for (const status of [429, 529]) {
    test(`${kind} terminal ${status} continues the same turn after a fake-clock backoff`, async () => {
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
          : new AcpDriver({
              executable: process.execPath,
              args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
              cwd: import.meta.dir,
              env: { ACP_THROTTLE: String(status) },
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
