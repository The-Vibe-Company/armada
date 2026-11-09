// Explicit actual661+210 SQL publication test with fake native I/O, NOT native proof.
import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import type { ModalOrchestratorCheckpoint, ModalProvider } from "@armada/provider-modal";
import { createManagedOrchestratorRuntime } from "../src/orchestrator-managed-runtime.ts";
import { createModalOrchestratorNativeAdapter } from "../src/orchestrator-modal-native.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database } from "./support.ts";

test.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "Modal native caller publishes only a matching resume operation and SQL generation (intervening writer=%s, promptless=%s)",
  async (race, promptless) => {
    const { db, people: p } = await database();
    const sql: core.Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    let checkpoint: ModalOrchestratorCheckpoint | null = null,
      stopped = false,
      generation = "physical-1",
      restoreOperation: string | undefined;
    try {
      const golden = await core.createSqlGoldenStore(sql).insert({
        orgId: p.org,
        ownerId: p.owner,
        name: "modal-native-fixture",
        visibility: "private",
        provider: "modal",
        modal: { workspace: "synthetic", environment: "test", appId: "ap_fixture" },
        config: { repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "web" }], init: [] },
      });
      const created = await store.create({
        ownerId: p.owner,
        configuration: {
          version: 1,
          orgId: p.org,
          name: "native",
          provider: "modal",
          harness: "codex",
          goldenId: golden.id,
          model: "gpt-6.1-sol",
          modelAccountId: crypto.randomUUID(),
        },
        key: "create",
        skillRevision: "a".repeat(40),
      });
      const sandbox = await core.createSqlSandboxStore(sql).insert({
        id: crypto.randomUUID(),
        provider: "modal",
        providerSandboxId: "native-logical",
        goldenId: golden.id,
        ownerId: p.owner,
        orgId: p.org,
        harness: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        repositoryDir: "web",
        status: "ready",
        visibility: "private",
      });
      await db.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, sandbox.id]);
      created.identity = await store.preparing(created);
      await store.complete(created, {
        state: "succeeded",
        ...(promptless ? {} : { conversationId: "logical", continuity: "native" as const }),
      });
      await db.query("update sandboxes set orchestrator_native_generation=$2 where id=$1", [sandbox.id, generation]);
      const machine = {
        orchestratorId: created.identity.id,
        sandboxId: sandbox.id,
        providerSandboxId: sandbox.providerSandboxId,
        generation: String(created.identity.generation),
      };
      const provider = {
        id: "modal",
        events: async ({ cursor }: { cursor?: string }) =>
          cursor === "2"
            ? {
                events:
                  generation === "physical-2"
                    ? [
                        {
                          id: "continuation",
                          at: 3,
                          kind: "message",
                          partial: false,
                          tools: [],
                          conversationId: "logical",
                          text: "continued",
                        },
                      ]
                    : [],
                hasMore: false,
                cursor: "3",
              }
            : cursor
              ? {
                  events: [
                    {
                      id: "tail",
                      at: 2,
                      kind: "message",
                      partial: false,
                      tools: [],
                      conversationId: "logical",
                      text: "tail",
                    },
                  ],
                  hasMore: false,
                  cursor: "2",
                }
              : {
                  events: [
                    {
                      id: "first",
                      at: 1,
                      kind: "message",
                      partial: false,
                      tools: [],
                      conversationId: "logical",
                      text: "first",
                    },
                  ],
                  hasMore: true,
                  cursor: "1",
                },
        get: async () => ({
          state: stopped ? "stopped" : "ready",
          physicalGeneration: generation,
          expiresAt: new Date(Date.now() + 3600000),
        }),
        installOrchestratorEpoch: async () => ({ acknowledged: true }),
        scrubOrchestratorEpoch: async () => ({ acknowledged: true }),
        quiesceOrchestrator: async () => ({ acknowledged: true }),
        observeOrchestrator: async () => ({
          physicalGeneration: "physical-1",
          state: "quiescent",
          evidence: "a".repeat(64),
          eventWatermark: 0,
          acknowledgedSequence: 0,
          nativeSessionId: "native",
        }),
        checkpointOrchestrator: async (request: Parameters<ModalProvider["checkpointOrchestrator"]>[0]) => {
          expect(request).toMatchObject({
            harness: "codex",
            model: "gpt-6.1-sol",
            reasoningEffort: "high",
            cwd: "/home/user/web",
            conversationId: promptless ? null : "logical",
            physicalGeneration: generation,
          });
          stopped = true;
          checkpoint = {
            ...request,
            version: 1,
            nativeSessionId: promptless ? null : "native",
            eventWatermark: 0,
            acknowledgedSequence: 0,
            checkpointId: "verified-image",
            state: "stopped",
          };
          return checkpoint;
        },
        readOrchestratorCheckpoint: async () => checkpoint,
        restoreOrchestratorCheckpoint: async (
          request: Parameters<ModalProvider["restoreOrchestratorCheckpoint"]>[0],
        ) => {
          restoreOperation = request.operationId;
          stopped = false;
          generation = "physical-2";
          if (race)
            await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [
              sandbox.id,
            ]);
          return {
            physicalGeneration: "physical-2",
            conversationId: "logical",
            nativeSessionId: "native",
            verified: true,
          };
        },
      } as unknown as ModalProvider;
      const adapter = createModalOrchestratorNativeAdapter({
        sql,
        mcpUrl: "https://armada.invalid/private/mcp",
        assertPrerequisites: async () => {
          throw Error("No native proof in synthetic fixture.");
        },
      });
      const owner = { orgId: p.org, ownerId: p.owner, goldenId: golden.id, provider: "modal" as const };
      const runtime = createManagedOrchestratorRuntime({
        sql,
        authority: new core.OrchestratorAuthority(sql, async () => {
          throw Error("No model resolution on cleanup.");
        }),
        resolveManaged: async () => adapter.managed(provider, machine, owner),
      });
      const stop = await store.reserve({
        ownerId: p.owner,
        orgId: p.org,
        id: created.identity.id,
        action: "stop",
        key: "stop",
        expectedRevision: 1,
        payload: { expectedRevision: 1 },
      });
      expect(await runtime.stopOwner(machine, stop.operation.id)).toMatchObject({
        state: "stopped",
        continuity: promptless ? "unverified" : "native",
        operationId: stop.operation.id,
      });
      expect(
        (await store.events(p.owner, p.org, created.identity.id)).events.filter((event) => event.kind === "agent"),
      ).toHaveLength(promptless ? 0 : 2);
      expect(
        (await db.query<{ status: string }>("select status from sandboxes where id=$1", [sandbox.id])).rows[0]?.status,
      ).toBe("stopped");
      expect(
        await store.complete(stop, {
          state: "succeeded",
          parentState: "stopped",
          continuity: promptless ? "unverified" : "native",
        }),
      ).toBe(true);
      if (promptless) return;
      const resume = await store.reserve({
        ownerId: p.owner,
        orgId: p.org,
        id: created.identity.id,
        action: "resume",
        key: "resume",
        expectedRevision: 2,
        payload: { expectedRevision: 2 },
      });
      const effect = adapter.resumeWithoutText?.(provider, resume.identity, resume.operation.id);
      if (!effect) throw Error("Missing native caller.");
      if (race) await expect(effect).rejects.toThrow("conflict");
      else await effect;
      expect(restoreOperation).toBe(resume.operation.id);
      const row = (
        await db.query<{ status: string; lifecycle_generation: string }>(
          "select status,lifecycle_generation from sandboxes where id=$1",
          [sandbox.id],
        )
      ).rows[0];
      expect(row?.status).toBe(race ? "stopped" : "ready");
      expect(Number(row?.lifecycle_generation)).toBe(Number(machine.generation) + 1);
      if (!race) {
        resume.identity = await store.preparing(resume);
        expect(await store.complete(resume, { state: "succeeded", parentState: "ready" })).toBe(true);
        await db.query("update sandboxes set orchestrator_native_generation=$2 where id=$1", [sandbox.id, generation]);
        const again = await store.reserve({
          ownerId: p.owner,
          orgId: p.org,
          id: created.identity.id,
          action: "stop",
          key: "stop-again",
          expectedRevision: 3,
          payload: { expectedRevision: 3 },
        });
        const nextMachine = {
          ...machine,
          generation: String(again.identity.generation),
          physicalGeneration: generation,
        };
        const nextRuntime = createManagedOrchestratorRuntime({
          sql,
          authority: new core.OrchestratorAuthority(sql, async () => {
            throw Error("No model resolution on cleanup.");
          }),
          resolveManaged: async () => adapter.managed(provider, nextMachine, owner),
        });
        expect(await nextRuntime.stopOwner(nextMachine, again.operation.id)).toMatchObject({
          state: "stopped",
          continuity: "native",
        });
        const retained = (await store.events(p.owner, p.org, created.identity.id)).events.filter(
          (event) => event.kind === "agent",
        );
        expect(retained).toHaveLength(3);
      }
    } finally {
      await db.close();
    }
  },
);
