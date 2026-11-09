import type { LaunchStores } from "@armada/core/server";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  mapSandboxRow,
  OrchestratorAuthority,
  type ProviderRegistry,
  reserveOrchestratorOperation,
  resolveCredentials,
  type SandboxRow,
  type Sql,
  sandboxActivity,
} from "@armada/core/server";
import type { OrchestratorPair } from "./orchestrator-activation.ts";
import {
  createOrchestratorBackendResolver,
  type NamedOrchestratorCredentials,
} from "./orchestrator-backend-resolver.ts";
import { launchOrchestratorChild } from "./orchestrator-child-launch.ts";
import type { OrchestratorChildExecutor } from "./orchestrator-children.ts";
import { createModalOrchestratorNativeAdapter } from "./orchestrator-modal-native.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";
import { createOrchestratorServices } from "./orchestrator-services.ts";

/** Real production composition. Only Modal-owned Codex sessions have an implemented
 * private no-text restore driver. The deployment setting is admission policy, not
 * provider-native evidence; every operation still validates actual native receipts. */
export function createProductionOrchestrators(input: {
  sql: Sql;
  providers: ProviderRegistry;
  credentials: NamedOrchestratorCredentials;
  connections: LaunchStores["connections"];
  encryptionKey: string;
  scopedMcpUrl: string;
  requestedPairs: readonly OrchestratorPair[];
  skillRevision: string | undefined;
}) {
  if (!input.requestedPairs.includes("modal:codex")) return undefined;
  if (!input.skillRevision || !/^[a-f0-9]{40}$/.test(input.skillRevision))
    throw new Error("ARMADA_ORCHESTRATOR_SKILL_REVISION must be a reviewed public 40-character commit.");
  const { sql } = input;
  const authority = new OrchestratorAuthority(sql, async (tx, account) => {
    // The actual named credential policy under the authority transaction, never
    // owner API impersonation or a cached account/version decision.
    await resolveCredentials(createSqlVaultStore(tx), input.encryptionKey, account);
  });
  const native = createModalOrchestratorNativeAdapter({
    sql,
    mcpUrl: input.scopedMcpUrl,
    async assertPrerequisites(provider, golden, configuration) {
      if (
        provider.id !== "modal" ||
        configuration.provider !== "modal" ||
        configuration.harness !== "codex" ||
        !golden.modal ||
        !golden.providerSnapshotId ||
        !provider.installOrchestratorEpoch ||
        !provider.scrubOrchestratorEpoch ||
        !provider.quiesceOrchestrator ||
        !provider.observeOrchestrator ||
        !provider.verifyOrchestratorSession
      )
        throw new OrchestratorRuntimeError("unavailable");
    },
  });
  const selection = createOrchestratorBackendResolver({
    sql,
    providers: input.providers,
    credentials: input.credentials,
    ...(input.connections ? { connections: input.connections } : {}),
    encryptionKey: input.encryptionKey,
    mcpUrl: input.scopedMcpUrl,
    native: (provider, harness) => (provider === "modal" && harness === "codex" ? native : undefined),
    // Creation explicitly selects this golden and this named billing account.
    // Never infer consent to all of the owner's accounts or organization goldens.
    async consent(_actor, configuration) {
      return {
        scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop"],
        goldenIds: [configuration.goldenId],
        credentialIds: [configuration.modelAccountId],
      };
    },
  });
  const stores = {
    goldens: createSqlGoldenStore(sql),
    sandboxes: createSqlSandboxStore(sql),
    credentials: input.credentials,
    ...(input.connections ? { connections: input.connections } : {}),
  };
  async function child(sandboxId: string, ownerId: string, orgId: string) {
    const row = (
      await sql.query<SandboxRow & { source_golden_visibility: "org" | "private" }>(
        `select s.* from public.sandboxes s join public.orchestrator_children c on c.sandbox_id=s.id
       join public.members m on m.org_id=c.org_id and m.user_id=c.owner_id
       where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and c.owner_id=s.owner_id and c.org_id=s.org_id
       and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
        [sandboxId, ownerId, orgId],
      )
    ).rows[0];
    if (!row) throw new OrchestratorRuntimeError("not_found");
    const saved = mapSandboxRow(row);
    const golden = (await stores.goldens.list(orgId)).find((g) => g.id === saved.goldenId);
    if (!golden) throw new OrchestratorRuntimeError("not_found");
    const provider = await input.providers.resolve(
      {
        provider: saved.provider,
        orgId,
        visibility: saved.visibility ?? golden.visibility,
        sourceGoldenVisibility: row.source_golden_visibility,
        modal: golden.modal,
      },
      { userId: ownerId },
    );
    return { saved, provider };
  }
  const executor: OrchestratorChildExecutor = {
    async launch(operation, chosen) {
      const golden = (await stores.goldens.list(operation.orgId)).find((g) => g.id === chosen.goldenId);
      if (!golden) throw new OrchestratorRuntimeError("not_found");
      return launchOrchestratorChild({
        sql,
        operation,
        selection: chosen,
        stores: {
          ...stores,
          goldens: new Proxy(stores.goldens, {
            get(target, key) {
              if (key === "findByName")
                return async (orgId: string, name: string) =>
                  (await target.findByName(orgId, name)).filter((candidate) => candidate.id === chosen.goldenId);
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        },
        namedCredentials: input.credentials,
        provider: await input.providers.resolve(golden, { userId: operation.ownerId }),
      });
    },
    async read(id, ownerId, orgId) {
      const { saved } = await child(id, ownerId, orgId);
      return saved;
    },
    async message(operation, text) {
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const actor = { userId: operation.ownerId, orgId: operation.orgId, role: "member" as const };
      await input.credentials.assertTurn?.(actor, saved.id, saved.status === "stopped");
      await sandboxActivity(stores.sandboxes, saved, { status: "running" }, async (signal) => {
        const receipt = await provider.prompt({
          sandboxId: saved.providerSandboxId,
          harness: saved.harness,
          text,
          signal,
          ...(saved.model ? { model: saved.model } : {}),
          ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
          ...(saved.conversationIds.at(-1) ? { conversationId: saved.conversationIds.at(-1)! } : {}),
        });
        return {
          result: undefined,
          patch: {
            status: "running",
            rearmDeadline: true,
            conversationIds: [...new Set([...saved.conversationIds, receipt.conversationId])],
          },
        };
      });
    },
    async stop(operation) {
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      await sandboxActivity(stores.sandboxes, saved, { stopRequested: true }, async () => {
        await provider.stop({ sandboxId: saved.providerSandboxId });
        return { result: undefined, patch: { status: "stopped", stoppedAt: new Date().toISOString() } };
      });
    },
    async reconcile(operation, signal) {
      signal?.throwIfAborted();
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const physical = await provider.get(saved.providerSandboxId, { ...(signal ? { signal } : {}) });
      const closed = physical.state === "stopped";
      return {
        operationId: operation.id,
        sandboxId: operation.sandboxId,
        // Current stopped state is closure evidence, NOT proof that this exact
        // message/stop operation succeeded. Never replay an ambiguous mutation.
        state: "unknown",
        providerSandboxId: saved.providerSandboxId,
        ...(operation.action === "launch" && closed ? { resourceStopped: true } : {}),
      };
    },
  };
  return createOrchestratorServices(sql, {
    scopedMcpUrl: input.scopedMcpUrl,
    runtime: {
      authority,
      reserveOperation: reserveOrchestratorOperation,
      skillRevision: input.skillRevision,
      enabledPairs: ["modal:codex"],
      resolveBackend: selection.resolveBackend,
      managed: { sql, resolveManaged: selection.resolveManaged },
    },
    childAuthority: authority,
    childExecutor: executor,
    evidence: {
      async inspect(request) {
        if (request.kind !== "child") throw new OrchestratorRuntimeError("unavailable");
        const row = (
          await sql.query<{ owner_id: string; org_id: string }>(
            `select o.owner_id,o.org_id from public.orchestrators o
           join public.sandboxes s on s.id=o.sandbox_id
           join public.orchestrator_children c on c.orchestrator_id=o.id and c.sandbox_id=$2
           join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
           where o.id=$1 and s.lifecycle_generation=$3 and c.owner_id=o.owner_id and c.org_id=o.org_id`,
            [request.orchestratorId, request.reference, request.generation],
          )
        ).rows[0];
        if (!row) throw new OrchestratorRuntimeError("not_found");
        const { saved, provider } = await child(request.reference, row.owner_id, row.org_id);
        const observed = await provider.get(saved.providerSandboxId);
        const clock = (await sql.query<{ now: Date | string }>("select clock_timestamp() as now")).rows[0];
        if (!clock) throw new OrchestratorRuntimeError("unavailable");
        return {
          ...request,
          identity: `${saved.provider}:${saved.providerSandboxId}:${observed.physicalGeneration ?? "unknown"}:${observed.state}`,
          at: new Date(clock.now),
          state:
            observed.state === "stopped"
              ? "complete"
              : ["ready", "running", "starting"].includes(observed.state)
                ? "active"
                : "unknown",
        };
      },
    },
  });
}
