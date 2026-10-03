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
      return { code: 0, stdout: typeof next === "string" ? next : JSON.stringify(next), stderr: "" };
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
    "-c",
    "check_for_update_on_startup=false",
    "--sandbox",
    "workspace-write",
  ]);
  expect(f.calls[6]).toEqual([
    "herdr",
    "agent",
    "prompt",
    "w8:p9",
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
    "provider/model-a",
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

const claim = { workspace: "w8", pane: "w8:p9", agent: "demo-7" };
const workspace = {
  result: {
    workspace: {
      workspace_id: "w8",
      worktree: {
        repo_root: "/work/widgets",
        checkout_path: "/work/worktrees/widgets",
        is_linked_worktree: true,
      },
    },
  },
};

test("rediscovers a claimed agent by pane and validates every identity field", async () => {
  const f = fake([
    agent("blocked"),
    agent("unknown"),
    { result: { agent: { ...agent().result.agent, workspace_id: "other" } } },
  ]);
  expect(await new Herdr(f.io).state(claim)).toBe("blocked");
  expect(await new Herdr(f.io).state(claim)).toBe("unknown");
  await expect(new Herdr(f.io).state(claim)).rejects.toThrow("agent response");
  expect(f.calls[0]).toEqual(["herdr", "agent", "get", "w8:p9"]);
});

test("answers blocked panes atomically; idle agents use prompt without waiting for a turn", async () => {
  const f = fake([agent("blocked"), { result: { type: "ok" } }, agent("idle"), agent("working")]);
  const text = "yes\n'\" $(never) `never`";
  await new Herdr(f.io).message(claim, text);
  expect(f.calls[1]).toEqual(["herdr", "pane", "run", "w8:p9", text]);
  await new Herdr(f.io).message(claim, text);
  expect(f.calls[3]).toEqual(["herdr", "agent", "prompt", "w8:p9", text]);
});

test("archive verifies linked worktree provenance and passes no force or branch deletion", async () => {
  const f = fake([
    workspace,
    { result: { type: "worktree_removed", workspace_id: "w8", path: "/work/worktrees/widgets", forced: false } },
  ]);
  const runtime = new Herdr(f.io);
  expect(await runtime.worktree(claim)).toEqual({ repo: "/work/widgets", path: "/work/worktrees/widgets" });
  await runtime.remove(claim, "/work/worktrees/widgets");
  expect(f.calls[1]).toEqual(["herdr", "worktree", "remove", "--workspace", "w8"]);
  const unsafe = fake([
    {
      result: {
        workspace: {
          workspace_id: "w8",
          worktree: { ...workspace.result.workspace.worktree, is_linked_worktree: false },
        },
      },
    },
  ]);
  await expect(new Herdr(unsafe.io).worktree(claim)).rejects.toThrow("linked worktree");
});

test("real herdr terminal-write acknowledgments are empty on success, while reads remain strict", async () => {
  const f = fake([agent("blocked")]);
  const exec = f.io.exec;
  if (!exec) throw new Error("missing exec");
  f.io.exec = async (command, args, options) => {
    if (args[0] === "pane") {
      f.calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    }
    return exec(command, args, options);
  };
  await new Herdr(f.io).message(claim, "y");
  await new Herdr(f.io).report(claim.pane, "codex", "working");
  f.io.exec = async () => ({ code: 0, stdout: "", stderr: "" });
  await expect(new Herdr(f.io).state(claim)).rejects.toThrow("agent get failed");
  f.io.exec = async () => ({ code: 1, stdout: "", stderr: "" });
  await expect(new Herdr(f.io).report(claim.pane, "codex", "working")).rejects.toThrow("pane report-agent failed");
});

// DeepSeek uses Herdr's real OpenCode kind, so later agent prompts stay interactive.
test("DeepSeek fallback starts OpenCode with its provider and delivers follow-up prompts", async () => {
  const f = fake([
    agent(),
    modelMetadata("deepseek/deepseek-reasoner", "DeepSeek Reasoner"),
    "Build DeepSeek Reasoner DeepSeek\n╹",
    agent("working"),
    agent("working"),
  ]);
  const runtime = new Herdr(f.io);
  const handle = { workspace: "w8", pane: "w8:p9", agent: "demo-7", path: "/work" };
  await runtime.start(handle, {
    harness: "deepseek",
    model: "deepseek/deepseek-reasoner",
    effort: "high",
    extraArgs: [],
  });
  expect(f.calls[0]).toContain("opencode");
  expect(f.calls[0]).not.toContain("deepseek");
  expect(f.calls[0]?.slice(-2)).toEqual(["--model", "deepseek/deepseek-reasoner"]);
  const brief = `Follow .agents/skills/armada-worker/SKILL.md\n${"quotes ' \" $(touch never)\n".repeat(100)}`;
  await runtime.prompt(handle, brief);
  await runtime.prompt(handle, "Plan approved. Continue.");
  expect(f.calls[3]?.[4]).toBe(brief);
  expect(f.calls[4]?.[4]).toBe("Plan approved. Continue.");
});

test("Codex and DeepSeek preserve their model IDs and extra arguments", () => {
  expect(
    harnessArgs({ harness: "codex", model: "model-a", effort: "high", extraArgs: ["--sandbox", "workspace-write"] }),
  ).toEqual([
    "--model",
    "model-a",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "check_for_update_on_startup=false",
    "--sandbox",
    "workspace-write",
  ]);
  expect(
    harnessArgs({ harness: "deepseek", model: "opencode/deepseek-v4.1-flash", effort: "high", extraArgs: ["--auto"] }),
  ).toEqual(["--model", "opencode/deepseek-v4.1-flash", "--auto"]);
});

// Identity subset of `opencode models --verbose`; no keys or provider options.
function modelMetadata(id: string, name: string) {
  const slash = id.indexOf("/");
  return `${id}\n${JSON.stringify({ id: id.slice(slash + 1), providerID: id.slice(0, slash), name }, null, 2)}\n`;
}
// Prompt region transcribed from an OpenCode 1.18.34 PTY on 2026-10-03.
// The other cases substitute synthetic model/provider names in that recording.
const recordedPane = `
  ┃ Ask anything… "What is the tech stack of this project?"
  ┃
  ┃ Build auto · Big Pickle OpenCode Zen
  ╹
                                      tab agents  ctrl+p commands
`;
const opencodeProfile = { harness: "opencode" as const, model: "opencode/big-pickle", effort: "high", extraArgs: [] };
const metadata = modelMetadata("opencode/big-pickle", "Big Pickle") + modelMetadata("demo/model-b", "Model B");

test("OpenCode verifies its recorded footer before a brief, including older UI layout", async () => {
  for (const pane of [
    recordedPane,
    recordedPane.replace("Build auto ·", "Build"),
    recordedPane.replace("Build auto", "Plan"),
  ]) {
    const f = fake([agent(), metadata, pane, agent("working")]);
    const handle = { ...claim, path: "/work" };
    await new Herdr(f.io).start(handle, opencodeProfile);
    await new Herdr(f.io).prompt(handle, "synthetic brief");
    expect(f.calls[2]).toEqual(["herdr", "pane", "read", claim.pane, "--source", "visible"]);
    expect(f.calls[3]?.[2]).toBe("prompt");
  }
});

test("OpenCode fallback or model-not-found closes only the new pane and sends no brief", async () => {
  for (const [pane, reason] of [
    [recordedPane.replace("Big Pickle OpenCode Zen", "Model B Demo"), "differs from profile"],
    [`ProviderModelNotFoundError: Model not found: opencode/big-pickle#high\n${recordedPane}`, "could not load"],
  ]) {
    const f = fake([agent(), metadata, pane, { result: { type: "ok" } }]);
    await expect(new Herdr(f.io).start({ ...claim, path: "/work" }, opencodeProfile)).rejects.toThrow(reason);
    expect(f.calls.at(-1)).toEqual(["herdr", "pane", "close", claim.pane]);
    expect(f.calls.some((call) => call[2] === "prompt")).toBe(false);
  }
});

test("unverifiable and ambiguous panes fail closed with bounded injected polling", async () => {
  for (const pane of [
    "opencode --model opencode/big-pickle\nBig Pickle",
    "Expected Big Pickle OpenCode Zen",
    recordedPane.replace("Big Pickle", "Unknown Model"),
    "",
  ]) {
    const f = fake([agent(), metadata, ...Array(20).fill(pane), { result: { type: "ok" } }]);
    let clock = 0;
    f.io.now = () => new Date(clock);
    f.io.sleep = async (ms) => {
      clock += ms;
    };
    await expect(new Herdr(f.io).start({ ...claim, path: "/work" }, opencodeProfile)).rejects.toThrow(
      "could not verify",
    );
    expect(clock).toBe(5_000);
    expect(f.calls.at(-1)).toEqual(["herdr", "pane", "close", claim.pane]);
  }
  const ambiguous = fake([
    agent(),
    metadata + modelMetadata("other/big-pickle", "Big Pickle"),
    ...Array(20).fill(recordedPane),
    { result: { type: "ok" } },
  ]);
  ambiguous.io.sleep = async () => {};
  await expect(new Herdr(ambiguous.io).start({ ...claim, path: "/work" }, opencodeProfile)).rejects.toThrow(
    "could not verify",
  );
});

test("pane and metadata failures are sanitized, even when pane cleanup also fails", async () => {
  const f = fake([agent(), new Error("CANARY_private_provider_key"), new Error("CANARY_private_provider_key")]);
  await expect(new Herdr(f.io).start({ ...claim, path: "/work" }, opencodeProfile)).rejects.toThrow(
    "could not close worker pane",
  );
  const g = fake([agent(), metadata, new Error("CANARY_private_pane_text"), { result: { type: "ok" } }]);
  await expect(new Herdr(g.io).start({ ...claim, path: "/work" }, opencodeProfile)).rejects.toThrow(
    "No worker brief was sent",
  );
});
