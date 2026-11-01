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
  let output = `${JSON.stringify({
    type: "result",
    uuid: "known",
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })}\n`;
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
    incomplete: true,
    model: null,
    provider: "anthropic",
  });
  output += `${JSON.stringify({ type: "result", uuid: "unknown" })}\n`;
  assert.deepEqual((await runtime.observe(ref)).usage, {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    incomplete: true,
    model: null,
    provider: "anthropic",
  });
  output += `${JSON.stringify({
    type: "result",
    uuid: "recovered",
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })}\n`;
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

test("whole-tree Claude snapshots replace prior totals, recover partial usage and survive clear", async () => {
  const ref: WorkerRef = { project: "orchard", ticket: "SEED-1", session: "one", generation: 1, handle: "local/one" };
  let output = "";
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
  const model = (input: number, out: number) => ({
    inputTokens: input,
    outputTokens: out,
    cacheReadInputTokens: 40,
    cacheCreationInputTokens: 5,
  });
  const result = async (uuid: string, fields: object) => {
    output += `${JSON.stringify({ type: "result", uuid, session_id: "first", ...fields })}\n`;
    return (await runtime.observe(ref)).usage;
  };
  await result("old-cli", { usage: { input_tokens: 10, output_tokens: 1 } });
  const first = await result("whole-tree", {
    usage: { input_tokens: 10, output_tokens: 1 },
    modelUsage: { oak: model(100, 20), sapling: model(50, 10) },
  });
  assert.deepEqual(first, {
    input: 150,
    output: 30,
    cacheRead: 80,
    cacheWrite: 10,
    model: "oak, sapling",
    provider: "anthropic",
  });
  assert.deepEqual(await result("whole-tree", { modelUsage: { oak: model(100, 20), sapling: model(50, 10) } }), first);
  assert.deepEqual(await result("next-turn", { modelUsage: { oak: model(200, 30), sapling: model(50, 10) } }), {
    input: 250,
    output: 40,
    cacheRead: 80,
    cacheWrite: 10,
    model: "oak, sapling",
    provider: "anthropic",
  });
  const partial = await result("crash", { modelUsage: { oak: { inputTokens: 0, outputTokens: 0 } } });
  assert.deepEqual(partial, {
    input: 250,
    output: 40,
    cacheRead: 80,
    cacheWrite: 10,
    model: "oak",
    provider: "anthropic",
    incomplete: true,
  });
  // A later complete cumulative snapshot fills the missing reading without summing it twice.
  await result("recovered", { modelUsage: { oak: model(300, 50), sapling: model(50, 10) } });
  const beforeClear = (await runtime.observe(ref)).usage;
  const reset = `${JSON.stringify({
    type: "conversation_reset",
    uuid: "reset-1",
    session_id: "first",
    new_conversation_id: "second",
    trigger: "clear",
  })}\n`;
  output += reset;
  assert.deepEqual((await runtime.observe(ref)).usage, beforeClear);
  // The documented reset frame is sufficient; older streams omit local_command.
  assert.deepEqual(await result("after-clear", { session_id: "second", modelUsage: { oak: model(20, 2) } }), {
    input: 370,
    output: 62,
    cacheRead: 120,
    cacheWrite: 15,
    model: "oak",
    provider: "anthropic",
  });
  output += reset; // A repeated reset frame must not roll the offset forward again.
  assert.deepEqual(await result("next-after-clear", { session_id: "second", modelUsage: { oak: model(40, 4) } }), {
    input: 390,
    output: 64,
    cacheRead: 120,
    cacheWrite: 15,
    model: "oak",
    provider: "anthropic",
  });
  // Bounded stdout may omit the reset frame; a new result session still fences the counters.
  assert.deepEqual(await result("new-session", { session_id: "third", modelUsage: { oak: model(10, 1) } }), {
    input: 400,
    output: 65,
    cacheRead: 160,
    cacheWrite: 20,
    model: "oak",
    provider: "anthropic",
  });
});

test("zeroed Claude crash results are unknown, retaining an earlier known floor as partial", async () => {
  for (const usage of [
    undefined,
    { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ]) {
    const ref: WorkerRef = { project: "orchard", ticket: "SEED-1", session: "one", generation: 1, handle: "local/one" };
    let output = "";
    const node: NodeProvider = {
      prepare: async () => ({ id: "one", path: "/fixture", node: "local" }),
      launch: async () => ref,
      deliver: async () => {},
      stop: async () => {},
      observe: async () => ({ state: "running", reply: output }),
    };
    const runtime = claudeRuntime({}, node);
    await runtime.launch({
      workspace: { id: "one", path: "/fixture", node: "local" },
      worker: ref,
      command: "",
      args: [],
      env: {},
    });
    const crash = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      usage,
      modelUsage: { oak: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    };
    output = `${JSON.stringify({ ...crash, uuid: "first-crash" })}\n`;
    assert.deepEqual(
      (await runtime.observe(ref)).usage,
      usage
        ? { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, model: "oak", provider: "anthropic", incomplete: true }
        : "unknown",
    );
    output += `${JSON.stringify({ type: "conversation_reset", uuid: "reset-after-crash", session_id: "one", new_conversation_id: "two", trigger: "clear" })}\n`;
    await runtime.observe(ref);
    output += `${JSON.stringify({
      type: "result",
      uuid: "known",
      modelUsage: { oak: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 1 } },
    })}\n`;
    // Complete counters after the reset cannot recover the unknown earlier segment.
    const afterReset = (await runtime.observe(ref)).usage;
    assert.notEqual(afterReset, "unknown");
    assert.equal(afterReset && typeof afterReset === "object" && afterReset.incomplete, true);
    output += `${JSON.stringify({ ...crash, uuid: "last-crash" })}\n`;
    assert.deepEqual((await runtime.observe(ref)).usage, {
      input: usage ? 16 : 10,
      output: usage ? 4 : 2,
      cacheRead: 3,
      cacheWrite: 1,
      incomplete: true,
      model: "oak",
      provider: "anthropic",
    });
  }
});
