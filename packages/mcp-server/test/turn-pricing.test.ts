import { expect, test } from "bun:test";
import type { Sql, TurnPriceContext, TurnTokenUsage } from "@armada/core";
import { createUsagePricingContext, type Provider, priceTurn, resolvePrice } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { collectSandboxUsage } from "../src/turns.ts";
import { database, fakeBoat } from "./support.ts";

async function state(data: Awaited<ReturnType<typeof database>>) {
  const { db, people: p } = data;
  const golden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id)
    values($1,$2,'price-records','org','modal','workspace','main','ap-price') returning id`,
      [p.org, p.admin],
    )
  ).rows[0];
  if (!golden) throw Error("Missing golden");
  const caller = { userId: p.owner, via: "service" as const, orgs: [{ orgId: p.org, role: "member" as const }] };
  const store = createSqlData(db)(caller).sandboxes;
  const saved = await store.insert({
    id: crypto.randomUUID(),
    provider: "modal",
    providerSandboxId: "price-native",
    goldenId: golden.id,
    orgId: p.org,
    ownerId: p.owner,
    harness: "claude",
    status: "ready",
    model: "claude-sonnet-5-5",
    reasoningEffort: "medium",
  });
  const native: TurnTokenUsage = {
    promptId: "p1",
    model: "claude-sonnet-5-5",
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 4,
  };
  const snapshot = resolvePrice({ provider: "anthropic", model: native.model, customEndpoint: false });
  if (!snapshot) throw Error("Missing price fixture");
  const context: TurnPriceContext = {
    schemaVersion: 1,
    promptId: native.promptId,
    model: native.model,
    basis: "api_equivalent",
    credentialId: crypto.randomUUID(),
    credentialVersion: 1,
    capturedAt: "2026-11-12T12:00:00.000Z",
    snapshot,
  };
  const read = async () => (await store.get(saved.id))?.usage?.turns.find((row) => row.promptId === "p1");
  return { db, p, caller, store, saved, native, snapshot, context, read };
}

test("price context and coherent native observations freeze per-share API amounts without trusting native money", async () => {
  const data = await database();
  try {
    const { db, p, caller, store, saved, native, snapshot, context, read } = await state(data);
    const { promptId: _prompt, model: _model, ...frozenMetadata } = context;
    const spoof = {
      ...frozenMetadata,
      ...priceTurn(native, "claude", snapshot),
      usd: "999",
      inputs: {
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 4,
        cacheWriteTtl: null,
      },
    };
    await store.recordUsage!(
      saved.id,
      { turnCount: 1, turns: [{ ...native, pricing: spoof }] },
      { observations: [native] },
    );
    expect((await read())?.pricing).toBeNull();
    expect((await store.get(saved.id))?.usage?.cost).toMatchObject({ usd: null, unknown: "admission" });
    await store.recordUsage!(
      saved.id,
      { turnCount: 1, turns: [native] },
      { observations: [native], contexts: [context] },
    );
    expect((await read())?.pricing).toMatchObject({
      usd: "0.00022",
      basis: "api_equivalent",
      credentialId: context.credentialId,
      snapshot: { revision: snapshot.revision },
      inputs: { inputTokens: 10, outputTokens: 20 },
    });
    const changed: TurnPriceContext = {
      ...context,
      capturedAt: "2026-11-12T13:00:00.000Z",
      snapshot: { ...snapshot, revision: "refreshed", rates: { ...snapshot.rates, input: "999" } },
    };
    await store.recordUsage!(saved.id, { turnCount: 1, turns: [native] }, { observations: [], contexts: [changed] });
    expect((await read())?.pricing).toMatchObject({
      usd: "0.00022",
      capturedAt: context.capturedAt,
      snapshot: { revision: snapshot.revision, rates: { input: "2" } },
    });
    const grown = { ...native, inputTokens: 30 };
    await store.recordUsage!(
      saved.id,
      { turnCount: 1, turns: [grown] },
      { observations: [grown], contexts: [changed] },
    );
    expect((await read())?.pricing?.usd).toBe("0.00026");
    const partial = { ...native, inputTokens: 20, outputTokens: 40 };
    await store.recordUsage!(saved.id, { turnCount: 1, turns: [partial] }, { observations: [partial] });
    const synthetic = await read();
    expect(synthetic).toMatchObject({
      inputTokens: 30,
      outputTokens: 40,
      pricing: { usd: null, unknown: "tokens", inputs: null },
    });
    if (!synthetic) throw Error("Missing native row");
    const unavailable: Provider = {
      ...fakeBoat().provider,
      id: "modal",
      async events() {
        throw Error("history unavailable");
      },
    };
    const retained = await store.get(saved.id);
    if (!retained) throw Error("Missing retained sandbox");
    await collectSandboxUsage(unavailable, store, retained, "p1");
    expect((await read())?.pricing?.usd).toBeNull();
    const complete = { ...native, inputTokens: 30, outputTokens: 40 };
    await store.recordUsage!(saved.id, { turnCount: 1, turns: [complete] }, { observations: [complete] });
    expect((await read())?.pricing?.usd).toBe("0.00046");
    const unknown = { ...native, promptId: "p2", model: "unpriced-native" };
    const missing = { ...context, promptId: "p2", model: unknown.model, snapshot: null };
    await store.recordUsage!(
      saved.id,
      { turnCount: 2, turns: [unknown] },
      { observations: [unknown], contexts: [missing] },
    );
    const laterPrice = resolvePrice({
      provider: "anthropic",
      model: unknown.model,
      customEndpoint: true,
      connection: { id: context.credentialId!, revision: "later", rates: snapshot.rates },
    });
    await store.recordUsage!(
      saved.id,
      { turnCount: 2, turns: [unknown] },
      { observations: [unknown], contexts: [{ ...missing, snapshot: laterPrice }] },
    );
    expect((await store.get(saved.id))?.usage?.turns.find((row) => row.promptId === "p2")?.pricing).toMatchObject({
      usd: null,
      snapshot: null,
      unknown: "price",
    });
    const invalid = { ...native, promptId: "p3" };
    await store.recordUsage!(
      saved.id,
      { turnCount: 3, turns: [invalid] },
      {
        observations: [invalid],
        contexts: [
          {
            ...context,
            promptId: "p3",
            snapshot: { ...snapshot, source: ["models.dev"] as unknown as typeof snapshot.source },
          },
        ],
      },
    );
    expect((await store.get(saved.id))?.usage?.turns.find((row) => row.promptId === "p3")?.pricing).toBeNull();
    const metadata = await createSqlData(db)({ ...caller, userId: p.member }).sandboxes.list({ limit: 10 });
    expect(metadata.rows.find((row) => row.id === saved.id)?.usage).toBeNull();
  } finally {
    await data.db.close();
  }
});

test("query-only SQL cannot erase a price context or update counters beside a stale known amount", async () => {
  const data = await database();
  try {
    const { db, caller, store, saved, native, context, read } = await state(data);
    await store.recordUsage!(
      saved.id,
      { turnCount: 1, turns: [native] },
      { observations: [native], contexts: [context] },
    );
    // Query-only embeddings cannot erase a context and permit subsequent read-time repricing.
    const legacy: Sql = { query: db.query.bind(db) };
    await createSqlData(legacy)(caller).sandboxes.recordUsage!(
      saved.id,
      { turnCount: 99, turns: [{ ...native, inputTokens: 100 }] },
      { observations: [native], contexts: [context] },
    );
    expect((await read())?.pricing?.usd).toBe("0.00022");
    expect((await store.get(saved.id))?.usage?.turnCount).toBe(1);
  } finally {
    await data.db.close();
  }
});

test("database failure publishing a changed quote rolls native counters back atomically", async () => {
  const data = await database();
  try {
    const { db, store, saved, native, context, read } = await state(data);
    await store.recordUsage!(
      saved.id,
      { turnCount: 1, turns: [native] },
      { observations: [native], contexts: [context] },
    );
    await db.exec(`create function public.fail_quote_test() returns trigger language plpgsql as $$
      begin
        if new.usage_turns#>>'{turns,0,pricing,usd}' is not null and
          new.usage_turns#>>'{turns,0,pricing,usd}' is distinct from old.usage_turns#>>'{turns,0,pricing,usd}' then
          raise exception 'quote publication failed';
        end if;
        return new;
      end; $$;
      create trigger fail_quote_test before update of usage_turns on public.sandboxes
        for each row execute function public.fail_quote_test();`);
    const changed = { ...native, inputTokens: 100 };
    await expect(
      store.recordUsage!(saved.id, { turnCount: 1, turns: [changed] }, { observations: [changed] }),
    ).rejects.toThrow("quote publication failed");
    expect((await read())?.inputTokens).toBe(10);
    expect((await read())?.pricing?.usd).toBe("0.00022");
  } finally {
    await data.db.close();
  }
});

test("unrecognized stored quote metadata cannot lend an amount or observation witness to a valid context", async () => {
  const data = await database();
  try {
    const { db, store, saved, native, context, read } = await state(data);
    await store.recordUsage!(
      saved.id,
      { turnCount: 1, turns: [native] },
      { observations: [native], contexts: [context] },
    );
    await db.query(
      `update sandboxes set usage_turns=jsonb_set(jsonb_set(usage_turns,
      '{turns,0,pricing,schemaVersion}','2'::jsonb),'{turns,0,pricing,usd}','"999"'::jsonb) where id=$1`,
      [saved.id],
    );
    await store.recordUsage!(saved.id, { turnCount: 1, turns: [native] }, { observations: [], contexts: [context] });
    expect((await read())?.pricing).toMatchObject({ schemaVersion: 1, usd: null, unknown: "tokens", inputs: null });
  } finally {
    await data.db.close();
  }
});

test.each([
  { label: "contradictory subsets", writes: 10, five: 8, hour: 3, initialUsd: null, nextUsd: null },
  { label: "non-default subset with missing total", writes: null, five: 0, hour: 2, initialUsd: null, nextUsd: null },
  {
    label: "irrelevant diagnostics with zero writes",
    writes: 0,
    five: 1,
    hour: 0,
    initialUsd: "0.00022",
    nextUsd: "0.00042",
  },
  {
    label: "reported default compatible with omitted TTL",
    writes: 10,
    five: 10,
    hour: 0,
    initialUsd: "0.000245",
    nextUsd: "0.000445",
  },
])(
  "$label preserves evidence and applicable prices across native replay",
  async ({ writes, five, hour, initialUsd, nextUsd }) => {
    const data = await database();
    try {
      const { store, saved, native, context } = await state(data);
      await store.recordUsagePricingContext!(
        saved.id,
        createUsagePricingContext({
          harness: "claude",
          credentialKind: "claude_oauth",
          customEndpoint: false,
          credentialId: context.credentialId!,
          credentialVersion: 1,
        }),
      );
      let total: number | null = writes;
      let output = 20;
      let detail: Record<string, number> = {
        cacheCreationEphemeral5mInputTokens: five,
        cacheCreationEphemeral1hInputTokens: hour,
      };
      const provider: Provider = {
        ...fakeBoat().provider,
        id: "modal",
        async events() {
          return {
            events: [
              {
                id: "lifetime-result",
                at: 2,
                kind: "other",
                type: "result",
                promptId: native.promptId,
                data: {
                  modelUsage: {
                    [native.model!]: {
                      inputTokens: 10,
                      outputTokens: output,
                      cacheReadInputTokens: 0,
                      cacheCreationInputTokens: total,
                      ...detail,
                    },
                  },
                },
              },
            ],
            hasMore: false,
          };
        },
      };
      await collectSandboxUsage(provider, store, (await store.get(saved.id))!, native.promptId);
      const read = async () => (await store.get(saved.id))?.usage;
      expect((await read())?.turns[0]?.pricing?.usd).toBe(initialUsd);
      const replays: Record<string, number>[] =
        writes === null
          ? [{}, { cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 2 }]
          : nextUsd === null
            ? [{ cacheCreationEphemeral5mInputTokens: 10, cacheCreationEphemeral1hInputTokens: 0 }, {}]
            : [{}, {}];
      for (const replay of replays) {
        total = writes === 0 ? 0 : 10;
        output = nextUsd === null ? 20 : 40;
        detail = replay;
        await collectSandboxUsage(provider, store, (await store.get(saved.id))!, native.promptId);
        expect((await read())?.turns[0]?.pricing?.usd).toBe(nextUsd);
        expect((await read())?.cost?.usd).toBe(nextUsd);
        expect((await read())?.turns[0]?.cacheWriteTokensByTtl).toMatchObject(
          writes === null ? { oneHour: 2 } : five === writes ? { fiveMinute: five, oneHour: 0 } : { conflicted: true },
        );
      }
    } finally {
      await data.db.close();
    }
  },
);
