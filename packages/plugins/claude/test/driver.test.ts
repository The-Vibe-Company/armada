import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DRIVER } from "../src/driver.ts";

const fixture = fileURLToPath(new URL("./fixtures/claude-turns.mjs", import.meta.url));

/** The driver exactly as the plugin launches it, over the scripted CLI. */
async function driver(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "claude-driver-"));
  const ledger = join(root, "turns.jsonl");
  const child = spawn(
    "node",
    ["--input-type=module", "--eval", DRIVER, JSON.stringify({ command: "node", args: [fixture] })],
    { env: { ...process.env, FIXTURE_SCENARIO: scenario, FIXTURE_LEDGER: ledger }, stdio: "pipe" },
  );
  const frames: Record<string, unknown>[] = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) frames.push(JSON.parse(line));
  });
  const until = async (what: string, ok: () => boolean, ms = 8_000) => {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`Driver never showed ${what}: ${JSON.stringify(frames)}`);
      await sleep(20);
    }
  };
  return {
    frames,
    until,
    send: (text: string) =>
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`),
    results: () => frames.filter((f) => f.type === "result").map((f) => f.result),
    completed: () => frames.filter((f) => f.type === "armada_turn_state").map((f) => f.completed),
    turns: async () =>
      (await readFile(ledger, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; input: string; resume: boolean }),
    async close() {
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a result with live background tasks keeps the CLI until it continues on its own", {
  timeout: 20_000,
}, async () => {
  const run = await driver("background");
  try {
    run.send("run verify in the background");
    await run.until("the first result", () => run.results().length === 1);
    assert.deepEqual(run.completed(), [0], "a held process is still working");
    // A delivery while held reaches the same process, which keeps its background task.
    run.send("status?");
    await run.until("the held answer", () => run.results().includes("held:status?"));
    // Past the one-second retire and its SIGKILL: the task's own turn still arrives.
    await run.until("the task's turn", () => run.results().includes("verify finished"));
    await run.until("the process to settle", () => run.completed().at(-1) === 2);
    const turns = await run.turns();
    assert.deepEqual(
      turns.map((t) => t.input),
      ["run verify in the background", "status?"],
    );
    assert.equal(new Set(turns.map((t) => t.pid)).size, 1, "one process held both lines");
  } finally {
    await run.close();
  }
});

test("a turn that starts after a stale empty result is never retired mid-turn", { timeout: 20_000 }, async () => {
  const run = await driver("stale-result");
  try {
    run.send("continue");
    await run.until("the stale result", () => run.results().includes(""));
    // The real turn is silent for longer than the retire window and its SIGKILL.
    await run.until("the real result", () => run.results().includes("real:continue"));
    await run.until("the process to settle", () => run.completed().at(-1) === 1);
    assert.deepEqual(run.completed(), [0, 0, 1], "the stale result never reads as a finished delivery");
  } finally {
    await run.close();
  }
});

test("a result with no background task still retires the idle CLI, and the next line resumes it", {
  timeout: 20_000,
}, async () => {
  const run = await driver("plain");
  try {
    run.send("one");
    await run.until("the retire", () => run.completed().at(-1) === 1);
    run.send("two");
    await run.until("the resumed turn", () => run.results().includes("done:two"));
    const turns = await run.turns();
    assert.deepEqual(
      turns.map((t) => [t.input, t.resume]),
      [
        ["one", false],
        ["two", true],
      ],
    );
    assert.notEqual(turns[0]!.pid, turns[1]!.pid);
  } finally {
    await run.close();
  }
});
