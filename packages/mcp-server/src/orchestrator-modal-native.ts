import { GOLDEN_ROOT, type Provider, type Sql } from "@armada/core/server";
import type { ModalOrchestratorCheckpoint, ModalProvider } from "@armada/provider-modal";
import type { OrchestratorNativeAdapter } from "./orchestrator-backend-resolver.ts";
import type { ManagedMachine, ManagedSelection, ManagedStopReceipt } from "./orchestrator-managed-runtime.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

function modal(provider: Provider): ModalProvider {
  const candidate = provider as Partial<ModalProvider>;
  if (
    provider.id !== "modal" ||
    typeof candidate.checkpointOrchestrator !== "function" ||
    typeof candidate.readOrchestratorCheckpoint !== "function" ||
    typeof candidate.restoreOrchestratorCheckpoint !== "function" ||
    typeof candidate.observeOrchestrator !== "function"
  )
    throw new OrchestratorRuntimeError("unavailable");
  return candidate as ModalProvider;
}
/** Concrete Modal caller, not a capability declaration. The verifier is required
 * from trusted operator proof policy; this adapter never manufactures or enables it. */
export function createModalOrchestratorNativeAdapter(input: {
  sql: Sql;
  mcpUrl: string;
  assertPrerequisites: OrchestratorNativeAdapter["assertPrerequisites"];
}): OrchestratorNativeAdapter {
  async function selection(machine: ManagedMachine, owner: ManagedSelection) {
    const saved = (
      await input.sql.query<{
        conversation_id: string | null;
        harness: "claude" | "codex";
        model: string | null;
        reasoning_effort: string | null;
        repository_dir: string | null;
      }>(
        `select r.conversation_id,s.harness,s.model,s.reasoning_effort,s.repository_dir
       from public.orchestrators o join public.orchestrator_runtime r on r.orchestrator_id=o.id
       join public.sandboxes s on s.id=o.sandbox_id
       where o.id=$1 and o.owner_id=$2 and o.org_id=$3 and s.id=$4 and s.provider_sandbox_id=$5
       and s.lifecycle_generation=$6 and s.provider='modal' and s.golden_id=$7`,
        [
          machine.orchestratorId,
          owner.ownerId,
          owner.orgId,
          machine.sandboxId,
          machine.providerSandboxId,
          machine.generation,
          owner.goldenId,
        ],
      )
    ).rows[0];
    if (
      !saved?.conversation_id ||
      !saved.model ||
      !["claude", "codex"].includes(saved.harness) ||
      (saved.repository_dir !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(saved.repository_dir))
    )
      throw new OrchestratorRuntimeError("conflict");
    return {
      conversationId: saved.conversation_id,
      harness: saved.harness,
      model: saved.model,
      ...(saved.reasoning_effort === null ? {} : { reasoningEffort: saved.reasoning_effort }),
      cwd: saved.repository_dir === null ? GOLDEN_ROOT : `${GOLDEN_ROOT}/${saved.repository_dir}`,
    };
  }
  function selected(checkpoint: ModalOrchestratorCheckpoint, pinned: Awaited<ReturnType<typeof selection>>) {
    if (
      checkpoint.conversationId !== pinned.conversationId ||
      checkpoint.harness !== pinned.harness ||
      checkpoint.model !== pinned.model ||
      checkpoint.reasoningEffort !== pinned.reasoningEffort ||
      checkpoint.cwd !== pinned.cwd
    )
      throw new OrchestratorRuntimeError("conflict");
  }
  function receipt(
    machine: ManagedMachine,
    operationId: string,
    checkpoint: ModalOrchestratorCheckpoint,
  ): ManagedStopReceipt {
    if (checkpoint.sandboxId !== machine.providerSandboxId || checkpoint.operationId !== operationId)
      throw new OrchestratorRuntimeError("conflict");
    const verified =
      checkpoint.state === "stopped" &&
      !!checkpoint.checkpointId &&
      !!checkpoint.nativeSessionId &&
      Number.isSafeInteger(checkpoint.eventWatermark) &&
      checkpoint.eventWatermark >= 0 &&
      checkpoint.acknowledgedSequence === checkpoint.eventWatermark;
    return {
      ...machine,
      operationId,
      state: verified ? "stopped" : "uncertain",
      continuity: verified ? "native" : "unverified",
    };
  }
  return {
    assertPrerequisites: async (provider, golden, configuration) => {
      modal(provider);
      if (configuration.harness !== "codex") throw new OrchestratorRuntimeError("unavailable");
      await input.assertPrerequisites(provider, golden, configuration);
    },
    managed(provider, machine, owner) {
      const native = modal(provider);
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
        async observe(current, signal) {
          assertMachine(current);
          signal?.throwIfAborted();
          const physical = await provider.get(current.providerSandboxId, { ...(signal ? { signal } : {}) });
          if (!physical.physicalGeneration || !["ready", "running"].includes(physical.state))
            return { ...current, state: "unknown", evidence: "native:unavailable" };
          const observed = await native.observeOrchestrator!({
            sandboxId: current.providerSandboxId,
            physicalGeneration: physical.physicalGeneration,
          });
          return { ...current, state: observed.state, evidence: `native:${observed.evidence}` };
        },
        async checkpointAndStop(current, operationId, signal) {
          assertMachine(current);
          signal?.throwIfAborted();
          const pinned = await selection(current, owner);
          const physical = await provider.get(current.providerSandboxId);
          if (!physical.physicalGeneration) throw new OrchestratorRuntimeError("unavailable");
          const checkpoint = await native.checkpointOrchestrator({
            sandboxId: current.providerSandboxId,
            operationId,
            physicalGeneration: physical.physicalGeneration,
            ...pinned,
          });
          selected(checkpoint, pinned);
          if (checkpoint.physicalGeneration !== physical.physicalGeneration)
            throw new OrchestratorRuntimeError("conflict");
          return receipt(current, operationId, checkpoint);
        },
        async readStopReceipt(current, operationId, signal) {
          assertMachine(current);
          signal?.throwIfAborted();
          const checkpoint = await native.readOrchestratorCheckpoint({
            sandboxId: current.providerSandboxId,
            operationId,
          });
          if (!checkpoint) return null;
          selected(checkpoint, await selection(current, owner));
          return receipt(current, operationId, checkpoint);
        },
      };
    },
    async resumeWithoutText(provider, identity, operationId) {
      if (
        !input.sql.transaction ||
        !identity.sandboxId ||
        !identity.providerSandboxId ||
        identity.generation === null ||
        !identity.conversationId
      )
        throw new OrchestratorRuntimeError("conflict");
      const native = modal(provider);
      const stop = (
        await input.sql.query<{ id: string }>(
          `select p.id from public.orchestrator_operations p where p.orchestrator_id=$1 and p.action='stop'
        and p.state='succeeded' and p.runtime_result->>'state'='stopped' and p.runtime_result->>'continuity'='native'
        and p.runtime_result->>'generation'=$2 order by p.revision desc limit 1`,
          [identity.id, String(identity.generation)],
        )
      ).rows[0];
      if (!stop) throw new OrchestratorRuntimeError("conflict");
      const checkpoint = await native.readOrchestratorCheckpoint({
        sandboxId: identity.providerSandboxId,
        operationId: stop.id,
      });
      if (!checkpoint || checkpoint.state !== "stopped") throw new OrchestratorRuntimeError("conflict");
      selected(
        checkpoint,
        await selection(
          {
            orchestratorId: identity.id,
            sandboxId: identity.sandboxId,
            providerSandboxId: identity.providerSandboxId,
            generation: String(identity.generation),
          },
          {
            orgId: identity.orgId,
            ownerId: identity.ownerId,
            goldenId: identity.configuration.goldenId,
            provider: "modal",
          },
        ),
      );
      const proof = await native.restoreOrchestratorCheckpoint({
        sandboxId: identity.providerSandboxId,
        operationId,
        checkpoint,
      });
      if (
        !proof.verified ||
        proof.conversationId !== identity.conversationId ||
        proof.nativeSessionId !== checkpoint.nativeSessionId ||
        proof.physicalGeneration === checkpoint.physicalGeneration
      )
        throw new OrchestratorRuntimeError("conflict");
      const active = await provider.get(identity.providerSandboxId);
      if (
        !["ready", "running"].includes(active.state) ||
        active.physicalGeneration !== proof.physicalGeneration ||
        !(active.expiresAt instanceof Date) ||
        !Number.isFinite(active.expiresAt.getTime()) ||
        active.expiresAt.getTime() <= Date.now()
      )
        throw new OrchestratorRuntimeError("unavailable");
      await input.sql.transaction(async (tx) => {
        const changed = await tx.query(
          `update public.sandboxes s set status='ready',stopped_at=null,expires_at=$9,last_observed_at=now(),lifecycle_generation=lifecycle_generation+1
          from public.orchestrators o,public.orchestrator_operations p,public.members m
          where m.org_id=o.org_id and m.user_id=o.owner_id and s.id=$1 and s.lifecycle_generation=$2 and s.provider_sandbox_id=$3 and s.status='stopped' and s.stop_requested_at is null
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
          ],
        );
        if (changed.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
      });
    },
  };
}
