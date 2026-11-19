import { expect, test } from "bun:test";
import type { SandboxPatch } from "@armada/core";
import type { SandboxView, ServerSandboxStore } from "../src/data.ts";
import { readStatus } from "../src/turns.ts";
import { fakeBoat } from "./support.ts";

test.each([true, false])(
  "live status preserves the finish reason and gates a Boat stop on retention (%s)",
  async (usable) => {
    const boat = fakeBoat();
    const provider = boat.providerFor("placeholder");
    const native = await provider.fork({ from: "snapshot" });
    await provider.stop({ sandboxId: native.id });
    if (!usable) boat.sandbox(native.id).info.retainedSnapshot = "pending";
    const sandbox = {
      id: "sandbox",
      providerSandboxId: native.id,
      status: "ready",
      statusReason: "agent_finished",
      stoppedAt: null,
      taskPromptId: null,
      conversationIds: [],
    } as unknown as SandboxView;
    const patches: SandboxPatch[] = [];
    const store = {
      update: async (_id: string, patch: SandboxPatch) => {
        patches.push(patch);
      },
    } as unknown as ServerSandboxStore;
    expect(await readStatus(provider, store, sandbox, { now: new Date(2000) })).toMatchObject({
      status: usable ? "stopped" : "stopping",
      settled: usable,
      statusReason: "agent_finished",
    });
    expect(patches).toEqual(
      usable ? [expect.objectContaining({ status: "stopped", statusReason: "agent_finished" })] : [],
    );
  },
);

test.each([
  { provider: "boat", machine: "running", prompt: "finished" },
  { provider: "modal", machine: "ready", prompt: "running" },
] as const)("live $provider runtime status reports $prompt without changing the machine", async (scenario) => {
  const boat = fakeBoat();
  const provider = { ...boat.provider, id: scenario.provider };
  const machine = await provider.fork({ from: "snapshot" });
  const turn = await provider.prompt({ sandboxId: machine.id, harness: "codex", text: "work" });
  if (scenario.prompt === "finished") boat.finish(machine.id, turn.promptId, "finished");

  const sandbox = {
    id: "sandbox",
    provider: scenario.provider,
    boatRuntime: scenario.provider === "boat",
    runtimeTransport: scenario.provider === "modal" ? "dialout" : undefined,
    harness: "codex",
    providerSandboxId: machine.id,
    status: scenario.machine,
    statusReason: null,
    lifecycleGeneration: 2,
    stoppedAt: null,
    taskPromptId: turn.promptId,
    conversationIds: [],
  } as unknown as SandboxView;
  const updates: SandboxPatch[] = [];
  const store = {
    update: async (_id: string, patch: SandboxPatch) => {
      updates.push(patch);
    },
  } as unknown as ServerSandboxStore;

  expect(await readStatus(provider, store, sandbox, { now: new Date(2000) })).toMatchObject({
    status: scenario.machine,
    settled: scenario.prompt === "finished",
    prompt: { state: scenario.prompt },
  });
  expect(updates).toEqual([]);
});
