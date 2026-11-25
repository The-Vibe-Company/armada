import { createHash } from "node:crypto";
import { MAX_SANDBOX_EXTENSION_TTL_SECONDS } from "@armada/core";
import {
  DelegatedAuthorityDenied,
  failureDiagnostic,
  type Harness,
  type LaunchRequest,
  parseMachineSize,
  type Sql,
  validateSkillPins,
} from "@armada/core/server";
import type { ChildAuthority } from "./child-authority.ts";
import { DataError } from "./data.ts";
import { ModalLaunchSetupConflict } from "./jobs/modal-launch-setup.ts";
import { recordOperatorDiagnostic } from "./request-observability.ts";
import { RuntimeFollowupConflict } from "./runtime-followup.ts";
import { RuntimeCheckpointActivityConflict, RuntimeReconciliationConflict } from "./runtime-reconciliation-conflict.ts";
import { ChildLaunchNotAllocated } from "./sandbox-access-child-launch.ts";
import { ToolError } from "./tool-error.ts";
import { trackedOperations } from "./tracked-operations.ts";
import { SANDBOX_ADMISSION_TIMEOUT_MS, waitForSandboxAdmission } from "./wake-bus.ts";

function recordUncertainMessageReceipt(
  receipt: { id: string; sandboxId: string },
  causeCode: "prior_uncertain_receipt" | "dispatch_claim_missing",
): void {
  recordOperatorDiagnostic(
    "scoped.child_message.receipt",
    { errorClass: "ChildReceiptUncertain", message: "Child message outcome unconfirmed", stack: [] },
    {
      operationId: receipt.id,
      sandboxId: receipt.sandboxId.toLowerCase(),
      code: "child_outcome_unconfirmed",
      causeCode,
    },
  );
}

export interface ChildLaunchSelection {
  goldenId: string;
  harness: Harness;
  credentialId: string;
  credentialVersion: number;
  model: string;
  size?: NonNullable<LaunchRequest["size"]>;
  reasoningEffort?: string;
  skills?: string[];
  repo?: string;
  prompt?: string;
}
export interface ChildOperation {
  id: string;
  orchestratorId: string;
  ownerId: string;
  orgId: string;
  parentGeneration: string;
  parentEpoch: string;
  action: "launch" | "message" | "stop" | "extend";
  sandboxId: string;
}
type ChildDispatch = {
  id: string;
  orchestrator_id: string;
  owner_id: string;
  org_id: string;
  parent_generation: string;
  parent_epoch: string;
  target_id: string;
  action: ChildOperation["action"];
};
export class ChildStopNotAdmitted extends Error {
  constructor(readonly reason: "sandbox_not_ready" | "stop_target_changed") {
    super(reason);
  }
}
class ChildAdmissionCancelled extends Error {}

function blockedBeforeDispatch(error: unknown) {
  const cause = error instanceof DataError ? error.cause : error;
  return cause instanceof RuntimeReconciliationConflict || cause instanceof RuntimeCheckpointActivityConflict
    ? cause
    : undefined;
}

export type StopRecoveryAdmission = (work: (tx: Sql) => Promise<void>) => Promise<void>;

/** Launch commits the job, child relation and operation receipt for the reserved sandbox ID. */
export interface SandboxChildExecutor {
  launch(operation: ChildOperation, selection: ChildLaunchSelection): Promise<void>;
  message(operation: ChildOperation, text: string): Promise<void>;
  stop(operation: ChildOperation): Promise<void>;
  recoverStop?(operation: ChildOperation, admit: StopRecoveryAdmission): Promise<void>;
  extend?(operation: ChildOperation, ttlSeconds: number): Promise<void>;
  /** Exact original receipt discovery only; absence/timeout must return unknown. */
  reconcile(
    operation: ChildOperation,
    signal?: AbortSignal,
  ): Promise<{
    operationId: string;
    sandboxId: string;
    state: "succeeded" | "failed" | "unknown";
  }>;
  read(sandboxId: string, ownerId: string, orgId: string): Promise<unknown>;
}

export function createSandboxChildren(sql: Sql, authority: ChildAuthority, executor: SandboxChildExecutor) {
  const operations = trackedOperations();
  const shutdown = new AbortController();
  async function mutate(
    token: string,
    key: string,
    input:
      | { action: "launch"; selection: ChildLaunchSelection }
      | { action: "message"; sandboxId: string; text: string }
      | { action: "stop"; sandboxId: string }
      | { action: "extend"; sandboxId: string; ttlSeconds: number },
    signal?: AbortSignal,
  ) {
    if (
      input.action === "extend" &&
      (!Number.isSafeInteger(input.ttlSeconds) ||
        input.ttlSeconds < 1 ||
        input.ttlSeconds > MAX_SANDBOX_EXTENSION_TTL_SECONDS)
    )
      throw new Error("Invalid extension duration.");
    if (!/^[ -~]{1,128}$/.test(key) || (input.action === "message" && !input.text.trim()))
      throw new Error("Invalid child operation.");
    if (input.action === "launch") {
      const selected = input.selection;
      const allowed = [
        "goldenId",
        "harness",
        "credentialId",
        "credentialVersion",
        "model",
        "reasoningEffort",
        "skills",
        "repo",
        "prompt",
        "size",
      ];
      if (
        !selected ||
        typeof selected !== "object" ||
        Array.isArray(selected) ||
        Object.keys(selected).some((field) => !allowed.includes(field)) ||
        typeof selected.model !== "string" ||
        !selected.model.trim() ||
        [selected.repo, selected.reasoningEffort, selected.prompt].some(
          (value) => value !== undefined && (typeof value !== "string" || !value.trim()),
        )
      )
        throw new Error("Invalid child launch selection.");
      validateSkillPins(selected.skills ?? []);
      if (selected.size !== undefined) parseMachineSize(selected.size);
    }
    // Canonical field inventory, not user JSON key order; omit absent optional fields explicitly.
    const body =
      input.action === "launch"
        ? [
            input.selection.goldenId,
            input.selection.harness,
            input.selection.credentialId,
            input.selection.credentialVersion,
            input.selection.model,
            input.selection.reasoningEffort ?? null,
            input.selection.repo ?? null,
            input.selection.prompt ?? null,
            input.selection.size ?? null,
            ...(input.selection.skills?.length ? [input.selection.skills] : []),
          ]
        : [
            input.sandboxId,
            input.action === "message" ? input.text : input.action === "extend" ? input.ttlSeconds : null,
          ];
    const digest = createHash("sha256")
      .update(JSON.stringify([input.action, body]))
      .digest("hex");
    const request =
      input.action === "launch"
        ? { ...input.selection, method: "launch" }
        : { method: input.action, childId: input.sandboxId };
    const receipt = await authority.admit(token, request, async (tx, principal) => {
      const prior = (
        await tx.query<ChildDispatch & { state: string; request_digest: string; recoverable: boolean }>(
          `select c.id,c.state,c.request_digest,c.target_id,c.orchestrator_id,c.owner_id,c.org_id,c.parent_generation,
                   c.parent_epoch,c.action,
                   (c.dispatched_at is not null and o.authority_epoch=c.parent_epoch
                    and (case when o.kind='sandbox' then o.generation else s.lifecycle_generation end)=c.parent_generation) as recoverable
           from public.orchestrator_child_operations c join public.armada_access_parents o on o.id=c.orchestrator_id
           join public.sandboxes s on s.id=o.sandbox_id
           where c.orchestrator_id=$1 and c.action=$2 and c.idempotency_key=$3 and c.scope_target=$4`,
          [
            principal.orchestratorId,
            input.action,
            key,
            input.action === "launch" ? principal.orchestratorId : input.sandboxId,
          ],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new Error("Idempotency conflict.");
        const recovery =
          input.action === "stop" && ["pending", "uncertain"].includes(prior.state) && prior.recoverable
            ? prior
            : undefined;
        return { id: prior.id, state: prior.state, sandboxId: prior.target_id, fresh: false, recovery };
      }
      const parent = (
        await tx.query<{ lifecycle_generation: string; parent_epoch: string; max_active_children: number | null }>(
          `select case when o.kind='sandbox' then o.generation else s.lifecycle_generation end as lifecycle_generation,o.authority_epoch as parent_epoch,l.max_active_children from public.armada_access_parents o
           join public.sandboxes s on s.id=o.sandbox_id
           left join public.orchestrator_lifecycle l on l.orchestrator_id=o.id where o.id=$1`,
          [principal.orchestratorId],
        )
      ).rows[0];
      if (!parent) throw new Error("Parent unavailable.");
      if (input.action === "launch" && parent.max_active_children !== null) {
        const count = (
          await tx.query<{ count: string }>(
            `select count(*) as count from (
              select c.sandbox_id from public.orchestrator_children c join public.sandboxes s on s.id=c.sandbox_id
                where c.orchestrator_id=$1 and s.status not in ('stopped','deleted') and not (s.status='failed' and s.stopped_at is not null)
              union select target_id from public.orchestrator_child_operations
                where orchestrator_id=$1 and action='launch' and state in ('pending','uncertain')
            ) active`,
            [principal.orchestratorId],
          )
        ).rows[0];
        if (!count || Number(count.count) >= parent.max_active_children) throw new Error("Owner child policy reached.");
      }
      const id = crypto.randomUUID();
      const target = input.action === "launch" ? crypto.randomUUID() : input.sandboxId;
      await tx.query(
        `insert into public.orchestrator_child_operations
          (id,orchestrator_id,owner_id,org_id,parent_generation,action,target_id,idempotency_key,request_digest,scope_target,parent_epoch,reconcile_after,error_code)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
            clock_timestamp() + $12::integer * interval '1 millisecond',
            case when $6='launch' then 'child_launch_admission_pending' end)`,
        [
          id,
          principal.orchestratorId,
          principal.ownerId,
          principal.orgId,
          parent.lifecycle_generation,
          input.action,
          target,
          key,
          digest,
          input.action === "launch" ? principal.orchestratorId : input.sandboxId,
          parent.parent_epoch,
          SANDBOX_ADMISSION_TIMEOUT_MS,
        ],
      );
      // Children have independent receipts; never invalidate a pending owner prompt's revision.
      await tx.query(
        `insert into public.orchestrator_lifecycle(orchestrator_id,last_activity_at,reason)
        values($1,clock_timestamp(),'child_operation') on conflict(orchestrator_id) do update set
        last_activity_at=clock_timestamp(),observation_state='unknown',reason='child_operation',reconcile_after=clock_timestamp()`,
        [principal.orchestratorId],
      );
      return { id, state: "pending", sandboxId: target, fresh: true };
    });
    const recoverStop = executor.recoverStop;
    const recovery = recoverStop ? receipt.recovery : undefined;
    if (!receipt.fresh && !recovery) {
      if (input.action === "message" && receipt.state === "uncertain")
        recordUncertainMessageReceipt(receipt, "prior_uncertain_receipt");
      return { id: receipt.id, state: receipt.state, sandboxId: receipt.sandboxId };
    }
    const deadline = AbortSignal.timeout(SANDBOX_ADMISSION_TIMEOUT_MS);
    const admissionSignal = AbortSignal.any([shutdown.signal, deadline, ...(signal ? [signal] : [])]);
    async function admitDispatch(resumingAdmission: boolean) {
      return waitForSandboxAdmission(
        admissionSignal,
        () =>
          authority.admit(token, request, async (tx) => {
            if (input.action !== "launch") {
              const {
                rows: [lease],
              } = await tx.query<{ busy: boolean; extension_refused: boolean }>(
                `select (coalesce(reconcile_lease_until>clock_timestamp(),false)
                      or ($2='message' and status='starting')
                      or ($2='stop' and (boat_runtime or runtime_transport is not distinct from 'dialout')
                        and activity_lease_id is not null)) as busy,
                      ($2='extend' and boat_runtime) as extension_refused
                  from public.sandboxes where id=$1`,
                [receipt.sandboxId, input.action],
              );
              if (!lease) throw new Error("Child sandbox disappeared during admission.");
              if (lease.extension_refused)
                throw new ToolError("extension_state", "Enrolled Boat sandboxes do not support lifetime extension.");
              if (lease.busy) return { busy: true as const };
            }
            admissionSignal.throwIfAborted();
            const {
              rows: [dispatch],
            } = await tx.query<ChildDispatch>(
              `update public.orchestrator_child_operations c set dispatched_at=coalesce(c.dispatched_at,now()),
                 reconcile_after=case when $2 or c.action='launch' then c.reconcile_after else now() end
               from public.armada_access_parents o join public.sandboxes s on s.id=o.sandbox_id
               where c.id=$1 and o.id=c.orchestrator_id and o.authority_epoch=c.parent_epoch
                 and (case when o.kind='sandbox' then o.generation else s.lifecycle_generation end)=c.parent_generation
                 and (c.dispatched_at is not null)=$2 and c.state='pending'
               returning c.id,c.orchestrator_id,c.owner_id,c.org_id,c.parent_generation,c.parent_epoch,c.target_id,c.action`,
              [receipt.id, resumingAdmission],
            );
            return { busy: false as const, result: dispatch };
          }),
        resumingAdmission,
      );
    }
    // Claim fresh dispatch once. Recovery may continue only at the checkpoint boundary.
    let row: ChildDispatch | undefined = recovery;
    if (!row) {
      try {
        row = await admitDispatch(false);
      } catch (error) {
        const diagnostic = failureDiagnostic(error);
        const denied = error instanceof DelegatedAuthorityDenied;
        const code = "child_dispatch_not_admitted";
        recordOperatorDiagnostic(
          `scoped.child_${input.action}.dispatch_admission`,
          denied ? { ...diagnostic, errorClass: "DelegatedAuthorityDenied" } : diagnostic,
          {
            sandboxId: receipt.sandboxId,
            operationId: receipt.id,
            code,
            refusalCode: denied
              ? "authority_denied"
              : error instanceof ToolError
                ? error.code
                : "dispatch_admission_error",
          },
        );
        // No executor was invoked. Failed fresh admission is confirmed non-allocation,
        // distinct from an unknown provider outcome after dispatch.
        await sql.query(
          `update public.orchestrator_child_operations set state='failed',error_code=$2 where id=$1 and state='pending'`,
          [receipt.id, code],
        );
        return { id: receipt.id, state: "failed", sandboxId: receipt.sandboxId };
      }
    }
    if (!row) {
      const {
        rows: [current],
      } = await sql.query<{ state: string }>("select state from public.orchestrator_child_operations where id=$1", [
        receipt.id,
      ]);
      if (current?.state === "failed" || current?.state === "succeeded")
        return { id: receipt.id, state: current.state, sandboxId: receipt.sandboxId };
      if (input.action === "message") recordUncertainMessageReceipt(receipt, "dispatch_claim_missing");
      return { id: receipt.id, state: "uncertain", sandboxId: receipt.sandboxId };
    }
    const operation: ChildOperation = {
      id: row.id,
      orchestratorId: row.orchestrator_id,
      ownerId: row.owner_id,
      orgId: row.org_id,
      parentGeneration: String(row.parent_generation),
      parentEpoch: String(row.parent_epoch),
      sandboxId: row.target_id,
      action: row.action,
    };
    let phase: "execution" | "completion" = "execution";
    try {
      if (input.action === "launch") {
        if (admissionSignal.aborted) throw new ChildAdmissionCancelled();
        await executor.launch(operation, input.selection);
        return { id: row.id, state: "succeeded", sandboxId: row.target_id };
      } else if (recovery && recoverStop) {
        await recoverStop(operation, (work) =>
          authority.admit(token, request, async (tx, principal) => {
            if (
              principal.orchestratorId !== operation.orchestratorId ||
              principal.ownerId !== operation.ownerId ||
              principal.orgId !== operation.orgId ||
              !(
                await tx.query(
                  `update public.orchestrator_child_operations c
                 set state='uncertain',error_code='child_outcome_unconfirmed'
                 from public.armada_access_parents o join public.sandboxes s on s.id=o.sandbox_id
                 where c.id=$1 and o.id=c.orchestrator_id and c.state in ('pending','uncertain')
                 and o.authority_epoch=c.parent_epoch
                 and (case when o.kind='sandbox' then o.generation else s.lifecycle_generation end)=c.parent_generation
                 returning c.id`,
                  [operation.id],
                )
              ).rows.length
            )
              throw Error("Scoped stop recovery is no longer authorized.");
            await work(tx);
          }),
        );
      } else {
        while (true) {
          if (admissionSignal.aborted) throw new ChildAdmissionCancelled();
          try {
            if (input.action === "message") await executor.message(operation, input.text);
            else if (input.action === "extend") {
              if (!executor.extend) throw new Error("Child extension unavailable.");
              await executor.extend(operation, input.ttlSeconds);
            } else await executor.stop(operation);
            break;
          } catch (error) {
            if (!blockedBeforeDispatch(error)) throw error;
            if (!(await admitDispatch(true).catch(() => undefined))) throw error;
          }
        }
      }
      phase = "completion";
      const completed = await sql.query(
        `update public.orchestrator_child_operations c set state='succeeded',error_code=null
        from public.armada_access_parents o,public.sandboxes s where c.id=$1 and o.id=c.orchestrator_id
        and s.id=o.sandbox_id and (case when o.kind='sandbox' then o.generation else s.lifecycle_generation end)=c.parent_generation and o.state='ready' and c.state in ('pending','uncertain')
        and (not $2::boolean or o.authority_epoch=c.parent_epoch) returning c.id`,
        [row.id, !!recovery],
      );
      if (!completed.rows.length) {
        const existing = (
          await sql.query<{ state: string }>(`select state from public.orchestrator_child_operations where id=$1`, [
            row.id,
          ])
        ).rows[0];
        if (existing && ["succeeded", "failed"].includes(existing.state))
          return { id: row.id, state: existing.state, sandboxId: row.target_id };
        throw new Error("Child completion generation changed.");
      }
      return { id: row.id, state: "succeeded", sandboxId: row.target_id };
    } catch (error) {
      const noAllocation = input.action === "launch" && error instanceof ChildLaunchNotAllocated;
      const refusal = blockedBeforeDispatch(error);
      const executionRefusal =
        !recovery && phase === "execution" && input.action !== "launch"
          ? (refusal?.reason ??
            (input.action === "message" &&
            (error instanceof ModalLaunchSetupConflict ||
              (error instanceof RuntimeFollowupConflict && error.reason === "sandbox_not_ready"))
              ? error.reason
              : undefined) ??
            (input.action === "stop" && error instanceof ChildStopNotAdmitted ? error.reason : undefined))
          : undefined;
      const notDispatched = error instanceof ChildAdmissionCancelled || executionRefusal !== undefined;
      const state = noAllocation || notDispatched ? "failed" : "uncertain";
      const code = noAllocation
        ? `child_${error.reason}`
        : notDispatched
          ? "child_dispatch_not_admitted"
          : "child_outcome_unconfirmed";
      if (noAllocation) error.record(operation, code);
      else {
        const refusalCode = error instanceof ChildAdmissionCancelled ? "admission_cancelled" : executionRefusal;
        const executionCause =
          error instanceof RuntimeFollowupConflict
            ? error.reason
            : refusal !== undefined
              ? refusal.reason
              : "execution_unconfirmed";
        const causeCode =
          state === "uncertain" ? (phase === "completion" ? "completion_unconfirmed" : executionCause) : undefined;
        recordOperatorDiagnostic(`scoped.child_${input.action}.${phase}`, failureDiagnostic(error), {
          sandboxId: operation.sandboxId,
          operationId: operation.id,
          code,
          refusalCode,
          causeCode,
        });
      }
      // An unexpected launch error might be the response to a committed admission.
      // Leave pending for recovery once its admission window expires.
      if (!recovery && (input.action !== "launch" || state === "failed"))
        await sql.query(
          `update public.orchestrator_child_operations set state=$2,error_code=$3 where id=$1 and state in ('pending','uncertain')`,
          [row.id, state, code],
        );
      const current = (
        await sql.query<{ state: string }>(`select state from public.orchestrator_child_operations where id=$1`, [
          row.id,
        ])
      ).rows[0];
      return {
        id: row.id,
        state: input.action === "launch" && current?.state === "pending" ? state : (current?.state ?? state),
        sandboxId: row.target_id,
      };
    }
  }
  return {
    /** One bounded receipt-discovery batch, reusable in the existing server lane.
     * No provider create, prompt replay or globally frozen allocation queue. */
    stopAdmission: () => shutdown.abort(),
    drain: operations.drain,
    async reconcileOne(signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const lease = crypto.randomUUID();
      const row = (
        await sql.query<{
          id: string;
          orchestrator_id: string;
          owner_id: string;
          org_id: string;
          parent_generation: string;
          parent_epoch: string;
          action: ChildOperation["action"];
          target_id: string;
          abandoned: boolean;
        }>(
          `with candidate as (
          select id,(state='pending' and (dispatched_at is null or action='launch')) as abandoned
          from public.orchestrator_child_operations c where state in ('pending','uncertain')
            and reconcile_after<=now() and (reconcile_until is null or reconcile_until<now())
            and (action<>'launch' or (state='pending' and provider_sandbox_id is null
              and (dispatched_at is null or error_code='child_launch_admission_pending') and not exists(
              select 1 from public.jobs where kind='launch' and sandbox_id=c.target_id
                and org_id=c.org_id and request_owner_id=c.owner_id
            )))
          order by created_at for update skip locked limit 1
        )
        update public.orchestrator_child_operations c
          set state=case when candidate.abandoned then 'failed' else c.state end,
              error_code=case when candidate.abandoned then 'child_dispatch_not_admitted' else c.error_code end,
              reconcile_lease=case when not candidate.abandoned then $1::uuid end,
              reconcile_until=case when not candidate.abandoned then now()+interval '2 minutes' end
        from candidate where c.id=candidate.id
        returning c.id,c.orchestrator_id,c.owner_id,c.org_id,c.parent_generation,c.parent_epoch,c.action,
                  c.target_id,candidate.abandoned`,
          [lease],
        )
      ).rows[0];
      if (!row) return false;
      if (row.abandoned) return true;
      const operation: ChildOperation = {
        id: row.id,
        orchestratorId: row.orchestrator_id,
        ownerId: row.owner_id,
        orgId: row.org_id,
        parentGeneration: String(row.parent_generation),
        parentEpoch: String(row.parent_epoch),
        action: row.action,
        sandboxId: row.target_id,
      };
      let state = "uncertain";
      try {
        const found = await operations.run(() => executor.reconcile(operation, signal), signal);
        if (found.operationId !== row.id || found.sandboxId !== row.target_id)
          throw Error("Uncorrelated child receipt.");
        if (found.state !== "unknown") state = found.state;
      } catch {
        /* Unknown cannot become confirmed non-execution. */
      }
      await sql.query(
        `update public.orchestrator_child_operations set state=case when $3='uncertain' and state='pending' then state else $3 end,
        error_code=case when $3='uncertain' then 'child_outcome_unconfirmed' else null end,
        reconcile_lease=null,reconcile_until=null,reconcile_after=now()+interval '1 minute'
        where id=$1 and reconcile_lease=$2 and reconcile_until>now() and state in ('pending','uncertain')`,
        [row.id, lease, state],
      );
      // A delayed observation must never rewrite a confirmed terminal outcome.
      await sql.query(
        `update public.orchestrator_child_operations set reconcile_lease=null,reconcile_until=null
        where id=$1 and reconcile_lease=$2 and state in ('succeeded','failed')`,
        [row.id, lease],
      );
      return true;
    },
    launch: (token: string, key: string, selection: ChildLaunchSelection) =>
      mutate(token, key, { action: "launch", selection }),
    message: (token: string, key: string, sandboxId: string, text: string, signal?: AbortSignal) =>
      mutate(token, key, { action: "message", sandboxId, text }, signal),
    stop: (token: string, key: string, sandboxId: string, signal?: AbortSignal) =>
      mutate(token, key, { action: "stop", sandboxId }, signal),
    extend: (token: string, key: string, sandboxId: string, ttlSeconds: number, signal?: AbortSignal) =>
      mutate(token, key, { action: "extend", sandboxId, ttlSeconds }, signal),
    async read(token: string, sandboxId: string) {
      const identity = await authority.admit(token, { method: "read", childId: sandboxId }, async (_tx, p) => p);
      return executor.read(sandboxId, identity.ownerId, identity.orgId);
    },
  };
}
