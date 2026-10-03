import { expect, test } from "bun:test";
import { Herdr, harnessArgs } from "../src/herdr.ts";
import type { Io } from "../src/io.ts";

// JSON fields recorded from herdr 0.9.1's isolated synthetic worktree and API schema.
const created = {
  id: "cli:worktree:create",
  result: {
    type: "worktree_created",
    workspace: { workspace_id: "w8" },
    root_pane: { pane_id: "w8:p3", workspace_id: "w8" },
    worktree: { path: "/work/worktrees/widgets", branch: "feature/demo-7" },
  },
};
const agent = (status = "idle") => ({
  id: "cli:agent",
  result: { agent: { name: "demo-7", workspace_id: "w8", pane_id: "w8:p9", agent_status: status } },
});
const tab = { result: { tab: { tab_id: "w8:t2" }, root_pane: { pane_id: "w8:p9", workspace_id: "w8" } } };
function fake(replies: unknown[]) {
  const calls: string[][] = [];
  let starts = 0;
  let detachedEnv: Io["env"] = {};
  const timeouts: number[] = [];
  const io = {
    cwd: "/work/widgets",
    env: { PATH: "/bin", HOME: "/owner", LINEAR_API_KEY: "CANARY", ARMADA_SESSION_TOKEN: "CANARY" },
    exec: async (command: string, args: string[], options: { timeoutMs?: number }) => {
      timeouts.push(options.timeoutMs ?? 0);
      calls.push([command, ...args]);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { code: 0, stdout: JSON.stringify(next), stderr: "" };
    },
    detach: async (_command: string, _args: string[], options: { env: Io["env"] }) => {
      detachedEnv = options.env;
      starts++;
      return true;
    },
    sleep: async () => {},
  } as unknown as Io;
  return { io, calls, timeouts, detachedEnv: () => detachedEnv, starts: () => starts };
}

test("starts an absent server, uses returned topology and sends a long brief verbatim", async () => {
  const f = fake([
    { server: { running: false, status: "not_running" } },
    { server: { running: true, compatible: true } },
    created,
    tab,
    { result: { type: "ok" } },
    agent(),
    agent("working"),
  ]);
  const runtime = new Herdr(f.io);
  await runtime.ensureServer();
  const handle = await runtime.create({ repo: f.io.cwd, branch: "feature/demo-7", base: "trunk", ticket: "DEMO-7" });
  expect(handle).toEqual({ workspace: "w8", pane: "w8:p9", agent: "demo-7", path: "/work/worktrees/widgets" });
  await runtime.start(handle, {
    harness: "codex",
    model: "model-a",
    effort: "high",
    extraArgs: ["--sandbox", "workspace-write"],
  });
  const prompt = `Token: armada_launch_CANARY\n${"quotes ' \" ` $(touch never) \\ and newlines\n".repeat(1000)}`;
  await runtime.prompt(handle, prompt);
  expect(f.starts()).toBe(1);
  expect(f.calls[2]).toEqual([
    "herdr",
    "worktree",
    "create",
    "--cwd",
    "/work/widgets",
    "--branch",
    "feature/demo-7",
    "--base",
    "trunk",
    "--no-focus",
  ]);
  expect(f.detachedEnv()).toEqual({ PATH: "/bin", HOME: "/owner" });
  expect(f.calls[3]).toContain("LINEAR_API_KEY=");
  expect(f.calls[3]).toContain("ARMADA_SESSION_TOKEN=");
  expect(f.calls[3]).toContain("ARMADA_TICKET=DEMO-7");
  expect(f.calls[3]?.join(" ")).not.toContain("CANARY");
  expect(f.calls[4]).toEqual(["herdr", "pane", "close", "w8:p3"]);
  expect(f.calls[5]).toEqual([
    "herdr",
    "agent",
    "start",
    "demo-7",
    "--kind",
    "codex",
    "--pane",
    "w8:p9",
    "--timeout",
    "30000",
    "--",
    "--model",
    "model-a",
    "-c",
    'model_reasoning_effort="high"',
    "--sandbox",
    "workspace-write",
  ]);
  expect(f.calls[6]).toEqual([
    "herdr",
    "agent",
    "prompt",
    "demo-7",
    prompt,
    "--wait",
    "--until",
    "working",
    "--timeout",
    "30000",
  ]);
});

test("a running server is preserved; an incompatible server is refused", async () => {
  const f = fake([{ server: { running: true, compatible: true } }]);
  await new Herdr(f.io).ensureServer();
  expect(f.starts()).toBe(0);
  const incompatible = fake([{ server: { running: true, compatible: false } }]);
  await expect(new Herdr(incompatible.io).ensureServer()).rejects.toThrow("incompatible");
  expect(incompatible.starts()).toBe(0);
});

test("malformed topology and unsafe names stop before an agent is started", async () => {
  const f = fake([{ result: { workspace: { workspace_id: "w9" } } }]);
  await expect(new Herdr(f.io).create({ repo: "/repo", branch: "b", base: "main", ticket: "DEMO-7" })).rejects.toThrow(
    "worktree response",
  );
  await expect(new Herdr(f.io).create({ repo: "/repo", branch: "b", base: "main", ticket: "-bad" })).rejects.toThrow(
    "agent name",
  );
  expect(f.calls).toHaveLength(1);
});

test("failures never echo a prompt or arbitrary herdr diagnostics", async () => {
  const f = fake([new Error("armada_launch_CANARY\nprivate prompt")]);
  await expect(
    new Herdr(f.io).prompt({ workspace: "w8", pane: "w8:p3", agent: "demo-7", path: "/work" }, "armada_launch_CANARY"),
  ).rejects.toThrow("herdr agent prompt failed");
  const g = fake([{ error: { code: "agent_blocked", message: "armada_launch_CANARY" } }]);
  await expect(
    new Herdr(g.io).prompt({ workspace: "w8", pane: "w8:p3", agent: "demo-7", path: "/work" }, "armada_launch_CANARY"),
  ).rejects.toThrow("agent_blocked");
});

test("harnesses receive explicit model and effort arguments", () => {
  expect(harnessArgs({ harness: "claude", model: "model-a", effort: "high", extraArgs: [] })).toEqual([
    "--model",
    "model-a",
    "--effort",
    "high",
  ]);
  expect(harnessArgs({ harness: "opencode", model: "provider/model-a", effort: "high", extraArgs: [] })).toEqual([
    "--model",
    "provider/model-a#high",
  ]);
});

test("server readiness has one deadline and short probes", async () => {
  const f = fake(Array.from({ length: 30 }, () => ({ server: { running: false } })));
  let clock = 0;
  f.io.now = () => new Date(clock);
  f.io.sleep = async (ms) => {
    clock += ms;
  };
  const exec = f.io.exec;
  if (!exec) throw new Error("missing fake exec");
  f.io.exec = async (command, args, options) => {
    if (f.starts()) clock += options.timeoutMs ?? 0;
    return exec(command, args, options);
  };
  await expect(new Herdr(f.io).ensureServer()).rejects.toThrow("did not become ready");
  expect(clock).toBe(5_000);
  expect(f.timeouts[0]).toBe(5_000);
  expect(f.timeouts.slice(1).every((ms) => ms <= 1_000)).toBe(true);
  expect(f.calls.length).toBeLessThan(10);
});

test("failure to close the initial inherited shell prevents launch", async () => {
  const f = fake([created, tab, { error: { code: "confirmation_required" } }]);
  await expect(new Herdr(f.io).create({ repo: "/repo", branch: "b", base: "main", ticket: "DEMO-7" })).rejects.toThrow(
    "confirmation_required",
  );
  expect(f.calls.at(-1)).toEqual(["herdr", "pane", "close", "w8:p3"]);
  expect(f.calls.some((call) => call[1] === "agent")).toBe(false);
});
