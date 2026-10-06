import { expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createExec } from "../src/spawn.ts";

test("captured status execution kills its process group on abort and refuses already-aborted work", async () => {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid: 12345,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      throw new Error("must signal the group");
    },
  }) as unknown as ChildProcess;
  let launches = 0;
  const killed: number[] = [];
  const exec = createExec({
    spawn: (() => {
      launches++;
      return child;
    }) as typeof spawn,
    killGroup: (pid) => {
      killed.push(pid);
      queueMicrotask(() => events.emit("close", null));
    },
  });
  const controller = new AbortController();
  const pending = exec("sh", ["-c", "status"], { cwd: "/synthetic", processGroup: true, signal: controller.signal });
  controller.abort();
  expect((await pending).code).toBe(1);
  expect(killed).toEqual([12345]);
  await expect(exec("sh", [], { cwd: "/synthetic", signal: controller.signal })).rejects.toThrow();
  expect(launches).toBe(1);
});
