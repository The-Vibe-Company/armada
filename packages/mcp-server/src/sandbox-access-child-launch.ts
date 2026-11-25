import {
  DelegatedAuthorityDenied,
  failureDiagnostic,
  GoldenError,
  LaunchError,
  ProviderError,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { recordOperatorDiagnostic } from "./request-observability.ts";
import type { ChildOperation } from "./sandbox-access-children.ts";

/** Definitive refusal before a launch job was committed. */
export class ChildLaunchNotAllocated extends Error {
  constructor(
    readonly reason: "preallocation_rejected" | "provider_refused" | "admission_lock_contended",
    readonly guard = "admission",
    cause?: unknown,
  ) {
    super("Child launch was not allocated.", { cause });
  }

  record(operation: Pick<ChildOperation, "id" | "sandboxId">, code: string) {
    const error = this.cause;
    const authorityDenied = error instanceof DelegatedAuthorityDenied;
    const refusalCode =
      error instanceof VaultError ||
      error instanceof LaunchError ||
      error instanceof GoldenError ||
      error instanceof ProviderError
        ? error.code
        : authorityDenied
          ? "authority_denied"
          : this.reason;
    const diagnostic = failureDiagnostic(error ?? this);
    const errorClass =
      error instanceof GoldenError
        ? "GoldenError"
        : authorityDenied
          ? "DelegatedAuthorityDenied"
          : diagnostic.errorClass;
    recordOperatorDiagnostic(
      `scoped.child_launch.${this.guard}`,
      { ...diagnostic, errorClass },
      {
        sandboxId: operation.sandboxId,
        operationId: operation.id,
        code,
        refusalCode,
      },
    );
  }
}

const childLaunchAuthority = `
  from public.orchestrator_child_operations c
  join public.armada_access_parents o on o.id=c.orchestrator_id and o.org_id=c.org_id and o.owner_id=c.owner_id
  join public.sandboxes s on s.id=o.sandbox_id
  join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
  join public.orchestrator_delegations d on d.orchestrator_id=o.id and d.epoch=c.parent_epoch
  where c.id=$1 and c.target_id=$2 and c.action='launch' and c.dispatched_at is not null
    and o.state='ready' and o.authority_epoch=c.parent_epoch
    and (case when o.kind='sandbox' then o.generation else s.lifecycle_generation end)=c.parent_generation
    and s.stop_requested_at is null and s.status not in ('stopped','deleted','failed')
    and d.native_generation=s.orchestrator_native_generation
    and d.revoked_at is null and d.acknowledged_at is not null and d.expires_at>clock_timestamp()
    and 'worker:launch'=any(d.scopes)`;

const childLaunchLockBudget = "set local lock_timeout = '2s'";

export async function lockChildLaunchAdmission(tx: Sql, operation: ChildOperation) {
  await tx.query(childLaunchLockBudget);
  const {
    rows: [row],
  } = await tx.query<{ request_digest: string }>(
    `with locked as materialized (
      select c.request_digest,d.expires_at ${childLaunchAuthority} and c.state='pending'
        and c.org_id=$3 and c.owner_id=$4 and c.orchestrator_id=$5 and c.parent_generation=$6 and c.parent_epoch=$7
        for no key update of c for share of o,s,m,d
    )
    select request_digest from locked where expires_at>clock_timestamp()`,
    [
      operation.id,
      operation.sandboxId,
      operation.orgId,
      operation.ownerId,
      operation.orchestratorId,
      operation.parentGeneration,
      operation.parentEpoch,
    ],
  );
  if (!row) throw new ChildLaunchNotAllocated("preallocation_rejected", "parent_authority");
  return row.request_digest;
}

export async function completeChildLaunchAdmission(tx: Sql, operation: ChildOperation) {
  await tx.query(
    `insert into public.orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)`,
    [operation.sandboxId, operation.orchestratorId, operation.orgId, operation.ownerId],
  );
  await tx.query("update public.orchestrator_child_operations set state='succeeded',error_code=null where id=$1", [
    operation.id,
  ]);
}

export async function childLaunchAuthorized(tx: Sql, sandboxId: string, operationId?: string) {
  if (operationId === undefined) return true;
  await tx.query(childLaunchLockBudget);
  const { rows } = await tx.query(
    `with locked as materialized (
      select d.expires_at ${childLaunchAuthority} and c.state='succeeded'
        and exists(select 1 from public.orchestrator_children r where r.sandbox_id=c.target_id
          and r.orchestrator_id=c.orchestrator_id and r.org_id=c.org_id and r.owner_id=c.owner_id)
        for share of o,s,m,d
    )
    select 1 from locked where expires_at>clock_timestamp()`,
    [operationId, sandboxId],
  );
  return rows.length > 0;
}
