import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaunchRequest, NodeProvider } from "@armada/plugin-api";
import { claudeRuntime, HEADLESS_VARIABLE } from "../src/index.ts";

async function launchWith(env: Record<string, string>): Promise<LaunchRequest> {
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
  const runtime = claudeRuntime({}, node);
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
    args: [],
    env,
  });
  assert(launched);
  return launched;
}

test("every local Claude worker launches with the desktop shell's headless flag; the daemon's variables stay", async () => {
  const launched = await launchWith({ ARMADA_TICKET: "ORC-1", ARMADA_WORKER_SOCKET: "/fixture/armada.sock" });
  assert.equal(HEADLESS_VARIABLE, "ARMADA_DESKTOP_HEADLESS");
  assert.deepEqual(launched.env, {
    ARMADA_DESKTOP_HEADLESS: "1",
    ARMADA_TICKET: "ORC-1",
    ARMADA_WORKER_SOCKET: "/fixture/armada.sock",
  });
});

test("an explicit launch environment keeps its own value of the headless flag", async () => {
  const launched = await launchWith({ ARMADA_DESKTOP_HEADLESS: "0" });
  assert.equal(launched.env.ARMADA_DESKTOP_HEADLESS, "0");
});
