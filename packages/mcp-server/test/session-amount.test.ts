import { expect, test } from "bun:test";
import type { StoredTurnPricing } from "@armada/core";
import { createSqlGoldenStore, createSqlVaultStore, launchSandbox, type Provider } from "@armada/core/server";
import { run } from "../../cli/src/run.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { collectSandboxUsage, type StatusReport } from "../src/turns.ts";
import { call, ENCRYPTION_KEY, fakeBoat, harness, PUBLIC_URL } from "./support.ts";

// Primary owner boundary: real credential admission -> native collector -> SQL -> HTTP/MCP/CLI JSON.
// The only fake is the native provider; no supplied quotes or test-only pricing contexts.
test.each([
  {
    agent: "claude" as const,
    model: "claude-sonnet-5-5",
    basis: "api_equivalent",
    usd: "0.00022",
    sum: "0.00068",
    input: 10,
    output: 20,
    write: 0,
  },
  {
    agent: "codex" as const,
    model: "gpt-6.1-sol",
    basis: "estimated",
    usd: "0.032901",
    sum: "0.033361",
    input: 13137,
    output: 6,
    write: 13134,
  },
])(
  "$agent admission actually produces persisted amounts returned identically by status and CLI",
  async ({ agent, model, basis, usd, sum, input: nativeInput, output: nativeOutput, write: nativeWrite }) => {
    let control: ControlOptions | undefined;
    const server = await harness({
      routes: [async (request) => (control ? await handleControlRequest(request, control) : null)],
    });
    try {
      const { db, people: p } = server;
      control = {
        authStore: server.auth,
        supabase: {
          supabaseUrl: "https://unused.invalid",
          anonKey: "unused",
          fetch: (async () => {
            throw Error("Unexpected auth network request");
          }) as unknown as typeof fetch,
        },
        store: createSqlVaultStore(db),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(db),
        providers: {
          resolve: async () => {
            throw Error("Closed pricing reads must not resolve providers");
          },
        },
      };
      await db.query(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
      modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,'amount-modal','private','modal','master','snapshot','workspace','main','ap-amount',
      '{"repos":[{"url":"https://github.com/acme/web","branch":"main","dir":"web"}],"init":[]}'::jsonb)`,
        [p.org, p.owner],
      );
      const actor = { userId: p.owner, orgId: p.org, role: "member" as const };
      const store = createSqlData(db)({
        userId: p.owner,
        via: "service",
        orgs: [{ orgId: p.org, role: "member" }],
      }).sandboxes;
      const fake = fakeBoat();
      const provider: Provider = { ...fake.provider, id: "modal" };
      const launched = await launchSandbox(
        provider,
        {
          goldens: createSqlGoldenStore(db),
          sandboxes: store,
          credentials: launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY),
        },
        actor,
        { golden: "amount-modal", harness: agent, prompt: "Reply OK" },
      );
      const promptId = launched.promptId!;
      fake.sandbox(launched.sandbox.providerSandboxId).events.push({
        id: "native-usage",
        at: 2,
        kind: "other",
        promptId,
        type: agent === "claude" ? "result" : "armada/turnUsage",
        data:
          agent === "claude"
            ? {
                modelUsage: {
                  [model]: {
                    inputTokens: nativeInput,
                    outputTokens: nativeOutput,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                  },
                },
              }
            : {
                model,
                inputTokens: nativeInput,
                outputTokens: nativeOutput,
                cachedTokens: 0,
                cacheWriteTokens: nativeWrite,
                reasoningTokens: 0,
              },
      });
      await collectSandboxUsage(provider, store, (await store.get(launched.sandbox.id))!, promptId);
      const persisted = (
        await db.query<{ usage_turns: { turns: { pricing: StoredTurnPricing | null }[] } }>(
          "select usage_turns from sandboxes where id=$1",
          [launched.sandbox.id],
        )
      ).rows[0]!.usage_turns;
      expect(persisted.turns[0]?.pricing).toMatchObject({ usd, basis, snapshot: { model } });
      const originalQuote = persisted.turns[0]?.pricing;
      if (!originalQuote?.snapshot) throw Error("Missing stored snapshot");
      if (agent === "codex") {
        expect(persisted.turns[0]?.pricing).toMatchObject({
          snapshot: { unsupported: true },
          inputs: { inputTokens: 13137, outputTokens: 6, cacheWriteTokens: 13134, cacheWriteTtl: null },
        });
        // Legacy publication blocked exactly this witnessed tuple. Retry uses the same frozen source,
        // even without fresh native history; known amounts are not repriced.
        await db.query(
          `update sandboxes set usage_turns=jsonb_set(jsonb_set(usage_turns,
          '{turns,0,pricing,usd}','null'::jsonb),'{turns,0,pricing,unknown}','"pricing_dimensions"'::jsonb) where id=$1`,
          [launched.sandbox.id],
        );
        await store.recordUsage!(launched.sandbox.id, { turnCount: 1, turns: [] }, { observations: [] });
        expect((await store.get(launched.sandbox.id))?.usage?.turns[0]?.pricing).toMatchObject({
          usd,
          snapshot: { revision: originalQuote.snapshot.revision },
        });
      }
      const cost = { currency: "USD", usd, basis, unknown: null, unpricedTurns: 0 } as const;
      expect((await store.get(launched.sandbox.id))?.usage?.cost).toEqual(cost);
      expect((await store.list({ limit: 10 })).rows[0]?.usage?.cost).toEqual(cost);
      // A closed stored read may not need a native provider, fresh credentials or current prices.
      await store.update(launched.sandbox.id, {
        status: "failed",
        statusReason: "closed fixture",
        stoppedAt: new Date().toISOString(),
      });
      const token = await server.token(p.owner);
      const response = await server.handler(
        new Request(`${PUBLIC_URL}/api/v1/sandbox/status`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ id: launched.sandbox.id }),
        }),
      );
      expect(response.status).toBe(200);
      const api = (await response.json()) as StatusReport;
      expect(api.usage?.cost).toEqual(cost);
      const client = await server.client(token);
      await client.listTools();
      expect((await call(client, "status", { id: launched.sandbox.id })).data.usage).toMatchObject({
        cost,
        tokenTotals: { inputTokens: nativeInput, outputTokens: nativeOutput },
        turns: [{ inputTokens: nativeInput, outputTokens: nativeOutput, pricing: { usd, basis, snapshot: { model } } }],
      });
      let output = "",
        errors = "";
      const io = {
        out: (text: string) => {
          output += text;
        },
        err: (text: string) => {
          errors += text;
        },
      };
      const exitCode = await run(["status", launched.sandbox.id, "--json"], io, {
        auth: {
          ...io,
          env: { ARMADA_URL: PUBLIC_URL, ARMADA_TOKEN: token },
          session: memorySessionStore(),
          now: () => server.clock.now,
          open: () => {},
          fetch: ((input, init) => server.handler(new Request(String(input), init))) as typeof fetch,
        },
      });
      expect(errors).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(output).usage.cost).toEqual(cost);
      const outsider = createSqlData(db)({
        userId: p.member,
        via: "service",
        orgs: [{ orgId: p.org, role: "member" }],
      }).sandboxes;
      expect((await outsider.list({ limit: 10 })).rows[0]?.usage).toBeNull();
      // Losing provider history cannot erase the frozen quote or change the API amount.
      await collectSandboxUsage(
        {
          ...provider,
          async events() {
            throw Error("unavailable");
          },
        },
        store,
        (await store.get(launched.sandbox.id))!,
        promptId,
      );
      expect((await store.get(launched.sandbox.id))?.usage?.cost).toEqual(cost);
      const second = {
        promptId: "second-known",
        model,
        inputTokens: 30,
        outputTokens: 40,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      };
      await store.recordTurnModel!(launched.sandbox.id, second.promptId, null);
      expect((await store.get(launched.sandbox.id))?.usage?.cost).toMatchObject({
        usd: null,
        unknown: "coverage",
        unpricedTurns: 1,
      });
      await store.recordUsage!(launched.sandbox.id, { turnCount: 2, turns: [second] }, { observations: [second] });
      expect((await store.get(launched.sandbox.id))?.usage?.cost).toEqual({ ...cost, usd: sum });
      // Never present a priced subtotal as the complete cost when another actual model is unknown.
      const unknown = {
        promptId: "missing-model",
        model: "not-in-admitted-book",
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      };
      await store.recordUsage!(launched.sandbox.id, { turnCount: 3, turns: [unknown] }, { observations: [unknown] });
      expect((await store.get(launched.sandbox.id))?.usage?.cost).toMatchObject({
        usd: null,
        unknown: "price",
        unpricedTurns: 1,
      });
      await store.recordTurnModel!(launched.sandbox.id, "admitted-but-unmeasured", null);
      await store.recordUsage!(launched.sandbox.id, { turnCount: 1, turns: [] }, { observations: [] });
      expect((await store.get(launched.sandbox.id))?.usage?.cost).toMatchObject({
        usd: null,
        unknown: "coverage",
        unpricedTurns: 2,
      });
    } finally {
      await server.close();
    }
  },
);
