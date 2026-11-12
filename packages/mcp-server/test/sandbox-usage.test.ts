import { expect, test } from "bun:test";
import { type AgentEvent, reportedTurnUsage, usageUnavailableReason } from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { collectSandboxUsage, readStatus } from "../src/turns.ts";
import { database, fakeBoat } from "./support.ts";

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
    {
      promptId: "claude",
      model: "sonnet",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 4,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
    {
      promptId: "codex",
      model: "gpt",
      inputTokens: 20,
      outputTokens: 8,
      cachedTokens: 7,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
  ]);
  expect(
    reportedTurnUsage([event("unknown", "armada/turnUsage", { inputTokens: -1 })]).turns[0]?.inputTokens,
  ).toBeNull();
});

// The extractor owns native-field mapping; SQL/replay tests below own persistence and visibility.
test.each([
  {
    total: 0,
    detail: { cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0 },
    expected: { fiveMinute: 0, oneHour: 0 },
  },
  {
    total: 10,
    detail: { cacheCreationEphemeral5mInputTokens: 6, cacheCreationEphemeral1hInputTokens: 4 },
    expected: { fiveMinute: 6, oneHour: 4 },
  },
  {
    total: 10,
    detail: { cacheCreationEphemeral5mInputTokens: 3, cacheCreationEphemeral1hInputTokens: 2 },
    expected: { fiveMinute: 3, oneHour: 2 },
  },
  { total: 10, detail: { cacheCreationEphemeral5mInputTokens: 0 }, expected: { fiveMinute: 0, oneHour: null } },
  {
    total: 10,
    detail: { cacheCreationEphemeral5mInputTokens: 8, cacheCreationEphemeral1hInputTokens: 3 },
    expected: { fiveMinute: null, oneHour: null },
  },
  {
    total: 10,
    detail: { cacheCreationEphemeral5mInputTokens: -1, cacheCreationEphemeral1hInputTokens: 0 },
    expected: { fiveMinute: null, oneHour: null },
  },
  {
    total: null,
    detail: { cacheCreationEphemeral5mInputTokens: 2, cacheCreationEphemeral1hInputTokens: 0 },
    expected: { fiveMinute: null, oneHour: null },
  },
])(
  "Claude cache-write lifetimes preserve known subsets without inventing missing tokens (%j)",
  ({ total, detail, expected }) => {
    const event: AgentEvent = {
      id: "result",
      at: 1,
      promptId: "p",
      kind: "other",
      type: "result",
      data: {
        modelUsage: {
          sonnet: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: total,
            ...detail,
          },
        },
      },
    };
    expect(reportedTurnUsage([event, event]).turns).toEqual([
      {
        promptId: "p",
        model: "sonnet",
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        cacheWriteTokens: total,
        reasoningTokens: null,
        cacheWriteTokensByTtl: expected,
      },
    ]);
  },
);

test("real SQL runtime includes open and completed intervals and usage follows interior visibility", async () => {
  const { db, people: p } = await database();
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0]!.id;
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat','usage-test','claude','ready')`,
      [id, golden, p.org, p.owner],
    );
    // Read open intervals at the same statement timestamp as their explicit endpoints.
    await db.query("begin");
    try {
      const activeUsage = async (seconds: number, offset: number) =>
        (
          await db.query<{ usage: { computeSeconds: number | null } }>(
            `update sandboxes set usage_runtime_seconds=$2,
              usage_running_since=statement_timestamp() - $3 * interval '1 second'
              where id=$1 returning public.sandbox_usage(sandboxes) as usage`,
            [id, seconds, offset],
          )
        ).rows[0]?.usage.computeSeconds;
      expect(await activeUsage(0, 12)).toBe(12);
      expect(await activeUsage(7, 12)).toBe(19);
      expect(await activeUsage(7, -12)).toBe(7);
      await db.query("update sandboxes set usage_runtime_seconds=null where id=$1", [id]);
      expect(
        (
          await db.query<{ usage: { computeSeconds: number | null } }>(
            "select public.sandbox_usage(sandboxes) as usage from sandboxes where id=$1",
            [id],
          )
        ).rows[0]?.usage.computeSeconds,
      ).toBeNull();
    } finally {
      await db.query("rollback");
    }
    // Deterministic interval endpoints, no elapsed-time assumptions or sleeps.
    await db.query("update sandboxes set usage_running_since='2026-01-01T00:00:00Z' where id=$1", [id]);
    await db.query("update sandboxes set status='stopped',stopped_at='2026-01-01T00:00:10Z' where id=$1", [id]);
    // The actual send path reserves starting before publishing running.
    await db.query("update sandboxes set status='starting',stopped_at=null where id=$1", [id]);
    await db.query("update sandboxes set status='running' where id=$1", [id]);
    await db.query("update sandboxes set usage_running_since='2026-01-01T00:01:00Z' where id=$1", [id]);
    await db.query("update sandboxes set status='stopped',stopped_at='2026-01-01T00:01:20Z' where id=$1", [id]);
    const store = (userId: string) =>
      createSqlData(db)({ userId, via: "service", orgs: [{ orgId: p.org, role: "member" }] }).sandboxes;
    const turns = [
      {
        promptId: "claude",
        model: "sonnet",
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        cacheWriteTokens: 3,
        cacheWriteTokensByTtl: { fiveMinute: 2, oneHour: 1 },
      },
    ];
    await store(p.owner).recordUsage!(id, { turnCount: 2, turns });
    expect((await store(p.owner).get(id))?.usage).toMatchObject({ computeSeconds: 30, turnCount: 2, turns });
    expect((await store(p.owner).list({ limit: 10 })).rows[0]?.usage?.turns).toEqual(turns);
    // A late stale writer cannot lower lifetime subsets or erase them with an older CLI result.
    await store(p.owner).recordUsage!(id, {
      turnCount: 2,
      turns: [{ ...turns[0]!, cacheWriteTokens: 2, cacheWriteTokensByTtl: { fiveMinute: 1, oneHour: 1 } }],
    });
    const { cacheWriteTokensByTtl: _ttl, ...legacy } = turns[0]!;
    await store(p.owner).recordUsage!(id, { turnCount: 2, turns: [legacy] });
    expect((await store(p.owner).get(id))?.usage?.turns).toEqual(turns);
    // Conflicting non-monotone lifetime observations must not manufacture an overfull split.
    await store(p.owner).recordUsage!(id, {
      turnCount: 2,
      turns: [{ ...turns[0]!, cacheWriteTokensByTtl: { fiveMinute: 0, oneHour: 3 } }],
    });
    const conflicted = [
      { ...turns[0]!, cacheWriteTokensByTtl: { fiveMinute: null, oneHour: null, conflicted: true as const } },
    ];
    expect((await store(p.owner).get(id))?.usage?.turns).toMatchObject([
      { cacheWriteTokensByTtl: { fiveMinute: null, oneHour: null } },
    ]);
    // Neither original observation (nor an older CLI row) is new evidence resolving the conflict.
    for (const replay of [turns[0]!, { ...turns[0]!, cacheWriteTokensByTtl: { fiveMinute: 0, oneHour: 3 } }, legacy]) {
      await store(p.owner).recordUsage!(id, { turnCount: 2, turns: [replay] });
      expect((await store(p.owner).get(id))?.usage?.turns).toMatchObject([
        { cacheWriteTokensByTtl: { fiveMinute: null, oneHour: null } },
      ]);
    }
    expect((await store(p.owner).get(id))?.usage?.turns).toEqual(conflicted);
    // Unknown detail is not itself contradictory: later valid native data can fill it.
    const lateDetail = { ...turns[0]!, promptId: "late-detail" };
    await store(p.owner).recordUsage!(id, {
      turnCount: 2,
      turns: [{ ...lateDetail, cacheWriteTokens: null, cacheWriteTokensByTtl: { fiveMinute: null, oneHour: null } }],
    });
    await store(p.owner).recordUsage!(id, { turnCount: 2, turns: [lateDetail] });
    expect((await store(p.owner).get(id))?.usage?.turns.find((row) => row.promptId === "late-detail")).toEqual(
      lateDetail,
    );
    expect((await store(p.owner).list({ limit: 10 })).rows[0]?.usage?.computeSeconds).toBe(30);
    // Stop's activity reservation clears stoppedAt even for an already stopped sandbox.
    await store(p.owner).update(id, { status: "stopping", stoppedAt: null });
    await store(p.owner).update(id, { status: "stopped", stoppedAt: "2026-01-01T00:02:00Z" });
    expect((await store(p.owner).get(id))?.usage?.computeSeconds).toBe(30);
    // ReadStatus can discover a provider-side resume without a known start boundary.
    await store(p.owner).update(id, { status: "ready", stoppedAt: null });
    expect((await store(p.owner).get(id))?.usage?.computeSeconds).toBeNull();
    // Reset only the test's tracked interval to independently prove a missed-stop resume.
    await db.query(
      "update sandboxes set usage_runtime_seconds=30,usage_running_since=null,status='stopped',stopped_at='2026-01-01T00:02:00Z' where id=$1",
      [id],
    );
    // A missed physical stop cannot be silently included in a later resumed interval.
    await store(p.owner).update(id, { status: "starting", stoppedAt: null });
    await store(p.owner).update(id, { status: "running" });
    await store(p.owner).update(id, { status: "starting", stoppedAt: null });
    await store(p.owner).update(id, { status: "running" });
    await store(p.owner).update(id, { status: "stopped", stoppedAt: "2026-01-01T00:03:00Z" });
    expect((await store(p.owner).get(id))?.usage?.computeSeconds).toBeNull();
    expect((await store(p.member).list({ limit: 10 })).rows[0]?.usage).toBeNull();
    expect(await store(p.member).get(id)).toBeNull();
    await store(p.member).recordUsage!(id, { turnCount: 999, turns: [] });
    expect((await store(p.owner).get(id))?.usage?.turnCount).toBe(2);
  } finally {
    await db.close();
  }
});

test("native collection persists retry-safe rows and preserves measurements when files disappear", async () => {
  const { db, people: p } = await database();
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0]!.id;
    const boat = fakeBoat();
    const provider = boat.providerFor("test");
    const native = await provider.fork({ from: "snapshot" });
    const receipt = await provider.prompt({ sandboxId: native.id, harness: "codex", text: "test" });
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat',$5,'codex','ready')`,
      [id, golden, p.org, p.owner, native.id],
    );
    const store = createSqlData(db)({
      userId: p.owner,
      via: "service",
      orgs: [{ orgId: p.org, role: "member" }],
    }).sandboxes;
    const row = { promptId: receipt.promptId, model: "gpt", inputTokens: 42, outputTokens: 7, cachedTokens: 8 };
    let available = false;
    provider.collectTurnUsage = async () => (available ? [row] : []);
    boat.finish(native.id, receipt.promptId, "finished");
    const early = await readStatus(provider, store, (await store.get(id))!, { now: new Date("2026-01-01") });
    expect(early.status).toBe("ready");
    expect(early.usage?.tokenTotals?.inputTokens).toBeNull();
    available = true;
    const delayed = await readStatus(provider, store, (await store.get(id))!, { now: new Date("2026-01-01") });
    expect(delayed.status).toBe("ready");
    expect(delayed.usage?.tokenTotals?.inputTokens).toBe(42);
    expect((await store.get(id))?.usage?.turns).toEqual([row]);
    for (const retry of [false, true]) {
      await collectSandboxUsage(provider, store, (await store.get(id))!);
      expect((await store.get(id))?.usage).toMatchObject({ turnCount: 1, turns: [row] });
      if (retry) available = false;
    }
    await collectSandboxUsage(provider, store, (await store.get(id))!);
    expect((await store.get(id))?.usage?.turns).toEqual([row]);
    // Stop still knows its target when provider history and native files are unavailable.
    provider.events = async () => {
      throw new Error("history unavailable");
    };
    const fallback = { ...(await store.get(id))!, taskPromptId: "unmeasured" };
    await collectSandboxUsage(provider, store, fallback);
    const incomplete = (await store.get(id))?.usage;
    expect(incomplete?.turnCount).toBe(2);
    expect(incomplete?.tokenTotals?.inputTokens).toBeNull();
    const later = { ...row, promptId: "unmeasured", inputTokens: 100 };
    await store.recordUsage!(id, { turnCount: 2, turns: [later] });
    // A stale status writer cannot erase a concurrently discovered prompt or lower its counters.
    await store.recordUsage!(id, { turnCount: 1, turns: [{ ...later, inputTokens: 50 }, row] });
    const measured = (await store.get(id))?.usage;
    expect(measured?.turnCount).toBe(2);
    expect(measured?.turns).toEqual([row, later]);
    expect(measured?.tokenTotals?.inputTokens).toBe(142);
    const unknownModel = { ...row, model: null, inputTokens: 7 };
    await store.recordUsage!(id, { turnCount: 2, turns: [unknownModel] });
    expect((await store.get(id))?.usage?.turns).toContainEqual(unknownModel);
    // A stale diagnostic writer must not attach an unavailable reason to
    // concurrently retained numeric observations, including unknown-model rows.
    await store.recordUsage!(id, {
      turnCount: 2,
      turns: [
        {
          ...unknownModel,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          unavailableReason: usageUnavailableReason("reader_unavailable"),
        },
      ],
    });
    expect((await store.get(id))?.usage?.turns).toContainEqual(unknownModel);
    const diagnostic = {
      promptId: "diagnostic",
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    };
    await store.recordUsage!(id, {
      turnCount: 3,
      turns: [{ ...diagnostic, unavailableReason: usageUnavailableReason("native_start_unobserved") }],
    });
    // These writers sampled before the useful reason was committed. Last writer
    // wins must not turn stop/missing telemetry into loss of the original stage.
    await store.recordUsage!(id, {
      turnCount: 3,
      turns: [{ ...diagnostic, unavailableReason: usageUnavailableReason("compute_inactive") }],
    });
    await store.recordUsage!(id, { turnCount: 3, turns: [diagnostic] });
    expect(
      (await store.get(id))?.usage?.turns.find((row) => row.promptId === "diagnostic")?.unavailableReason?.code,
    ).toBe("native_start_unobserved");
  } finally {
    await db.close();
  }
});

test.each(["codex", "claude"] as const)(
  "stored Modal status projects %s journal usage into SQL and totals without native calls",
  async (harness) => {
    const { db, people: p } = await database();
    try {
      const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0]!.id;
      const boat = fakeBoat();
      const provider = boat.providerFor("test");
      const native = await provider.fork({ from: "snapshot" });
      const receipt = await provider.prompt({ sandboxId: native.id, harness, text: "test" });
      boat.finish(native.id, receipt.promptId, "finished");
      const journal = await provider.events({ sandboxId: native.id });
      const usageEvent: AgentEvent = {
        id: "usage",
        at: 2,
        kind: "other",
        promptId: receipt.promptId,
        type: harness === "codex" ? "armada/turnUsage" : "result",
        data:
          harness === "codex"
            ? { model: "gpt", inputTokens: 42, outputTokens: 7, cachedTokens: 0 }
            : { modelUsage: { sonnet: { inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 0 } } },
      };
      provider.events = async () => ({ events: [...journal.events, usageEvent], hasMore: false, cursor: "end" });
      let nativeCalls = 0;
      provider.collectTurnUsage = async () => {
        nativeCalls++;
        return [];
      };
      const id = crypto.randomUUID();
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat',$5,$6,'ready')`,
        [id, golden, p.org, p.owner, native.id, harness],
      );
      const store = createSqlData(db)({
        userId: p.owner,
        via: "service",
        orgs: [{ orgId: p.org, role: "member" }],
      }).sandboxes;
      // The server-selected stored Modal adapter exposes the same Provider event contract.
      const found = { ...(await store.get(id))!, provider: "modal" as const };
      const report = await readStatus(provider, store, found, { stored: true, now: new Date("2026-01-01") });
      expect(nativeCalls).toBe(0);
      expect(report.usage?.tokenTotals).toMatchObject({ inputTokens: 42, outputTokens: 7, cachedTokens: 0 });
      expect((await store.get(id))?.usage).toMatchObject({
        turnCount: 1,
        turns: [{ promptId: receipt.promptId, inputTokens: 42 }],
      });
    } finally {
      await db.close();
    }
  },
);
