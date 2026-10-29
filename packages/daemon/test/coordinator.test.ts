import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT, TOOL_NAMES } from "../coordinator/index.ts";
import { EventStore } from "../src/store.ts";

test("the native coordinator prompt describes each offered tool exactly once", () => {
  for (const name of TOOL_NAMES) assert.equal(SYSTEM_PROMPT.split(`\`${name}\``).length - 1, 1, name);
  const mentioned = [...SYSTEM_PROMPT.matchAll(/`([a-z]+\.[a-z]+)`/g)].map((match) => match[1]);
  assert.deepEqual(mentioned.sort(), [...TOOL_NAMES].sort());
});

for (const interruption of ["after-result", "tool"]) {
  test(`daemon restart restores three model turns and one tool call (${interruption})`, {
    timeout: 20000,
  }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "armada-pi-restart-"));
    const file = join(dir, "events.sqlite");
    type Message = {
      type: string;
      entries?: { kind: string; data: unknown }[];
      calls?: number;
      messages?: unknown[];
    };
    const messages: Message[] = [];
    type Completion = { code: number | null; signal: string | null; error?: Error };
    const children: { child: ReturnType<typeof spawn>; completed: Promise<Completion> }[] = [];
    t.after(async () => {
      await Promise.all(
        children.map(async ({ child, completed }) => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await completed;
        }),
      );
      rmSync(dir, { recursive: true, force: true });
    });
    const launch = async (mode: string, until: string) => {
      // Use Node's executable protocol directly: no inherited Bun execArgv or cross-runtime IPC framing.
      const child = spawn(
        "node",
        [fileURLToPath(new URL("./coordinator-process.ts", import.meta.url)), file, mode, interruption],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      // Register once at launch; close also guarantees that the stdout gate has been drained.
      const completed = new Promise<Completion>((resolve) => {
        child.once("error", (error) => resolve({ code: null, signal: null, error }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      children.push({ child, completed });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const lines = createInterface({ input: child.stdout });
      const gate = new Promise<Message>((resolve, reject) => {
        lines.on("line", (line) => {
          try {
            const message: Message = JSON.parse(line);
            messages.push(message);
            if (message.type === until) resolve(message);
          } catch (error) {
            reject(error);
          }
        });
      });
      const message = await Promise.race([
        gate,
        completed.then(({ code, signal, error }) => {
          throw new Error(`child exited before ${until}: ${code}/${signal}: ${error?.message ?? stderr}`);
        }),
      ]);
      return { child, completed, message };
    };
    const initial = await launch("start", "paused");
    initial.child.kill("SIGKILL");
    const killed = await initial.completed;
    assert.equal(killed.signal, "SIGKILL");
    const store = new EventStore(file);
    const before = store.readSince(0, "p");
    store.close();
    assert.ok(before.some((event) => event.kind === "coordinator.checkpoint"));
    const resumed = await launch("resume", "done");
    assert.equal(resumed.message.calls, 1, "only the unfinished third model turn is requested on reopen");
    assert.equal(
      messages.filter((message) => message.type === "tool").length,
      1,
      "never repeat the external tool effect",
    );
    const entries = resumed.message.entries;
    assert.ok(entries);
    assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 2);
    assert.equal(entries.filter((entry) => entry.kind === "pi.assistant").length, 3);
    assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 1);
    const context = JSON.stringify(messages.find((message) => message.type === "resumed-context")?.messages);
    assert.ok(context.includes("I will check the fleet"));
    assert.ok(context.includes("fleet-call"));
    if (interruption === "after-result") assert.ok(context.includes("sessions"));
    else assert.match(context, /interrupted/i, "unsafe in-flight tools become interrupted results");
    const ended = await resumed.completed;
    assert.equal(ended.error, undefined);
    assert.equal(ended.code, 0);
    const reopened = new EventStore(file);
    assert.deepEqual(
      reopened.readSince(0, "p").slice(0, before.length),
      before,
      "recovery preserves the original log prefix",
    );
    reopened.close();
  });
}
