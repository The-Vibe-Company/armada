import { createHash } from "node:crypto";
import type { OrchestratorOperation } from "@armada/core";
import type {
  OrchestratorCreateRecoveryProof,
  OrchestratorCreateRecoveryRequest,
  ProviderRegistry,
  Sql,
} from "@armada/core/server";
import { reserveOrchestratorOperation } from "@armada/core/server";
import type { OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

type Input = { ownerId: string; orgId: string; id: string; expectedRevision: number; key: string };
type Recovery = {
  version: 1;
  kind: "create_recovery";
  stage: "reserved" | "dispatched" | "terminated";
  request: OrchestratorCreateRecoveryRequest;
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
/** Narrow exception to the busy guard: only the current uncertain create, with no
 * registered sandbox/conversation, may reserve a stop-kind cleanup. No model lookup. */
export function createOrchestratorCreateRecovery(sql: Sql, providers: ProviderRegistry) {
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
        current.sandbox_id !== null ||
        !["blocked", "creating"].includes(current.state)
      )
        throw new OrchestratorRuntimeError("conflict");
      const source = (
        await tx.query<{
          id: string;
          configuration: { provider: string; goldenId: string };
          conversation_id: string | null;
        }>(
          `select p.id,r.configuration,r.conversation_id from public.orchestrator_operations p
         join public.orchestrator_runtime r on r.orchestrator_id=p.orchestrator_id
         where p.orchestrator_id=$1 and p.actor_id=$2 and p.revision=$3 and p.action='create' and p.state='uncertain' for update of p,r`,
          [input.id, input.ownerId, input.expectedRevision],
        )
      ).rows[0];
      if (!source || source.configuration.provider !== "modal" || source.conversation_id !== null)
        throw new OrchestratorRuntimeError("conflict");
      const busy = await tx.query(
        `select id from public.orchestrator_operations where orchestrator_id=$1 and id<>$2 and state in ('pending','uncertain')`,
        [input.id, source.id],
      );
      if (busy.rows.length) throw new OrchestratorRuntimeError("conflict");
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
        request: {
          version: 1,
          createOperationId: source.id,
          recoveryOperationId: id,
          orchestratorId: input.id,
          ownerId: input.ownerId,
          orgId: input.orgId,
          providerSnapshotId: golden.provider_snapshot_id,
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
      await tx.query(`update public.orchestrators set state='stopping' where id=$1`, [input.id]);
      return created;
    });
  }
  async function bound(tx: Sql, input: Input, operation: Operation) {
    const current = await parent(tx, input);
    if (Number(current.revision) !== Number(operation.revision) || current.sandbox_id !== null)
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
      row.runtime_result.request.createOperationId !== operation.runtime_result.request.createOperationId
    )
      throw new OrchestratorRuntimeError("conflict");
    if (row.state !== "succeeded") {
      const original = await tx.query(
        `select id from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 and action='create' and state='uncertain' and revision=$4 for update`,
        [row.runtime_result.request.createOperationId, input.id, input.ownerId, input.expectedRevision],
      );
      if (original.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
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
      const request = operation.runtime_result.request;
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
      return await sql.transaction(async (tx) => {
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
          `select id from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 and action='create' and state='uncertain' and revision=$4 for update`,
          [current.runtime_result.request.createOperationId, input.id, input.ownerId, input.expectedRevision],
        );
        const linked = await tx.query(`select id from public.sandboxes where id=$1`, [proof.sandboxId]);
        if (source.rows.length !== 1 || linked.rows.length) throw new OrchestratorRuntimeError("conflict");
        await tx.query(
          `update public.orchestrator_operations set state='failed',error_code='create_recovered_terminated' where id=$1`,
          [current.runtime_result.request.createOperationId],
        );
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
          id: current.runtime_result.request.createOperationId,
          orchestratorId: input.id,
          kind: "create",
          state: "failed",
          revision: input.expectedRevision,
          errorCode: "create_recovered_terminated",
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
    } catch (error) {
      diagnostics?.report("publication_failed", error);
      throw error;
    }
  };
}
