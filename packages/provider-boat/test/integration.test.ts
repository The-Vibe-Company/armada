/**
 * Opt-in: talks to the real boat.dev, starts billed sandboxes and spends model credits.
 *
 * Requires explicit compute consent as well as BOAT_API_KEY; a key alone never enables this test.
 * With BOAT_API_KEY already exported, opt in to billed compute and model usage:
 *
 *   ARMADA_RUN_LIVE_BOAT_TESTS=1 bun test packages/provider-boat/test/integration.test.ts
 *
 * Needs Claude Code configured on the boat account (dashboard, Agents & Proxying).
 * BOAT_TEST_SNAPSHOT names an existing saved snapshot to fork; without it the test builds a throwaway one from a
 * blank sandbox (a saved snapshot is not available on the free trial). BOAT_BASE_URL points at another API.
 */
import { expect, test } from "bun:test";
import { type AgentEvent, isFinalPromptStatus, type Provider } from "@armada/core";
import { createBoatProvider } from "../src/provider.ts";

const apiKey = process.env.BOAT_API_KEY;
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

test.skipIf(!apiKey || process.env.ARMADA_RUN_LIVE_BOAT_TESTS !== "1")(
  "fork a snapshot, prompt Claude Code, read its events by cursor, stop",
  async () => {
    const provider = createBoatProvider({
      apiKey: apiKey as string,
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
      expect(sandbox.state).toBe("starting");
      await ready(provider, sandbox.id);

      const echoed = await provider.exec({ sandboxId: sandbox.id, command: "echo armada" });
      expect(echoed).toMatchObject({ detached: false, exitCode: 0 });

      const receipt = await provider.prompt({
        sandboxId: sandbox.id,
        harness: "claude",
        text: "Reply with exactly the word: pong. Do not use any tool.",
      });
      expect(receipt.conversationId).toBeTruthy();

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
      expect(seen.some((event) => event.kind === "prompt")).toBe(true);
      expect(seen.some((event) => event.kind === "message" && !event.partial && /pong/i.test(event.text))).toBe(true);

      const again = await provider.events({ sandboxId: sandbox.id, ...(cursor ? { cursor } : {}) });
      expect(again.events).toEqual([]);

      await provider.stop({ sandboxId: sandbox.id });
      await until(
        "the sandbox to stop",
        async () => ((await provider.get(sandbox.id)).state === "stopped" ? true : undefined),
        180_000,
      );
    } finally {
      for (const step of cleanup.reverse()) await step().catch(() => undefined);
    }
  },
  1_200_000,
);
