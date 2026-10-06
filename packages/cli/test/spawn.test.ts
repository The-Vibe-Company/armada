import { expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fstatSync, writeSync } from "node:fs";
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

test.each(["success", "limit", "combined-limit", "error", "abort", "spawn-error"] as const)(
  "file capture is private, bounded and closes its descriptor after %s",
  async (outcome) => {
    let file = -1;
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const child = Object.assign(events, {
      stdin,
      stdout: null,
      stderr: new PassThrough(),
      kill: () => queueMicrotask(() => events.emit("close", null)),
    }) as unknown as ChildProcess;
    const controller = new AbortController();
    const exec = createExec({
      spawn: ((_command: string, _args: string[], options: SpawnOptions) => {
        const output = Array.isArray(options.stdio) ? options.stdio[1] : null;
        if (typeof output !== "number") throw new Error("expected stdout file descriptor");
        file = output;
        expect(fstatSync(file).mode & 0o777).toBe(0o600);
        if (outcome === "spawn-error") throw new Error("synthetic spawn failure");
        queueMicrotask(() => {
          if (outcome === "error") {
            events.emit("error", new Error("synthetic child failure"));
            events.emit("close", 1);
            return;
          }
          writeSync(file, outcome === "limit" ? "x".repeat(101) : "complete stdout");
          if (outcome === "combined-limit") child.stderr?.emit("data", "x".repeat(90));
          if (outcome === "abort") controller.abort();
          else events.emit("close", 0);
        });
        return child;
      }) as typeof spawn,
    });
    const pending = exec("synthetic", [], {
      cwd: "/synthetic",
      captureStdout: "file",
      maxOutputBytes: 100,
      input: "synthetic stdin",
      signal: controller.signal,
    });
    if (outcome === "error" || outcome === "spawn-error") await expect(pending).rejects.toThrow("synthetic");
    else {
      const result = await pending;
      if (outcome === "limit" || outcome === "combined-limit")
        expect(result).toMatchObject({ code: 1, outputExceeded: true, stdout: "", stderr: "" });
      else if (outcome === "success") {
        expect(result).toMatchObject({ code: 0, stdout: "complete stdout" });
        expect(stdin.read()?.toString()).toBe("synthetic stdin");
      } else expect(result.code).toBe(1);
    }
    expect(() => fstatSync(file)).toThrow();
  },
);
