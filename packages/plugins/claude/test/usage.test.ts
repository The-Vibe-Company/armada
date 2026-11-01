import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeProvider, WorkerRef } from "@armada/plugin-api";
import { claudeRuntime } from "../src/index.ts";

test("Claude meters completed stream turns once, retains missing counters and captures the final exit", async () => {
  const ref: WorkerRef = { project: "orchard", ticket: "SEED-1", session: "one", generation: 1, handle: "local/one" };
  let output = "";
  let state: "running" | "stopped" = "running";
  const node: NodeProvider = {
    prepare: async () => ({ id: "one", path: "/fixture", node: "local" }),
    launch: async () => ref,
    deliver: async () => {},
    observe: async () => ({ state, reply: output }),
    stop: async () => {
      state = "stopped";
    },
  };
  const runtime = claudeRuntime({}, node);
  await runtime.launch({
    workspace: await node.prepare({
      project: "orchard",
      ticket: "SEED-1",
      repository: "example/orchard",
      branch: "worker/one",
    }),
    worker: ref,
    command: "",
    args: [],
    env: {},
  });
  assert.equal((await runtime.observe(ref)).usage, "unknown");
  const first = {
    type: "result",
    uuid: "turn-1",
    result: "done",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 },
    modelUsage: { oak: {} },
  };
  output = `${JSON.stringify(first)}\n`;
  const known = (await runtime.observe(ref)).usage;
  assert.deepEqual(known, {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: null,
    incomplete: true,
    model: "oak",
    provider: "anthropic",
  });
  assert.deepEqual((await runtime.observe(ref)).usage, known);
  output += `${JSON.stringify(first)}\n`; // CLI duplicate result UUID, not a second turn.
  assert.deepEqual((await runtime.observe(ref)).usage, known);
  output += `${JSON.stringify({ type: "result", uuid: "turn-2", usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 7 } })}\n`;
  await runtime.stop(ref);
  assert.deepEqual((await runtime.observe(ref)).usage, {
    input: 150,
    output: 30,
    cacheRead: 30,
    cacheWrite: 7,
    incomplete: true,
    model: "oak",
    provider: "anthropic",
  });
});

test("a completion missing all usage after a metered completion leaves the generation unknown", async () => {
  const ref: WorkerRef = { project: "orchard", ticket: "SEED-1", session: "one", generation: 1, handle: "local/one" };
  let output =
    JSON.stringify({
      type: "result",
      uuid: "known",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }) + "\n";
  const node: NodeProvider = {
    prepare: async () => ({ id: "one", path: "/fixture", node: "local" }),
    launch: async () => ref,
    deliver: async () => {},
    observe: async () => ({ state: "running", reply: output }),
    stop: async () => {},
  };
  const runtime = claudeRuntime({}, node);
  await runtime.launch({
    workspace: { id: "one", path: "/fixture", node: "local" },
    worker: ref,
    command: "",
    args: [],
    env: {},
  });
  assert.deepEqual((await runtime.observe(ref)).usage, {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    model: null,
    provider: "anthropic",
  });
  output += JSON.stringify({ type: "result", uuid: "unknown" }) + "\n";
  assert.deepEqual((await runtime.observe(ref)).usage, {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    incomplete: true,
    model: null,
    provider: "anthropic",
  });
  output +=
    JSON.stringify({
      type: "result",
      uuid: "recovered",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }) + "\n";
  assert.deepEqual((await runtime.observe(ref)).usage, {
    input: 4,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    incomplete: true,
    model: null,
    provider: "anthropic",
  });
});
