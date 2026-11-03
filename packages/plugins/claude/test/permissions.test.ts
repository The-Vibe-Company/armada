import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaunchRequest, NodeProvider } from "@armada/plugin-api";
import { claudeRuntime } from "../src/index.ts";

for (const [options, args, mode] of [
  [{}, [], "bypassPermissions"],
  [{ permissionMode: "acceptEdits" }, [], "acceptEdits"],
  [{ permissionMode: "default" }, [], "default"],
  [{ args: ["--permission-mode", "bypassPermissions"] }, [], "bypassPermissions"],
  [{ args: ["--permission-mode=default"] }, [], "default"],
  [{}, ["--permission-mode", "acceptEdits"], "acceptEdits"],
  [{ args: ["--dangerously-skip-permissions"] }, [], "skip"],
] as const) {
  test(`Claude launches with one effective permission mode: ${JSON.stringify(options)} ${args}`, async () => {
    let launched: LaunchRequest | undefined;
    const node: NodeProvider = {
      prepare: async () => ({ id: "one", path: "/fixture/worktree", node: "local" }),
      launch: async (request) => {
        launched = request;
        return { ...request.worker, handle: "one" };
      },
      observe: async () => ({ state: "running" }),
      deliver: async () => {},
      stop: async () => {},
    };
    const runtime = claudeRuntime({ ...options, ...("args" in options ? { args: [...options.args] } : {}) }, node);
    const workspace = await runtime.prepare({
      project: "orchard",
      ticket: "ORC-1",
      repository: "/fixture",
      branch: "worker",
    });
    await runtime.launch({
      workspace,
      worker: { project: "orchard", ticket: "ORC-1", session: "one", generation: 1 },
      command: "",
      args: [...args],
      env: {},
    });
    assert(launched);
    const cliArgs: string[] = JSON.parse(launched.args.at(-1)!).args;
    const flags = cliArgs.filter(
      (a) => a === "--permission-mode" || a.startsWith("--permission-mode=") || a === "--dangerously-skip-permissions",
    );
    assert.equal(flags.length, 1);
    if (mode !== "skip") assert(cliArgs.includes(mode) || cliArgs.includes(`--permission-mode=${mode}`));
    assert(cliArgs.includes("--add-dir"));
    assert(cliArgs.includes(workspace.path));
  });
}
