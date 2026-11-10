import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import type { Caller } from "../src/caller.ts";
import { createBoatBestEffortAdapter } from "../src/orchestrator-boat-best-effort.ts";
import { launchOrchestratorParent } from "../src/orchestrator-launch.ts";
import { OrchestratorRuntime } from "../src/orchestrator-runtime.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database, fakeBoat } from "./support.ts";

// Primary owner of best-effort lifecycle: real SQL receipts, runtime, launcher,
// authority and Boat adapter; only external placement/harness I/O is fake.
test.each(["claude", "codex"] as const)(
  "Boat %s keeps logical history but never advertises native continuity",
  async (harness) => {
    const { db, people: p } = await database();
    const sql: core.Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const placement = fakeBoat();
    const revision = "a".repeat(40);
    placement.setExecOutput({
      stdout: `Source: https://github.com/The-Vibe-Company/armada/tree/${revision}/.agents/skills\n`,
    });
    let generation = "boot-1",
      available = true,
      activations = 0,
      grant: string | undefined;
    const choice = core.resolveModelChoice(harness, {});
    const diagnostics: string[] = [];
    const provider: BoatProvider = {
      ...placement.provider,
      get: async (id, options) => ({
        ...(await placement.provider.get(id, options)),
        physicalGeneration: generation,
        expiresAt: new Date(Date.now() + 3600000),
      }),
      installOrchestratorEpoch: async (request) => {
        grant = request.token;
        return { acknowledged: true };
      },
      scrubOrchestratorEpoch: async () => {
        grant = undefined;
        return { acknowledged: true };
      },
      quiesceOrchestrator: async ({ sandboxId }) => {
        await placement.provider.interrupt({ sandboxId });
        return { acknowledged: true };
      },
      stopBestEffort: async (sandboxId) => placement.provider.stop({ sandboxId }),
      conversations: async () =>
        available
          ? [
              {
                id: "conv_1",
                running: false,
                lastHarness: harness === "claude" ? "claude-code" : harness,
                lastModel: "provider-model-alias",
              },
            ]
          : [],
      resumeBestEffort: async (id) => {
        activations++;
        generation = `boot-${activations + 1}`;
        placement.sandbox(id).info.state = "ready";
      },
    };
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    const adapter = createBoatBestEffortAdapter({
      sql,
      mcpUrl: "https://armada.invalid/api/v1/orchestrator-tools/mcp",
    });
    let runtime: OrchestratorRuntime | undefined;
    try {
      const golden = (await core.createSqlGoldenStore(sql).list(p.org)).find((entry) => entry.name === "shared")!;
      const account = (
        await sql.query<{ id: string; version: number }>(
          "select id,version from credentials where kind=$1 and scope='org' and owner_id=$2",
          [harness === "codex" ? "openai" : "claude_oauth", p.org],
        )
      ).rows[0]!;
      const credentials = {
        env: {},
        secrets: [],
        codexAuthJson: false,
        binding: { credentialId: account.id, credentialVersion: account.version },
      };
      runtime = new OrchestratorRuntime({
        store,
        diagnosticLog: (line) => diagnostics.push(line),
        skillRevision: revision,
        enabledPairs: [`boat:${harness}`],
        authority: new core.OrchestratorAuthority(sql, async () => {}),
        managed: { sql, resolveManaged: async (machine, owner) => adapter.managed(provider, machine, owner) },
        resolveBackend: async (configuration) => ({
          provider,
          continuity: "best_effort",
          projectDir: core.GOLDEN_ROOT,
          mcpUrl: "https://armada.invalid/api/v1/orchestrator-tools/mcp",
          consent: {
            scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop"],
            goldenIds: [golden.id],
            credentialIds: [account.id],
          },
          assertNativeProof: () => adapter.assertPrerequisites(provider, golden, configuration),
          revalidate: async () => {},
          resumeWithoutText: (identity, operationId) => adapter.resumeWithoutText!(provider, identity, operationId),
          launch: (reservation, diagnostics, hooks) =>
            launchOrchestratorParent({
              sql,
              provider,
              reservation,
              ...(diagnostics ? { diagnostics } : {}),
              ...(hooks ? { hooks } : {}),
              actor: { userId: p.owner, orgId: p.org, role: "member" },
              request: { golden: golden.name, provider: "boat", harness, ...choice },
              stores: {
                goldens: core.createSqlGoldenStore(sql),
                sandboxes: core.createSqlSandboxStore(sql),
                credentials: { resolve: async () => credentials },
              },
              account: {
                credentialId: account.id,
                credentialVersion: account.version,
                resolve: async () => credentials,
              },
            }),
        }),
      });
      const caller: Caller = { userId: p.owner, orgs: [{ orgId: p.org, role: "member" }], via: "supabase" };
      const created = await runtime.create(
        caller,
        {
          version: 1,
          orgId: p.org,
          name: "best effort",
          provider: "boat",
          harness,
          goldenId: golden.id,
          modelAccountId: account.id,
          ...choice,
        },
        "create",
      );
      await runtime.createWorker.drain();
      expect((await store.operations(p.owner, p.org, created.orchestratorId))[0]?.state).toBe("succeeded");
      let last = created;
      const mutate = async (action: "message" | "stop" | "resume", key: string) => {
        last = await runtime!.mutate(caller, {
          orgId: p.org,
          id: created.orchestratorId,
          action,
          key,
          expectedRevision: last.revision,
          ...(action === "message" ? { text: "hello" } : {}),
        });
        return last;
      };
      expect((await mutate("message", "send")).state).toBe("succeeded");
      placement.finish("bx_1", "prompt_1", "finished");
      expect((await mutate("stop", "stop")).state).toBe("succeeded");
      expect(grant).toBeUndefined();
      expect(await store.read(p.owner, p.org, created.orchestratorId)).toMatchObject({
        state: "stopped",
        continuity: "unverified",
        conversationId: "conv_1",
      });
      expect((await mutate("resume", "resume")).state).toBe("succeeded");
      expect(activations).toBe(1);
      expect(grant).toMatch(/^armada_epoch_/);
      expect(placement.prompts).toHaveLength(1); // No synthetic resume turn.
      expect(await store.read(p.owner, p.org, created.orchestratorId)).toMatchObject({
        state: "ready",
        continuity: "unverified",
        conversationId: "conv_1",
      });
      expect((await mutate("message", "continue")).state).toBe("succeeded");
      expect(placement.prompts.at(-1)?.conversationId).toBe("conv_1");
      placement.finish("bx_1", "prompt_2", "finished");
      expect((await mutate("stop", "stop-again")).state).toBe("succeeded");
      expect(
        (await store.events(p.owner, p.org, created.orchestratorId)).events.some((entry) => entry.kind === "agent"),
      ).toBe(true);
      available = false;
      expect(await mutate("resume", "missing-conversation")).toMatchObject({
        state: "succeeded",
        errorCode: "previous_conversation_not_continued",
      });
      expect(diagnostics.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          kind: "resume_continuity",
          value: "previous_conversation_not_continued",
        }),
      );
      expect(diagnostics.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({ kind: "resume_fallback", value: "conversation_metadata_missing" }),
      );
      expect(activations).toBe(2);
      expect(placement.prompts).toHaveLength(2);
      expect(await store.read(p.owner, p.org, created.orchestratorId)).toMatchObject({
        state: "ready",
        continuity: "unverified",
        conversationId: null,
        blockedReason: null,
      });
      expect((await mutate("message", "fresh-send")).state).toBe("succeeded");
      expect(placement.prompts.at(-1)?.conversationId).toBeUndefined();
      placement.finish("bx_1", "prompt_3", "finished");
      await sql.query(`update public.orchestrators set state='blocked' where id=$1`, [created.orchestratorId]);
      const operations = await store.operations(p.owner, p.org, created.orchestratorId);
      await expect(mutate("message", "blocked-send")).rejects.toMatchObject({
        code: "conflict",
        admission: "not_admitted",
      });
      expect(await store.operations(p.owner, p.org, created.orchestratorId)).toHaveLength(operations.length);
      expect(placement.prompts).toHaveLength(3);
    } finally {
      await runtime?.createWorker.drain();
      await db.close();
    }
  },
);
