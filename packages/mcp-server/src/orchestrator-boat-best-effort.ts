import type { Provider, Sql } from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import type { OrchestratorNativeAdapter } from "./orchestrator-backend-resolver.ts";
import type { ManagedMachine } from "./orchestrator-managed-runtime.ts";
import { BestEffortConversationUnavailable } from "./orchestrator-runtime.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";
import { mirrorStoppedHistory } from "./orchestrator-stop-history.ts";

function boat(provider: Provider): BoatProvider {
  const candidate = provider as Partial<BoatProvider>;
  if (
    provider.id !== "boat" ||
    typeof candidate.resumeBestEffort !== "function" ||
    typeof candidate.conversations !== "function"
  )
    throw new OrchestratorRuntimeError("unavailable");
  return candidate as BoatProvider;
}

/** Ordinary Boat archival/activation, never a native checkpoint or session ACK.
 * SQL identity, dispatch and authority fences are shared with the native lane. */
export function createBoatBestEffortAdapter(input: { sql: Sql; mcpUrl: string }): OrchestratorNativeAdapter {
  return {
    continuity: "best_effort",
    async assertPrerequisites(provider, _golden, configuration) {
      boat(provider);
      if (
        configuration.provider !== "boat" ||
        !provider.capabilities[configuration.harness]?.resume ||
        !provider.installOrchestratorEpoch ||
        !provider.scrubOrchestratorEpoch ||
        !provider.quiesceOrchestrator
      )
        throw new OrchestratorRuntimeError("unavailable");
    },
    managed(provider, machine, owner) {
      const ordinary = boat(provider);
      const assertMachine = (current: ManagedMachine) => {
        if (
          current.orchestratorId !== machine.orchestratorId ||
          current.sandboxId !== machine.sandboxId ||
          current.providerSandboxId !== machine.providerSandboxId ||
          current.generation !== machine.generation
        )
          throw new OrchestratorRuntimeError("conflict");
      };
      return {
        provider,
        mcpUrl: input.mcpUrl,
        continuity: "best_effort",
        async observe(current, signal) {
          assertMachine(current);
          signal?.throwIfAborted();
          const physical = await provider.get(current.providerSandboxId);
          if (!["ready", "running"].includes(physical.state) || !physical.physicalGeneration)
            return {
              ...current,
              physicalGeneration: physical.physicalGeneration ?? null,
              state: "unknown",
              evidence: "boat:metadata_unavailable",
            };
          const conversations = await ordinary.conversations(current.providerSandboxId);
          return {
            ...current,
            physicalGeneration: physical.physicalGeneration,
            state: conversations.some((conversation) => conversation.running) ? "active" : "quiescent",
            evidence: "boat:conversation_metadata_unverified",
          };
        },
        async checkpointAndStop(current, operationId, signal) {
          assertMachine(current);
          signal?.throwIfAborted();
          const row = (
            await input.sql.query<{ conversation_id: string | null }>(
              `select r.conversation_id from public.orchestrator_runtime r join public.orchestrators o on o.id=r.orchestrator_id
             join public.sandboxes s on s.id=o.sandbox_id where o.id=$1 and s.id=$2 and s.provider_sandbox_id=$3
             and s.lifecycle_generation=$4 and o.owner_id=$5 and o.org_id=$6`,
              [
                current.orchestratorId,
                current.sandboxId,
                current.providerSandboxId,
                current.generation,
                owner.ownerId,
                owner.orgId,
              ],
            )
          ).rows[0];
          if (!row) throw new OrchestratorRuntimeError("conflict");
          await provider.stop({ sandboxId: current.providerSandboxId });
          const physical = await provider.get(current.providerSandboxId);
          if (physical.state !== "stopped") throw new OrchestratorRuntimeError("unavailable");
          // Boat history is durable/readable after ordinary archival, but has no native ACK watermark.
          await mirrorStoppedHistory(input.sql, provider, current, operationId, row.conversation_id);
          return {
            ...current,
            physicalGeneration: current.physicalGeneration ?? null,
            operationId,
            state: "stopped",
            continuity: "unverified",
          };
        },
        // The ordinary API has no operation-correlated stop lookup. Never adopt a
        // later unrelated stopped observation as proof of this uncertain dispatch.
        async readStopReceipt() {
          return null;
        },
      };
    },
    async resumeWithoutText(provider, identity, operationId) {
      const ordinary = boat(provider);
      if (!input.sql.transaction || !identity.sandboxId || !identity.providerSandboxId || identity.generation === null)
        throw new OrchestratorRuntimeError("conflict");
      if (identity.conversationId) {
        const conversation = (await ordinary.conversations(identity.providerSandboxId)).find(
          (entry) => entry.id === identity.conversationId,
        );
        if (
          !conversation ||
          conversation.lastHarness !== identity.configuration.harness ||
          conversation.lastModel !== identity.configuration.model
        )
          throw new BestEffortConversationUnavailable();
      }
      await ordinary.resumeBestEffort(identity.providerSandboxId);
      const active = await provider.get(identity.providerSandboxId);
      if (
        !["ready", "running"].includes(active.state) ||
        !active.physicalGeneration ||
        !(active.expiresAt instanceof Date) ||
        active.expiresAt.getTime() <= Date.now()
      )
        throw new OrchestratorRuntimeError("unavailable");
      await input.sql.transaction(async (tx) => {
        const changed = await tx.query(
          `update public.sandboxes s set status='ready',stopped_at=null,expires_at=$9,last_observed_at=now(),lifecycle_generation=lifecycle_generation+1,orchestrator_native_generation=$10
           from public.orchestrators o,public.orchestrator_operations p,public.members m
           where m.org_id=o.org_id and m.user_id=o.owner_id and s.id=$1 and s.lifecycle_generation=$2 and s.provider_sandbox_id=$3
           and s.status='stopped' and s.stop_requested_at is null and s.provider='boat'
           and o.id=$4 and o.sandbox_id=s.id and o.owner_id=$5 and o.org_id=$6 and o.revision=$7
           and p.id=$8 and p.orchestrator_id=o.id and p.action='resume' and p.revision=o.revision and p.state='pending' and p.actor_id=o.owner_id returning s.id`,
          [
            identity.sandboxId,
            identity.generation,
            identity.providerSandboxId,
            identity.id,
            identity.ownerId,
            identity.orgId,
            identity.revision,
            operationId,
            active.expiresAt,
            active.physicalGeneration,
          ],
        );
        if (changed.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
      });
    },
  };
}
