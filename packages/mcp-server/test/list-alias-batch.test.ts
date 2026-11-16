import { expect, test } from "bun:test";
import { encryptSecret, type Sql } from "@armada/core/server";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

test("list batches public usage identities across a full page without per-sandbox data calls", async () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const receipt = await encryptSecret(JSON.stringify({ promptId: "native_prompt" }), key);
  for (const size of [1, 200]) {
    let reads = 0;
    const rows = Array.from({ length: size }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      orgId: "org",
      ownerId: "owner",
      provider: "modal",
      harness: "codex",
      providerSandboxId: null,
      boatId: null,
      model: null,
      reasoningEffort: null,
      status: "ready",
      createdAt: new Date(0).toISOString(),
      stoppedAt: null,
      expiresAt: null,
      effectiveTtlSeconds: null,
      machineSize: null,
      displayLabel: "fixture",
      canOpen: true,
      canManage: true,
      usage: {
        computeSeconds: 0,
        turnCount: 1,
        turns: [{ promptId: "native_prompt", model: "model", inputTokens: 1, outputTokens: 1, cachedTokens: 0 }],
      },
    }));
    const queue = createAccountTurnQueue(
      {
        query: async () => {
          reads++;
          return {
            rows: rows.map((row) => ({ sandbox_id: row.id, request_id: `public_${row.id}`, result_enc: receipt })),
          };
        },
      } as unknown as Sql,
      key,
    );
    const context = {
      caller: { userId: "owner", orgs: [{ orgId: "org", role: "member" }] },
      accountTurns: queue,
      data: {
        sandboxes: {
          list: async () => {
            reads++;
            return { rows, total: size };
          },
        },
      },
      now: () => new Date(0),
    } as unknown as ToolContext;
    const result = (await callSharedTool(context, "list", { limit: 200 })) as { sandboxes: typeof rows };
    expect(reads).toBe(2);
    expect(result.sandboxes).toHaveLength(size);
    for (const row of result.sandboxes) expect(row.usage.turns[0]!.promptId).toBe(`public_${row.id}`);
  }
});
