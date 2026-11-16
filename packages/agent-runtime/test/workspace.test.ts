import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, Runner, type RunnerRequest } from "../src/index.ts";
import type { WorkspaceExecutionHost } from "../src/workspace-exec.ts";

function processHost() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter & { end: (value: string) => void; destroy: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  const started = Promise.withResolvers<void>();
  let launches = 0;
  let live = true;
  let timer: (() => void) | undefined;
  const kills: [number, string | number | undefined][] = [];
  child.pid = 410;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    end(_value: string) {
      started.resolve();
    },
    destroy() {},
  });
  child.kill = () => {
    throw Error("must signal the verified group");
  };
  const host: WorkspaceExecutionHost = {
    spawn: (() => {
      launches++;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as WorkspaceExecutionHost["spawn"],
    processIdentity: () => ({ boot: "boot", start: "start", group: child.pid }),
    groupState: () => (live ? "live" : "gone"),
    kill(pid, signal) {
      kills.push([pid, signal]);
      return true;
    },
    setTimeout: ((callback: () => void) => {
      timer = callback;
      return 1;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {
      timer = undefined;
    }) as typeof clearTimeout,
  };
  return {
    host,
    started: started.promise,
    kills,
    launches: () => launches,
    expire() {
      if (!timer) throw Error("no deadline");
      timer();
    },
    hasTimer: () => timer !== undefined,
    close() {
      live = false;
      child.emit("close", 0);
    },
  };
}
async function fixture() {
  const processes = processHost();
  const root = await mkdtemp(join(tmpdir(), "runtime-workspace-")),
    home = join(root, "home");
  await mkdir(home);
  const journal = new Journal(join(root, "journal"), (v) => v),
    grant = { sandboxId: "workspace", generation: "1", token: "x".repeat(32), expiresAt: Date.now() + 60000 };
  let starts = 0;
  const runner = new Runner(
    journal,
    grant,
    {
      codex: {
        start() {
          starts++;
          return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
        },
        async close() {},
      },
    },
    undefined,
    undefined,
    undefined,
    { execEnv: { HOME: home, PATH: "/usr/bin:/bin" }, workspaceHost: processes.host },
  );
  const call = (r: RunnerRequest, signal?: AbortSignal) =>
    runner.handle(
      new Request("http://runtime/v1", {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify(r),
        ...(signal ? { signal } : {}),
      }),
    );
  const step = (id: string, cmd: string, cwd: string, phase: "repository" | "init" = "init", signal?: AbortSignal) =>
    call(
      {
        version: 1,
        sandboxId: grant.sandboxId,
        requestId: id,
        op: "workspaceExec",
        input: { command: cmd, cwd, timeoutSeconds: 600, phase, index: 0, attempt: 0 },
      },
      signal,
    );
  return {
    root,
    processes,
    home,
    journal,
    grant,
    call,
    step,
    starts: () => starts,
    async close() {
      journal.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
// Core launch tests own the generated fast-forward policy. This boundary owns
// durable command execution, not Git's repository/commit/fast-forward engine.
test("private workspace command replay runs once without starting inference", async () => {
  const f = await fixture();
  try {
    const command = "printf 'ran\n' >> marker";
    const pending = f.step("init", command, f.home);
    await f.processes.started;
    f.processes.close();
    const first = await (await pending).json();
    expect(first).toMatchObject({ result: { exitCode: 0, detached: false, timedOut: false } });
    expect(await (await f.step("init", command, f.home)).json()).toEqual(first);
    expect(f.processes.launches()).toBe(1);
    expect(f.starts()).toBe(0);
    expect(
      f.journal
        .events(0, 100)
        .filter(
          (e) =>
            e.event.kind === "other" &&
            e.event.type === "armada/workspaceStep" &&
            (e.event.data as { status: string }).status !== "running",
        ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("workspace cancellation reaps its owned group and fences inference through cleanup and later turns", async () => {
  const f = await fixture(),
    abort = new AbortController();
  try {
    const work = f.step("pending", "workspace command", f.home, "init", abort.signal);
    await f.processes.started;
    const prompt: RunnerRequest = {
      version: 1,
      sandboxId: f.grant.sandboxId,
      requestId: "prompt",
      op: "prompt",
      input: { sandboxId: f.grant.sandboxId, harness: "codex", text: "must not overlap", cwd: f.home },
    };
    expect(await (await f.call(prompt)).json()).toMatchObject({ error: "workspace_setup_in_progress" });
    abort.abort();
    expect(f.processes.kills).toEqual([[-410, "SIGKILL"]]);
    expect(await (await f.call({ ...prompt, requestId: "during-cleanup" })).json()).toMatchObject({
      error: "workspace_setup_in_progress",
    });
    expect(f.starts()).toBe(0);
    f.processes.close();
    expect(await (await work).json()).toMatchObject({ result: { timedOut: true } });
    expect(f.processes.hasTimer()).toBe(false);
    expect(f.starts()).toBe(0);
    await f.call({ ...prompt, requestId: "actual-prompt" });
    expect(f.starts()).toBe(1);
    const restored = new Runner(f.journal, f.grant, {});
    expect(
      await (
        await restored.handle(
          new Request("http://runtime/v1", {
            method: "POST",
            headers: { "x-armada-runner-grant": f.grant.token },
            body: JSON.stringify({
              version: 1,
              sandboxId: f.grant.sandboxId,
              requestId: "too-late",
              op: "workspaceExec",
              input: { command: "exit 0", cwd: f.home, timeoutSeconds: 600, phase: "init", index: 0, attempt: 0 },
            }),
          }),
        )
      ).json(),
    ).toMatchObject({ error: "workspace_launch_only" });
  } finally {
    abort.abort();
    await f.close();
  }
});

test("workspace deadline reaps the owned group with an injected clock", async () => {
  const f = await fixture();
  try {
    const work = f.step("deadline", "workspace command", f.home);
    await f.processes.started;
    f.processes.expire();
    expect(f.processes.kills).toEqual([[-410, "SIGKILL"]]);
    f.processes.close();
    expect(await (await work).json()).toMatchObject({ result: { timedOut: true } });
    expect(f.processes.hasTimer()).toBe(false);
  } finally {
    await f.close();
  }
});
