import { expect, test } from "bun:test";
import type { SandboxView, ServerSandboxStore } from "../src/data.ts";
import { readStatus } from "../src/turns.ts";
import { fakeBoat } from "./support.ts";

test("running status exposes rate-limit wait without settling or failing the turn", async () => {
  const boat = fakeBoat();
  const provider = boat.providerFor("placeholder");
  const native = await provider.fork({ from: "snapshot" });
  const receipt = await provider.prompt({ sandboxId: native.id, harness: "codex", text: "work" });
  boat.sandbox(native.id).events.push({
    id: "wait",
    at: 1000,
    promptId: receipt.promptId,
    kind: "other",
    type: "armada/modelRateLimit",
    data: { retryCount: 2, delayMs: 20_000, totalWaitMs: 21_000 },
  });
  const sandbox = {
    id: "sandbox",
    providerSandboxId: native.id,
    status: "running",
    statusReason: null,
    stoppedAt: null,
    taskPromptId: receipt.promptId,
    model: "kimi",
    conversationIds: [],
  } as unknown as SandboxView;
  const store = {
    readTurnModel: async () => ({ requestedModel: "kimi", evidence: null }),
  } as unknown as ServerSandboxStore;
  const report = await readStatus(provider, store, sandbox, { now: new Date(2000), stored: true });
  expect(report).toMatchObject({
    status: "running",
    settled: false,
    prompt: {
      state: "running",
      rateLimit: {
        waiting: true,
        retryCount: 2,
        totalWaitMs: 21_000,
        message: "Rate limited by the model provider, retrying in 19 s",
      },
    },
  });
});
