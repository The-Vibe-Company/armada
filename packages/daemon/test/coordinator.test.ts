import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-pi-restart-"));
    const file = join(dir, "events.sqlite");
    const messages: {
      type: string;
      entries?: { kind: string; data: unknown }[];
      calls?: number;
      messages?: unknown[];
    }[] = [];
    const children: ReturnType<typeof fork>[] = [];
    const launch = (mode: string, until: string) => {
      const child = fork(new URL("./coordinator-process.ts", import.meta.url), [file, mode, interruption], {
        execPath: "node",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return new Promise<{ child: typeof child; message: (typeof messages)[number] }>((resolve, reject) => {
        child.on("message", (message: (typeof messages)[number]) => {
          messages.push(message);
          if (message.type === until) resolve({ child, message });
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code !== 0) reject(new Error(`child exited ${code}/${signal}: ${stderr}`));
        });
      });
    };
    try {
      const { child } = await launch("start", "paused");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
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
      if (resumed.child.exitCode === null) await once(resumed.child, "exit");
      const reopened = new EventStore(file);
      assert.deepEqual(
        reopened.readSince(0, "p").slice(0, before.length),
        before,
        "recovery preserves the original log prefix",
      );
      reopened.close();
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
