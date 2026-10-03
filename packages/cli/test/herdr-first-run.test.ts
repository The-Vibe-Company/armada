import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Herdr } from "../src/herdr.ts";
import type { Io } from "../src/io.ts";

const handle = { workspace: "w8", pane: "w8:p9", agent: "demo-7", path: "/work/worktrees/demo-7" };
const profile = { harness: "claude", model: "model-a", effort: "high", extraArgs: [] } as const;
function fake(screens: string[], options: { startCode?: string; otherPane?: boolean; state?: string } = {}) {
  const calls: string[][] = [];
  let time = 0;
  const io = {
    cwd: "/work/widgets",
    env: {},
    now: () => new Date(time),
    sleep: async (ms: number) => {
      time += ms;
    },
    exec: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args[1] === "start" && options.startCode)
        return {
          code: 1,
          stdout: JSON.stringify({ error: { code: options.startCode, message: "CANARY_private" } }),
          stderr: "",
        };
      if (args[0] === "pane" && args[1] === "read")
        return { code: 0, stdout: screens.shift() ?? "Ready\n> ", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            agent: {
              name: handle.agent,
              workspace_id: handle.workspace,
              pane_id: options.otherPane ? "w9:p1" : handle.pane,
              agent_status: options.state ?? "idle",
              interactive_ready: true,
            },
          },
        }),
        stderr: "",
      };
    },
  } as unknown as Io;
  return { io, calls };
}

test("startup diagnoses recorded questions even when herdr returns agent_not_ready", async () => {
  const screen = await readFile(new URL("./fixtures/first-run/claude-trust.txt", import.meta.url), "utf8");
  const f = fake([screen], { startCode: "agent_not_ready", state: "blocked" });
  await expect(new Herdr(f.io).startChecked(handle, { ...profile, extraArgs: [] })).rejects.toThrow(
    "Claude Code asks to trust this folder: run armada setup local",
  );
  expect(f.calls.filter((c) => c[1] === "pane").map((c) => c[3])).toEqual([handle.pane]);
  expect(f.calls.some((c) => c.includes("send-keys") || c.includes("run"))).toBe(false);
});

test("questions missed by native idle detection are inspected before brief delivery", async () => {
  const f = fake(["2 new MCP servers found in this project"]);
  await expect(new Herdr(f.io).startChecked(handle, { ...profile, extraArgs: [] })).rejects.toThrow(
    "project MCP servers",
  );
  expect(f.calls.some((c) => c.includes("prompt"))).toBe(false);
});

test("never reads pane text after the runtime returns a different worker identity", async () => {
  const f = fake(["Yes, I trust this folder"], { otherPane: true });
  await expect(new Herdr(f.io).inspect(handle, "claude")).rejects.toThrow("agent response");
  expect(f.calls.some((c) => c.includes("read"))).toBe(false);
});

test("unknown blocked and timed-out startup screens retain actionable attach commands", async () => {
  for (const state of ["blocked", "unknown"]) {
    const f = fake([], { state, startCode: "agent_not_ready" });
    await expect(new Herdr(f.io).startChecked(handle, { ...profile, extraArgs: [] })).rejects.toThrow(
      "herdr agent attach demo-7",
    );
    expect(f.calls.length).toBeLessThan(250);
  }
});
