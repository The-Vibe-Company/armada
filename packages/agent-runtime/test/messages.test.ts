import { expect, test } from "bun:test";
import { ClaudeDriver, CodexDriver, type DriverEvent } from "../src/index.ts";

// Real native transports, with independent SDK message/item IDs (not envelope UUIDs).
const nativeTest = process.platform === "linux" ? test : test.skip;
nativeTest.each(["claude", "codex"] as const)(
  "%s correlates deltas and snapshots without merging distinct messages",
  async (harness) => {
    const options = {
      executable: `${import.meta.dir}/fixtures/${harness === "claude" ? "claude-process" : "app-server"}.ts`,
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    };
    const driver = harness === "claude" ? new ClaudeDriver(options) : new CodexDriver(options);
    const events: DriverEvent[] = [];
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness, text: "message-semantics" },
        signal: new AbortController().signal,
        session: () => {},
        emit: (e) => events.push(e),
      });
      expect(await turn.done).toBe("finished");
      const expected = ["answer-a", "answer-b"].flatMap((id) =>
        harness === "claude"
          ? [
              [id, "delta", "Hello"],
              [id, "snapshot", "Hello"],
              [id, "snapshot", "Hello world"],
              [id, "snapshot", "Hello world"],
            ]
          : [
              [id, "delta", "Hello"],
              [id, "snapshot", "Hello world"],
            ],
      );
      expect(
        events
          .filter((e) => e.kind === "message")
          .map((e) => e.kind === "message" && [e.messageId, e.textMode, e.text]),
      ).toEqual(expected);
    } finally {
      await driver.close();
    }
  },
);
