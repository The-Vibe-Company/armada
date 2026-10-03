import { expect, test } from "bun:test";
import { parseConfig } from "@armada/core";
import { DEMO_TOML } from "../../core/test/support.ts";
import type { Io } from "../src/io.ts";
import { setupLocal } from "../src/local-setup.ts";

const profiles = `
[herdr.profiles.claude]
harness = "claude"
model = "model-a"
effort = "high"
[herdr.profiles.codex]
harness = "codex"
model = "model-b"
effort = "high"
[herdr.profiles.opencode]
harness = "opencode"
model = "provider/model-c"
effort = "high"
[herdr.profiles.deepseek]
harness = "deepseek"
model = "provider/deepseek-example"
effort = "high"
`;
function fixture(
  options: {
    choice?: string | null;
    json?: boolean;
    blocked?: boolean;
    changed?: boolean;
    explicit?: boolean;
    modelProblem?: boolean;
    openCodeQuestion?: boolean;
    openCodeFallback?: boolean;
  } = {},
) {
  let text = DEMO_TOML + profiles;
  if (options.explicit) text = text.replaceAll('effort = "high"', 'effort = "high"\npermissions = "full"');
  let stored = text;
  const writes: string[] = [],
    calls: string[][] = [],
    output: string[] = [],
    errors: string[] = [],
    questions: string[] = [];
  const agents: Record<string, unknown>[] = [];
  const fingerprints = new Map<string, string>();
  let pane = 0;
  const root = "/custom/worktrees/widgets";
  let created = false;
  let submitted = false;
  let time = 0;
  const io: Io = {
    cwd: "/work/widgets",
    env: { HOME: "/owner", LINEAR_API_KEY: "CANARY_private" },
    interactive: true,
    now: () => new Date(time),
    sleep: async (ms) => {
      time += ms;
    },
    ghToken: () => null,
    readFile: async () => stored,
    writeFile: async (_path, value) => {
      writes.push(value);
      stored = value;
    },
    prompt: async (question) => {
      questions.push(question);
      if (question.includes("Permissions")) {
        if (options.changed) stored += "\n# owner edit\n";
        return options.choice === undefined ? "ask" : options.choice;
      }
      return "";
    },
    stdout: (t) => output.push(t),
    stderr: (t) => errors.push(t),
    exec: async (command, args) => {
      calls.push([command, ...args]);
      const ok = (reply: unknown) => ({ code: 0, stdout: JSON.stringify(reply), stderr: "" });
      if (args[0] === "--version") return { code: 0, stdout: `${command} 0.9.3`, stderr: "" };
      if (command === "claude") return ok({ loggedIn: false });
      if (command === "codex") return { code: 1, stdout: "Not logged in", stderr: "" };
      if (command === "opencode") {
        const ids = ["provider/model-c", "provider/deepseek-example"];
        return {
          code: 0,
          stdout: args.includes("--verbose")
            ? ids
                .map(
                  (id) =>
                    `${id}\n${JSON.stringify({ providerID: "provider", id: id.split("/")[1], name: id.split("/")[1] }, null, 2)}\n`,
                )
                .join("")
            : `${ids.join("\n")}\n`,
          stderr: "",
        };
      }
      if (command === "git") return { code: 0, stdout: "/work/widgets\n", stderr: "" };
      if (args[0] === "status") return ok({ server: { running: true, compatible: true } });
      if (args[0] === "worktree" && args[1] === "list")
        return ok({
          result: {
            source: { source_checkout_path: "/work/widgets", repo_root: "/work/widgets" },
            worktrees: [
              {
                branch: "armada-local-setup-widgets",
                path: `${root}/armada-local-setup-widgets`,
                is_linked_worktree: true,
              },
            ],
          },
        });
      if (args[0] === "workspace" && args[1] === "list")
        return ok({
          result: { workspaces: created ? [{ workspace_id: "w8", label: `Armada local setup: ${root}` }] : [] },
        });
      if (args[0] === "workspace" && args[1] === "create") {
        created = true;
        return ok({
          result: { workspace: { workspace_id: "w8" }, root_pane: { pane_id: "w8:p0", workspace_id: "w8" } },
        });
      }
      if (args[0] === "tab") return ok({ result: { root_pane: { pane_id: `w8:p${++pane}`, workspace_id: "w8" } } });
      if (args[0] === "agent" && args[1] === "list") return ok({ result: { agents } });
      if (args[0] === "agent" && args[1] === "start") {
        const a = {
          name: args[2],
          pane_id: args[6],
          workspace_id: "w8",
          agent: args[4],
          model: args[args.indexOf("--model") + 1],
          cwd: root,
          agent_status: "idle",
          interactive_ready: true,
          tokens: { armadaSetup: fingerprints.get(args[6] ?? "") },
        };
        agents.push(a);
        return ok({ result: { agent: a } });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        submitted = true;
        return ok({ result: { agent: agents.find((a) => a.pane_id === args[2]) } });
      }
      if (args[0] === "agent" && args[1] === "get")
        return ok({ result: { agent: agents.find((a) => a.pane_id === args[2]) } });
      if (args[0] === "pane" && args[1] === "report-metadata") {
        fingerprints.set(args[2] ?? "", args[6]?.split("=")[1] ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "pane" && args[1] === "close") return ok({ result: { type: "ok" } });
      if (args[0] === "pane" && args[1] === "read")
        return {
          code: 0,
          stdout:
            options.modelProblem && submitted
              ? "The CANARY_private model is not supported when using Codex with a ChatGPT account."
              : options.openCodeQuestion && agents.find((a) => a.pane_id === args[2])?.agent === "opencode"
                ? "Select a provider to connect"
                : agents.find((a) => a.pane_id === args[2])?.agent === "opencode"
                  ? `Build auto · ${options.openCodeFallback ? "deepseek-example" : "model-c"} Example Provider\n╹`
                  : options.blocked
                    ? "Do you trust the contents of this directory?"
                    : "Ready\n> ",
          stderr: "",
        };
      throw new Error(`unexpected ${command} ${args.slice(0, 2).join(" ")}`);
    },
  };
  const run = () =>
    setupLocal(io, parseConfig(stored), "/work/widgets/armada.toml", { rest: ["local"], json: options.json ?? false });
  return {
    run,
    io,
    calls,
    writes,
    agents,
    text: () => stored,
    edit: (next: string) => {
      stored = next;
    },
    questions,
    output: () => output.join(""),
    errors: () => errors.join(""),
    root,
  };
}

test("owner setup saves one permission choice, opens each native harness at the actual worktree parent and checks readiness", async () => {
  const f = fixture({ choice: "full" });
  expect(await f.run()).toBe(0);
  expect(f.questions.filter((q) => q.includes("Permissions"))).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
  for (const p of Object.values(parseConfig(f.text()).herdr.profiles)) expect(p.permissions).toBe("full");
  expect(f.agents).toHaveLength(3);
  expect(f.calls.filter((c) => c[1] === "tab").every((c) => c.includes(f.root))).toBe(true);
  expect(f.output()).toContain("herdr agent attach setup-w8-claude");
  expect(f.output()).toContain("main checkout");
  expect(f.calls.some((c) => c.includes("send-keys") || c.includes("run"))).toBe(false);
  expect(f.calls.filter((c) => c[1] === "workspace" && c[2] === "create")[0]).toContain("LINEAR_API_KEY=");
  expect(f.output() + f.errors()).not.toContain("CANARY");
  const count = f.calls.filter((c) => c.includes("start")).length;
  expect(await f.run()).toBe(0);
  expect(f.questions.filter((q) => q.includes("Permissions"))).toHaveLength(1);
  expect(f.calls.filter((c) => c.includes("start"))).toHaveLength(count);
});

test("cancel, invalid choice and concurrent config edits never save full or start harnesses", async () => {
  for (const options of [{ choice: null }, { choice: "yes" }, { choice: "full", changed: true }]) {
    const f = fixture(options);
    expect(await f.run()).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.calls.some((c) => c.includes("start"))).toBe(false);
  }
});

test("JSON and noninteractive setup never ask, save permissions, or start sessions", async () => {
  const f = fixture({ json: true });
  expect(await f.run()).toBe(1);
  expect(f.questions).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.calls).toEqual([]);
  const result = JSON.parse(f.output());
  expect(result.ready).toBe(false);
  expect(result.next).toContain("armada setup local");
});

test("saved explicit decisions survive subsequent setup and remaining questions are reported without answers", async () => {
  const f = fixture({ explicit: true, blocked: true });
  expect(await f.run()).toBe(1);
  expect(f.questions.some((q) => q.includes("Permissions"))).toBe(false);
  expect(f.writes).toEqual([]);
  expect(f.output()).toContain("Codex asks to trust this repository");
  expect(f.output()).toContain("herdr agent attach");
});

test("setup surfaces account/model rejection after the token-free probe without leaking pane content", async () => {
  const f = fixture({ explicit: true, modelProblem: true });
  expect(await f.run()).toBe(1);
  expect(f.output()).toContain("not supported by this ChatGPT account");
  expect(f.output()).not.toContain("CANARY_private");
  expect(
    f.calls.some((c) => c.includes("Reply with OK only. Do not read files, run commands or modify anything.")),
  ).toBe(true);
});

test("edited profile settings cannot be verified by a retained setup session with old arguments", async () => {
  const f = fixture({ explicit: true });
  expect(await f.run()).toBe(0);
  f.edit(f.text().replace('model = "model-a"', 'model = "model-new"'));
  await expect(f.run()).rejects.toThrow("different launch settings");
  expect(f.calls.filter((c) => c.includes("start"))).toHaveLength(3);
  expect(f.calls.filter((c) => c[1] === "pane" && c[2] === "close")).toEqual([["herdr", "pane", "close", "w8:p0"]]);
});

test("OpenCode provider questions are inspected before model checks and keep the setup pane for the owner", async () => {
  const f = fixture({ explicit: true, openCodeQuestion: true });
  expect(await f.run()).toBe(1);
  expect(f.output()).toContain("OpenCode asks the owner to connect a provider");
  expect(f.output()).toContain("herdr agent attach setup-w8-opencode");
  expect(f.calls.some((c) => c[0] === "opencode" && c.includes("--verbose"))).toBe(false);
  expect(f.calls.some((c) => c[1] === "pane" && c[2] === "close" && c[3] === "w8:p3")).toBe(false);
  expect(f.calls.some((c) => c[1] === "agent" && c[2] === "prompt" && c[3] === "w8:p3")).toBe(false);
});

test("setup refuses an OpenCode fallback model before its token-free probe and retains the pane", async () => {
  const f = fixture({ explicit: true, openCodeFallback: true });
  expect(await f.run()).toBe(1);
  expect(f.output()).toContain("model differs from profile provider/model-c");
  expect(f.output()).toContain("herdr agent attach setup-w8-opencode");
  expect(f.calls.some((c) => c[1] === "agent" && c[2] === "prompt" && c[3] === "w8:p3")).toBe(false);
  expect(f.calls.some((c) => c[1] === "pane" && c[2] === "close" && c[3] === "w8:p3")).toBe(false);
});

test("after the owner clears OpenCode setup questions, reuse verifies the profile before probing", async () => {
  const state = { explicit: true, openCodeQuestion: true };
  const f = fixture(state);
  expect(await f.run()).toBe(1);
  state.openCodeQuestion = false;
  expect(await f.run()).toBe(0);
  expect(f.calls.filter((c) => c[1] === "agent" && c[2] === "start")).toHaveLength(3);
  expect(f.output()).toContain("opencode (profile opencode): ready; model answered");
});
