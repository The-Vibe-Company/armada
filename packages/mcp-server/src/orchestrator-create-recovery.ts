import { createHash } from "node:crypto";
import type { OrchestratorOperation } from "@armada/core";
import type {
  OrchestratorCreateRecoveryProof,
  OrchestratorCreateRecoveryRequest,
  ProviderRegistry,
  Sql,
} from "@armada/core/server";
import { reserveOrchestratorOperation } from "@armada/core/server";
import { type OrchestratorDiagnosticLog, OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

type Input = { ownerId: string; orgId: string; id: string; expectedRevision: number; key: string };
type Recovery = {
  version: 1;
  kind: "create_recovery";
  stage: "reserved" | "dispatched" | "terminated";
  request?: OrchestratorCreateRecoveryRequest;
  sourceStopOperationId?: string;
  noFork?: { createOperationId: string };
};
type Operation = {
  id: string;
  revision: number | string;
  state: OrchestratorOperation["state"];
  error_code: string | null;
  runtime_result: Recovery;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function wire(row: Operation, id: string): OrchestratorOperation {
  return {
    version: 1,
    id: row.id,
    orchestratorId: id,
    kind: "stop",
    state: row.state,
    revision: Number(row.revision),
    errorCode: row.error_code,
  };
}
function requestOf(operation: Operation): OrchestratorCreateRecoveryRequest {
  const request = operation.runtime_result.request;
  if (!request) throw new OrchestratorRuntimeError("conflict");
  return request;
}
/** Owner abort for the exact first pending/uncertain create with no conversation,
 * or the blocked uncertain stop of its original registered incarnation.
 * Registered snapshots keep SQL/native fences separate; only tagged pre-fork
 * intent proves no allocation. No model credential lookup. */
export function createOrchestratorCreateRecovery(
  sql: Sql,
  providers: ProviderRegistry,
  log?: OrchestratorDiagnosticLog,
) {
  const sourceFailed = (operationId: string, orchestratorId: string) => {
    const diagnostics = new OrchestratorDiagnostics(log, "create");
    diagnostics.bind({ operationId, orchestratorId });
    diagnostics.stage("create_reconciliation");
    diagnostics.report("failed", undefined, "recorded_operation_failed");
  };
  async function parent(tx: Sql, input: Input) {
    const row = (
      await tx.query<{ revision: number | string; sandbox_id: string | null; state: string }>(
        `select o.revision,o.sandbox_id,o.state from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
       where o.id=$1 and o.owner_id=$2 and o.org_id=$3 for update of o,m`,
        [input.id, input.ownerId, input.orgId],
      )
    ).rows[0];
    if (!row) throw new OrchestratorRuntimeError("not_found");
    return row;
  }
  async function reserve(input: Input): Promise<Operation> {
    if (!sql.transaction) throw new OrchestratorRuntimeError("unavailable");
    const digest = createHash("sha256")
      .update(JSON.stringify(["create_recovery_v1", input.ownerId, input.orgId, input.id, input.expectedRevision]))
      .digest("hex");
    return sql.transaction(async (tx) => {
      const current = await parent(tx, input);
      const prior = (
        await tx.query<Operation & { request_digest: string }>(
          `select id,revision,state,error_code,runtime_result,request_digest from public.orchestrator_operations
         where orchestrator_id=$1 and actor_id=$2 and action='stop' and idempotency_key=$3 for update`,
          [input.id, input.ownerId, input.key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== digest || prior.runtime_result?.kind !== "create_recovery")
          throw new OrchestratorRuntimeError("conflict");
        return prior;
      }
      if (
        Number(current.revision) !== input.expectedRevision ||
        !["blocked", "creating", "ready"].includes(current.state)
      )
        throw new OrchestratorRuntimeError("conflict");
      const source = (
        await tx.query<{
          id: string;
          action: "create" | "stop";
          configuration: { provider: string; goldenId: string; harness: string };
          runtime_result: {
            kind?: string;
            stage?: string;
            noFork?: boolean;
            intendedSandboxId?: string;
            binding?: { sandboxId: string; providerSandboxId: string; generation: number };
          } | null;
          conversation_id: string | null;
        }>(
          `select p.id,p.action,p.runtime_result,r.configuration,r.conversation_id from public.orchestrator_operations p
         join public.orchestrator_runtime r on r.orchestrator_id=p.orchestrator_id
         where p.orchestrator_id=$1 and p.actor_id=$2 and p.revision=$3 and ((p.action='create' and (p.state in ('pending','uncertain') or (p.state='failed' and p.runtime_result->>'noFork'='true'))) or (p.action='stop' and p.state='uncertain' and p.runtime_result->>'kind' is distinct from 'create_recovery')) for update of p,r`,
          [input.id, input.ownerId, input.expectedRevision],
        )
      ).rows[0];
      if (
        !source ||
        source.configuration.provider !== "modal" ||
        (source.action === "create" && source.conversation_id !== null) ||
        (source.action === "stop" && (current.state !== "blocked" || !current.sandbox_id))
      )
        throw new OrchestratorRuntimeError("conflict");
      const busy = await tx.query(
        `select id from public.orchestrator_operations where orchestrator_id=$1 and id<>$2 and state in ('pending','uncertain')`,
        [input.id, source.id],
      );
      if (busy.rows.length) throw new OrchestratorRuntimeError("conflict");
      const stopRecovery = source.action === "stop";
      let createOperationId = source.id;
      if (stopRecovery) {
        const original = (
          await tx.query<{ id: string }>(
            `select id from public.orchestrator_operations where orchestrator_id=$1 and actor_id=$2 and action='create' and state='succeeded' order by revision limit 1 for update`,
            [input.id, input.ownerId],
          )
        ).rows[0];
        if (!original) throw new OrchestratorRuntimeError("conflict");
        createOperationId = original.id;
      }
      const job = stopRecovery ? null : source.runtime_result;
      // Only this new producer's durable pre-fork fence proves no allocation.
      // Untagged legacy pending receipts can NEVER use this shortcut.
      if (
        current.sandbox_id === null &&
        job?.kind === "create_job" &&
        (job.noFork === true || (!job.intendedSandboxId && ["queued", "running"].includes(job.stage ?? ""))) &&
        !job.binding
      ) {
        const receipt = await reserveOrchestratorOperation(
          { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
          {
            orchestratorId: input.id,
            actorId: input.ownerId,
            action: "stop",
            key: input.key,
            digest,
            expectedRevision: input.expectedRevision,
          },
        );
        const result: Recovery = {
          version: 1,
          kind: "create_recovery",
          stage: "terminated",
          noFork: { createOperationId: source.id },
        };
        const cancelled = await tx.query<{ error_code: string | null }>(
          `update public.orchestrator_operations set state='failed',error_code=case when state='failed' then error_code else 'create_aborted_before_fork' end,
          runtime_result=runtime_result || '{"stage":"aborted_before_fork","noFork":true}'::jsonb where id=$1 returning error_code`,
          [source.id],
        );
        await tx.query(
          `update public.orchestrator_operations set state='succeeded',runtime_result=$2::jsonb where id=$1`,
          [receipt.id, JSON.stringify(result)],
        );
        await tx.query(
          `update public.orchestrators set state='stopped',authority_epoch=authority_epoch+1 where id=$1`,
          [input.id],
        );
        await tx.query(
          `update public.orchestrator_runtime set continuity='unverified',blocked_reason=null,updated_at=now() where orchestrator_id=$1`,
          [input.id],
        );
        const recovered: Operation = {
          id: receipt.id,
          revision: receipt.revision,
          state: "succeeded",
          error_code: null,
          runtime_result: result,
        };
        const failedCreate: OrchestratorOperation = {
          version: 1,
          id: source.id,
          orchestratorId: input.id,
          kind: "create",
          state: "failed",
          revision: input.expectedRevision,
          errorCode: cancelled.rows[0]?.error_code ?? "create_aborted_before_fork",
        };
        await tx.query(
          `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event) values($1,$2,$3::jsonb),($1,$4,$5::jsonb),($1,$4,$6::jsonb)`,
          [
            input.id,
            input.expectedRevision,
            JSON.stringify({ kind: "operation", operation: failedCreate }),
            Number(receipt.revision),
            JSON.stringify({ kind: "operation", operation: wire(recovered, input.id) }),
            JSON.stringify({ kind: "state", state: "stopped", continuity: "unverified" }),
          ],
        );
        return {
          id: receipt.id,
          revision: receipt.revision,
          state: "succeeded",
          error_code: null,
          runtime_result: result,
        };
      }
      let originalSandbox: OrchestratorCreateRecoveryRequest["originalSandbox"];
      if (current.sandbox_id) {
        const sandbox = (
          await tx.query<{
            id: string;
            provider_sandbox_id: string;
            lifecycle_generation: string;
            orchestrator_native_generation: string | null;
          }>(
            `select id,provider_sandbox_id,lifecycle_generation::text,orchestrator_native_generation from public.sandboxes
           where id=$1 and owner_id=$2 and org_id=$3 and golden_id=$4 and provider='modal' and harness::text=$5
           and visibility='private' and ($6::boolean or cardinality(conversation_ids)=0) for update`,
            [
              current.sandbox_id,
              input.ownerId,
              input.orgId,
              source.configuration.goldenId,
              source.configuration.harness,
              stopRecovery,
            ],
          )
        ).rows[0];
        if (
          !sandbox ||
          (stopRecovery && (sandbox.lifecycle_generation !== "1" || sandbox.orchestrator_native_generation !== "1")) ||
          (job?.binding &&
            (job.binding.sandboxId !== sandbox.id ||
              job.binding.providerSandboxId !== sandbox.provider_sandbox_id ||
              String(job.binding.generation) !== sandbox.lifecycle_generation))
        )
          throw new OrchestratorRuntimeError("conflict");
        originalSandbox = {
          sandboxId: sandbox.id,
          providerSandboxId: sandbox.provider_sandbox_id,
          sqlGeneration: sandbox.lifecycle_generation,
          nativeGeneration: sandbox.orchestrator_native_generation,
        };
        await tx.query(
          `update public.sandboxes set stop_requested_at=coalesce(stop_requested_at,now()) where id=$1 and lifecycle_generation=$2`,
          [sandbox.id, sandbox.lifecycle_generation],
        );
      }
      const golden = (
        await tx.query<{
          visibility: "org" | "private";
          provider_snapshot_id: string | null;
          modal_workspace: string | null;
          modal_environment: string | null;
          modal_app_id: string | null;
        }>(
          `select visibility,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id from public.goldens
         where id=$1 and org_id=$2 and provider='modal' and (visibility='org' or owner_id=$3)`,
          [source.configuration.goldenId, input.orgId, input.ownerId],
        )
      ).rows[0];
      if (!golden?.provider_snapshot_id || !golden.modal_workspace || !golden.modal_environment || !golden.modal_app_id)
        throw new OrchestratorRuntimeError("unavailable");
      const allocated = await reserveOrchestratorOperation(
        { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
        {
          orchestratorId: input.id,
          actorId: input.ownerId,
          action: "stop",
          key: input.key,
          digest,
          expectedRevision: input.expectedRevision,
        },
      );
      const id = allocated.id;
      const result: Recovery = {
        version: 1,
        kind: "create_recovery",
        stage: "reserved",
        ...(stopRecovery ? { sourceStopOperationId: source.id } : {}),
        request: {
          version: 1,
          createOperationId,
          ...(stopRecovery ? { stopOperationId: source.id } : {}),
          recoveryOperationId: id,
          orchestratorId: input.id,
          ownerId: input.ownerId,
          orgId: input.orgId,
          providerSnapshotId: golden.provider_snapshot_id,
          ...(originalSandbox
            ? { originalSandbox, intendedSandboxId: originalSandbox.sandboxId }
            : job?.intendedSandboxId
              ? { intendedSandboxId: job.intendedSandboxId }
              : {}),
          target: {
            provider: "modal",
            orgId: input.orgId,
            visibility: "private",
            sourceGoldenVisibility: golden.visibility,
            modal: {
              workspace: golden.modal_workspace,
              environment: golden.modal_environment,
              appId: golden.modal_app_id,
            },
          },
        },
      };
      const created = (
        await tx.query<Operation>(
          `update public.orchestrator_operations set runtime_result=$2::jsonb where id=$1 returning id,revision,state,error_code,runtime_result`,
          [id, JSON.stringify(result)],
        )
      ).rows[0];
      if (!created) throw new OrchestratorRuntimeError("unavailable");
      await tx.query(`update public.orchestrators set state='stopping',authority_epoch=authority_epoch+1 where id=$1`, [
        input.id,
      ]);
      return created;
    });
  }
  async function bound(tx: Sql, input: Input, operation: Operation) {
    const current = await parent(tx, input);
    const request = requestOf(operation);
    if (
      Number(current.revision) !== Number(operation.revision) ||
      current.sandbox_id !== (request.originalSandbox?.sandboxId ?? null)
    )
      throw new OrchestratorRuntimeError("conflict");
    const row = (
      await tx.query<Operation>(
        `select id,revision,state,error_code,runtime_result from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 and action='stop' for update`,
        [operation.id, input.id, input.ownerId],
      )
    ).rows[0];
    if (
      !row ||
      row.runtime_result?.kind !== "create_recovery" ||
      requestOf(row).createOperationId !== request.createOperationId
    )
      throw new OrchestratorRuntimeError("conflict");
    if (row.state !== "succeeded") {
      const original = await tx.query(
        `select id from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 and action=$5 and state in ('pending','uncertain') and revision=$4 for update`,
        [
          requestOf(row).stopOperationId ?? requestOf(row).createOperationId,
          input.id,
          input.ownerId,
          input.expectedRevision,
          requestOf(row).stopOperationId ? "stop" : "create",
        ],
      );
      if (original.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
    }
    if (request.originalSandbox) {
      const b = request.originalSandbox;
      const snapshot = await tx.query(
        `select id from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3 and provider_sandbox_id=$4
        and lifecycle_generation=$5 and orchestrator_native_generation is not distinct from $6::text and ($7::boolean or cardinality(conversation_ids)=0) and stop_requested_at is not null`,
        [
          b.sandboxId,
          input.ownerId,
          input.orgId,
          b.providerSandboxId,
          b.sqlGeneration,
          b.nativeGeneration,
          !!request.stopOperationId,
        ],
      );
      if (snapshot.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
    }
    return row;
  }
  return async (input: Input, diagnostics?: OrchestratorDiagnostics): Promise<OrchestratorOperation> => {
    if (
      !sql.transaction ||
      !UUID.test(input.id) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !/^[ -~]{1,128}$/.test(input.key)
    )
      throw new OrchestratorRuntimeError("invalid_request");
    diagnostics?.stage("recovery_reservation");
    const operation = await reserve(input);
    diagnostics?.bind({ operationId: operation.id, orchestratorId: input.id });
    if (operation.state === "succeeded" || operation.state === "failed") {
      if (operation.state === "failed") diagnostics?.report("failed", undefined, "recorded_operation_failed");
      if (operation.state === "succeeded" && !operation.runtime_result.request?.stopOperationId)
        sourceFailed(
          operation.runtime_result.request?.createOperationId ?? operation.runtime_result.noFork!.createOperationId,
          input.id,
        );
      return wire(operation, input.id);
    }
    diagnostics?.stage("recovery_dispatch");
    await sql.transaction(async (tx) => {
      const current = await bound(tx, input, operation);
      if (current.runtime_result.stage !== "reserved") return false;
      await tx.query(
        `update public.orchestrator_operations set runtime_result=jsonb_set(runtime_result,'{stage}','"dispatched"') where id=$1`,
        [operation.id],
      );
      return true;
    });
    let proof: OrchestratorCreateRecoveryProof | null = null;
    try {
      const request = requestOf(operation);
      const provider = await providers.resolve(request.target, { userId: input.ownerId });
      const observe = provider.readOrchestratorCreateRecovery;
      const recover = provider.recoverOrchestratorCreate;
      if (!observe || !recover || provider.id !== "modal") throw new OrchestratorRuntimeError("unavailable");
      diagnostics?.stage("recovery_observation");
      proof = await observe.call(provider, request);
      if (!proof) {
        // Explicit owner recover may idempotently retry only this immutable
        // physical cleanup. The native lease revalidates and polls before acting.
        diagnostics?.stage("recovery_dispatch");
        proof = await recover.call(provider, request);
      }
      diagnostics?.stage("recovery_validation");
      if (
        proof &&
        (proof.version !== 1 ||
          proof.provider !== "modal" ||
          proof.state !== "terminated" ||
          proof.generation !== 1 ||
          proof.originalSandbox?.sandboxId !== request.originalSandbox?.sandboxId ||
          proof.originalSandbox?.providerSandboxId !== request.originalSandbox?.providerSandboxId ||
          proof.originalSandbox?.sqlGeneration !== request.originalSandbox?.sqlGeneration ||
          proof.originalSandbox?.nativeGeneration !== request.originalSandbox?.nativeGeneration ||
          proof.createOperationId !== request.createOperationId ||
          proof.recoveryOperationId !== operation.id ||
          proof.orchestratorId !== input.id ||
          proof.ownerId !== input.ownerId ||
          proof.orgId !== input.orgId ||
          !UUID.test(proof.sandboxId) ||
          !/^modal_[a-f0-9-]{36}$/.test(proof.providerSandboxId) ||
          !/^[A-Za-z0-9_-]{1,160}$/.test(proof.physicalId) ||
          proof.physicalName !==
            `armada-${createHash("sha256").update(proof.providerSandboxId).digest("hex").slice(0, 32)}-1`)
      )
        throw new OrchestratorRuntimeError("conflict");
    } catch (error) {
      proof = null;
      diagnostics?.report("uncertain", error);
    }
    diagnostics?.stage("recovery_publication");
    try {
      const completed = await sql.transaction(async (tx) => {
        const current = await bound(tx, input, operation);
        if (current.state === "succeeded") return wire(current, input.id);
        if (!proof) {
          await tx.query(
            `update public.orchestrator_operations set state='uncertain',error_code='create_recovery_unconfirmed' where id=$1`,
            [operation.id],
          );
          await tx.query(`update public.orchestrators set state='blocked' where id=$1`, [input.id]);
          diagnostics?.reportIfUnreported("uncertain", undefined, "native_stop_unconfirmed");
          return wire({ ...current, state: "uncertain", error_code: "create_recovery_unconfirmed" }, input.id);
        }
        const source = await tx.query(
          `select id from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 and action=$5 and state in ('pending','uncertain') and revision=$4 for update`,
          [
            requestOf(current).stopOperationId ?? requestOf(current).createOperationId,
            input.id,
            input.ownerId,
            input.expectedRevision,
            requestOf(current).stopOperationId ? "stop" : "create",
          ],
        );
        const linked = await tx.query(`select id from public.sandboxes where id=$1`, [proof.sandboxId]);
        const b = requestOf(current).originalSandbox;
        if (
          source.rows.length !== 1 ||
          (b
            ? proof.sandboxId !== b.sandboxId ||
              proof.providerSandboxId !== b.providerSandboxId ||
              linked.rows.length !== 1
            : linked.rows.length !== 0)
        )
          throw new OrchestratorRuntimeError("conflict");
        if (b)
          await tx.query(
            `update public.sandboxes set status='stopped',status_reason=null,stopped_at=coalesce(stopped_at,now()),last_observed_at=now() where id=$1 and lifecycle_generation=$2 and provider_sandbox_id=$3`,
            [b.sandboxId, b.sqlGeneration, b.providerSandboxId],
          );
        await tx.query(`update public.orchestrator_operations set state='failed',error_code=$2 where id=$1`, [
          requestOf(current).stopOperationId ?? requestOf(current).createOperationId,
          requestOf(current).stopOperationId ? "stop_recovered_terminated" : "create_recovered_terminated",
        ]);
        const safeProof: OrchestratorCreateRecoveryProof = {
          version: 1,
          provider: "modal",
          state: "terminated",
          generation: 1,
          createOperationId: proof.createOperationId,
          recoveryOperationId: proof.recoveryOperationId,
          orchestratorId: proof.orchestratorId,
          ownerId: proof.ownerId,
          orgId: proof.orgId,
          sandboxId: proof.sandboxId,
          providerSandboxId: proof.providerSandboxId,
          physicalId: proof.physicalId,
          physicalName: proof.physicalName,
          ...(proof.originalSandbox ? { originalSandbox: { ...proof.originalSandbox } } : {}),
        };
        await tx.query(
          `update public.orchestrator_operations set state='succeeded',error_code=null,runtime_result=jsonb_set(jsonb_set(runtime_result,'{stage}','"terminated"'),'{proof}',$2::jsonb) where id=$1`,
          [operation.id, JSON.stringify(safeProof)],
        );
        await tx.query(`update public.orchestrators set state='stopped' where id=$1`, [input.id]);
        await tx.query(
          `update public.orchestrator_runtime set continuity='unverified',blocked_reason=null,updated_at=now() where orchestrator_id=$1`,
          [input.id],
        );
        const failedCreate: OrchestratorOperation = {
          version: 1,
          id: requestOf(current).stopOperationId ?? requestOf(current).createOperationId,
          orchestratorId: input.id,
          kind: requestOf(current).stopOperationId ? "stop" : "create",
          state: "failed",
          revision: input.expectedRevision,
          errorCode: requestOf(current).stopOperationId ? "stop_recovered_terminated" : "create_recovered_terminated",
        };
        await tx.query(
          `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event) values($1,$2,$3::jsonb),($1,$4,$5::jsonb),($1,$4,$6::jsonb)`,
          [
            input.id,
            input.expectedRevision,
            JSON.stringify({ kind: "operation", operation: failedCreate }),
            Number(operation.revision),
            JSON.stringify({
              kind: "operation",
              operation: wire({ ...current, state: "succeeded", error_code: null }, input.id),
            }),
            JSON.stringify({ kind: "state", state: "stopped", continuity: "unverified" }),
          ],
        );
        return wire({ ...current, state: "succeeded", error_code: null }, input.id);
      });
      if (completed.state === "succeeded" && !requestOf(operation).stopOperationId)
        sourceFailed(requestOf(operation).createOperationId, input.id);
      return completed;
    } catch (error) {
      diagnostics?.report("publication_failed", error);
      throw error;
    }
  };
}
