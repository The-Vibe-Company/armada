import { expect, test } from "bun:test";
import { type AgentEvent, reportedTurnUsage } from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { database } from "./support.ts";

test("native usage snapshots replace replays without summing quota or missing values", () => {
  const event = (promptId: string, type: string, data: unknown): AgentEvent => ({
    id: type,
    at: 1,
    promptId,
    kind: "other",
    type,
    data,
  });
  const claude = event("claude", "result", {
    modelUsage: { sonnet: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 4 } },
  });
  const codex = event("codex", "armada/turnUsage", { model: "gpt", inputTokens: 20, outputTokens: 8, cachedTokens: 7 });
  expect(reportedTurnUsage([claude, claude, codex, event("other", "account/rateLimits/updated", {})]).turns).toEqual([
    { promptId: "claude", model: "sonnet", inputTokens: 10, outputTokens: 5, cachedTokens: 4 },
    { promptId: "codex", model: "gpt", inputTokens: 20, outputTokens: 8, cachedTokens: 7 },
  ]);
  expect(
    reportedTurnUsage([event("unknown", "armada/turnUsage", { inputTokens: -1 })]).turns[0]?.inputTokens,
  ).toBeNull();
});

test("real SQL runtime accumulates completed stop/resume intervals and usage follows interior visibility", async () => {
  const { db, people: p } = await database();
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0]!.id;
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat','usage-test','codex','ready')`,
      [id, golden, p.org, p.owner],
    );
    // Deterministic interval endpoints, no elapsed-time assumptions or sleeps.
    await db.query("update sandboxes set usage_running_since='2026-01-01T00:00:00Z' where id=$1", [id]);
    await db.query("update sandboxes set status='stopped',stopped_at='2026-01-01T00:00:10Z' where id=$1", [id]);
    await db.query("update sandboxes set status='ready',stopped_at=null where id=$1", [id]);
    await db.query("update sandboxes set usage_running_since='2026-01-01T00:01:00Z' where id=$1", [id]);
    await db.query("update sandboxes set status='stopped',stopped_at='2026-01-01T00:01:20Z' where id=$1", [id]);
    const store = (userId: string) =>
      createSqlData(db)({ userId, via: "service", orgs: [{ orgId: p.org, role: "member" }] }).sandboxes;
    await store(p.owner).recordUsage!(id, { turnCount: 2, turns: [] });
    expect((await store(p.owner).get(id))?.usage).toEqual({ computeSeconds: 30, turnCount: 2, turns: [] });
    expect((await store(p.owner).list({ limit: 10 })).rows[0]?.usage?.computeSeconds).toBe(30);
    expect((await store(p.member).list({ limit: 10 })).rows[0]?.usage).toBeNull();
    expect(await store(p.member).get(id)).toBeNull();
    await store(p.member).recordUsage!(id, { turnCount: 999, turns: [] });
    expect((await store(p.owner).get(id))?.usage?.turnCount).toBe(2);
  } finally {
    await db.close();
  }
});
