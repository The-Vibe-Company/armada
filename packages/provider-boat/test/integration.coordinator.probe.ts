import assert from "node:assert/strict";
import { type AgentEvent, isFinalPromptStatus, type Provider } from "@armada/core";
import { createBoatProvider } from "../src/provider.ts";

const apiKey = process.env.BOAT_API_KEY;
if (!apiKey || process.env.ARMADA_RUN_LIVE_BOAT_TESTS !== "1") {
  throw new Error("The Boat integration probe requires BOAT_API_KEY and ARMADA_RUN_LIVE_BOAT_TESTS=1.");
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await wait(1000);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function ready(provider: Provider, sandboxId: string) {
  await until(
    `${sandboxId} to be ready`,
    async () => {
      const info = await provider.get(sandboxId);
      if (info.state === "failed") throw new Error(`${sandboxId} failed: ${info.error ?? info.providerState}`);
      return info.state === "ready" || info.state === "running" ? info : undefined;
    },
    120_000,
  );
}

const boundedFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const timeout = AbortSignal.timeout(120_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  },
  { preconnect: fetch.preconnect },
);

const provider = createBoatProvider({
  apiKey,
  fetch: boundedFetch,
  ...(process.env.BOAT_BASE_URL ? { baseUrl: process.env.BOAT_BASE_URL } : {}),
});
const cleanup: Array<() => Promise<unknown>> = [];
try {
  let snapshot = process.env.BOAT_TEST_SNAPSHOT;
  if (!snapshot) {
    const name = `armada-it-${Date.now().toString(36)}`;
    const golden = await provider.createGolden({ name, ttlSeconds: 1800 });
    cleanup.push(() => provider.delete({ sandboxId: golden.id }));
    await ready(provider, golden.id);
    await provider.snapshot({ sandboxId: golden.id, name });
    cleanup.push(() => provider.deleteSnapshot(name));
    await until(
      `snapshot ${name}`,
      async () => {
        const info = await provider.getSnapshot(name);
        if (info.status === "failed") throw new Error(`snapshot failed: ${info.error}`);
        return info.status === "ready" ? info : undefined;
      },
      600_000,
    );
    snapshot = name;
  }

  const sandbox = await provider.fork({
    from: snapshot,
    ttlSeconds: 1800,
    labels: { armada: "integration-test" },
    idempotencyKey: crypto.randomUUID(),
  });
  cleanup.push(() => provider.delete({ sandboxId: sandbox.id }));
  assert.equal(sandbox.state, "starting");
  await ready(provider, sandbox.id);

  const echoed = await provider.exec({ sandboxId: sandbox.id, command: "echo armada" });
  assert.equal(echoed.detached, false);
  assert.equal(echoed.exitCode, 0);

  const receipt = await provider.prompt({
    sandboxId: sandbox.id,
    harness: "claude",
    text: "Reply with exactly the word: pong. Do not use any tool.",
  });
  assert.ok(receipt.conversationId, "Expected a conversation ID");

  const seen: AgentEvent[] = [];
  let cursor: string | undefined;
  await until(
    "the prompt to end",
    async () => {
      const page = await provider.events({
        sandboxId: sandbox.id,
        conversationId: receipt.conversationId,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.events);
      cursor = page.cursor ?? cursor;
      const state = await provider.getPrompt({ sandboxId: sandbox.id, promptId: receipt.promptId });
      return isFinalPromptStatus(state.status) && !page.hasMore ? state : undefined;
    },
    300_000,
  );
  assert.ok(
    seen.some((event) => event.kind === "prompt"),
    "Expected a prompt event",
  );
  assert.ok(
    seen.some((event) => event.kind === "message" && !event.partial && /pong/i.test(event.text)),
    "Expected a complete pong message",
  );

  const again = await provider.events({ sandboxId: sandbox.id, ...(cursor ? { cursor } : {}) });
  assert.deepEqual(again.events, []);

  await provider.stop({ sandboxId: sandbox.id });
  await until(
    "the sandbox to stop",
    async () => ((await provider.get(sandbox.id)).state === "stopped" ? true : undefined),
    180_000,
  );
} finally {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
}
console.log("Boat integration probe passed.");
