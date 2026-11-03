import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { guarded } from "@armada/plugin-api/guard";
import { createLocalNode } from "../../node-local/src/index.ts";
import { repository } from "../../node-local/test/support.ts";
import { claudeRuntime } from "../src/index.ts";

for (const mode of ["exit", "closed-input"])
  test(`post-result input resumes the exact Claude session (${mode}), including host reattachment`, {
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-delivery-"));
    const node = createLocalNode({ workspaceRoot: join(root, "worktrees"), transport: "pipe" });
    const options = {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/claude-worker.mjs", import.meta.url))],
    };
    let runtime = claudeRuntime(options, node);
    const workspace = await runtime.prepare({
      project: "orchard",
      ticket: "SEED-1",
      repository: await repository(root),
      branch: "worker",
    });
    const worker = { project: "orchard", ticket: "SEED-1", session: "one", generation: 1 };
    const mutate = <T>(action: () => Promise<T>) => guarded(worker, () => {}, action);
    const ref = await mutate(() =>
      runtime.launch({
        workspace,
        worker,
        command: "",
        args: [],
        env: {
          FIXTURE_EXIT_AFTER_RESULT: mode,
          XDG_CONFIG_HOME: join(root, "config"),
          FIXTURE_LEDGER: join(root, "turns.jsonl"),
        },
      }),
    );
    const reply = async (input: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const value = await runtime.observe(ref);
        if (value.activity === "idle" && value.reply) {
          const result = JSON.parse(value.reply);
          if (result.input === input) return result;
        }
        await setImmediate();
      }
      throw new Error("Claude did not receive the requested turn");
    };
    try {
      await mutate(() => runtime.deliver(ref, "ready-to-merge", "brief"));
      const first = await reply("ready-to-merge");
      assert.equal(first.cwd, workspace.path);
      assert(!first.args.includes("--resume"));
      // Reattach to the same supervisor; the native conversation belongs to it, not the host process.
      const recovery = runtime.checkpoint?.(ref);
      runtime = claudeRuntime(options, createLocalNode({ workspaceRoot: join(root, "worktrees"), transport: "pipe" }));
      await runtime.adopt?.(ref, workspace, recovery);
      // Both inputs are accepted before either print subprocess finishes.
      await Promise.all([
        mutate(() => runtime.deliver(ref, "bring main in", "answer")),
        mutate(() => runtime.deliver(ref, "ready-to-merge again", "hand-back")),
      ]);
      const last = await reply("ready-to-merge again");
      const turns = (await readFile(join(root, "turns.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        turns.map((turn) => turn.input),
        ["ready-to-merge", "bring main in", "ready-to-merge again"],
      );
      for (const turn of turns.slice(1)) {
        assert.equal(turn.args[turn.args.indexOf("--resume") + 1], "claude-fixture-session");
        assert.equal(turn.cwd, workspace.path);
      }
      await mutate(() => runtime.deliver(ref, "bring main in", "answer"));
      assert.equal((await runtime.observe(ref)).reply, JSON.stringify(last));
      await assert.rejects(
        mutate(() => runtime.deliver({ ...ref, generation: 2 }, "stale", "stale")),
        /generation/,
      );
      assert.equal((await runtime.observe(ref)).state, "running");
      const usage = (await runtime.observe(ref)).usage;
      assert.equal(typeof usage === "object" && usage?.input, 30);
    } finally {
      await mutate(() => runtime.stop(ref));
      await rm(root, { recursive: true, force: true });
    }
  });
