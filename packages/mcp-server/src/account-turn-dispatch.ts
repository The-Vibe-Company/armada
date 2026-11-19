import { API_FAILURE_STATUS } from "@armada/core";
import { sandboxOperations } from "@armada/core/contract";
import { decryptSecret, encryptSecret, failureDiagnostic, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { continueRequest, recordOperatorDiagnostic } from "./request-observability.ts";
import type { RuntimeFollowupInput } from "./runtime-followup.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";

export const RUNTIME_REQUEST_EVIDENCE = `(s.activity_lease_id=q.request_id
  or exists(select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.request_id in ('follow_'||q.request_id::text,'docker_prompt_'||q.request_id::text,'resume_'||q.request_id::text))
  or exists(select 1 from public.runtime_resumes r where r.sandbox_id=s.id and r.request_id=q.request_id)
  or exists(select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id and j.request_id=q.request_id))`;
export const QUEUED_DISPATCH_EVIDENCE = `(q.native_prompt_id is not null
  or (s.task_prompt_id=q.request_id::text) is true or (${RUNTIME_REQUEST_EVIDENCE}) is true)`;
export const RUNTIME_LANE = `(s.provider='docker' or s.boat_runtime or s.runtime_transport='dialout')`;

const TURN_LIFECYCLE_CANCELLED = `(s.deleted_at is not null or s.expires_at <= now() or s.stop_requested_at is not null
  or (s.status = 'stopped' and s.lifecycle_generation <> q.queued_generation))`;

export const QUEUED_TURN_CANCELLED = `(${TURN_LIFECYCLE_CANCELLED} or s.status not in ('ready','running','stopped'))`;
export const DISPATCHING_TURN_CANCELLED = `(${TURN_LIFECYCLE_CANCELLED} or s.status in ('deleted','stopping','failed'))`;

export async function failTurnReceipt(tx: Sql, sandboxId: string, requestId: string) {
  await tx.query(
    `update public.account_turn_queue q set state='failed', failure_reason=case
       when q.state='dispatching' then 'Dispatch cancelled by confirmed stop.'
       when ${QUEUED_DISPATCH_EVIDENCE}
         then 'Queued receipt already has dispatch evidence; inspect sandbox history before resending.'
       else 'Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.' end
     from public.sandboxes s
     where q.sandbox_id=$1 and q.request_id=$2 and q.state in ('queued','dispatching') and s.id=q.sandbox_id`,
    [sandboxId, requestId],
  );
}

const dispatchRefusalCodes = new Set([
  ...Object.keys(API_FAILURE_STATUS),
  ...sandboxOperations.sendPrompt.errors,
  "missing_credential",
]);

type DispatchEntry = {
  account_id: string;
  sandbox_id: string;
  sequence: string;
  request_id: string;
  input_enc: Uint8Array<ArrayBuffer>;
};

export type DispatchTurn = (caller: Caller, input: RuntimeFollowupInput) => Promise<unknown>;

export async function dispatchAccountTurn(
  sql: Sql,
  key: string,
  entry: DispatchEntry,
  caller: Caller,
  dispatch: DispatchTurn,
) {
  let correlationId: string | undefined;
  let phase = "decrypt";
  try {
    const {
      correlationId: savedCorrelationId,
      id,
      request_id,
      prompt,
      model,
      reasoning_effort,
    } = JSON.parse(await decryptSecret(entry.input_enc, key)) as RuntimeFollowupInput & { correlationId?: string };
    correlationId = savedCorrelationId;
    phase = "send";
    const result = await continueRequest(correlationId, () =>
      dispatch(caller, { id, request_id, prompt, model, reasoning_effort }),
    );
    phase = "publish_receipt";
    await sql.query(
      `with admitted as (update public.account_turn_queue set state='admitted',result_enc=$3
           where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
         delete from public.account_agent_reservations r using admitted a where r.sandbox_id=a.sandbox_id`,
      [id, entry.request_id, await encryptSecret(JSON.stringify(result), key)],
    );
  } catch (error) {
    const origin = error instanceof ToolApiError ? (error.cause ?? error) : error;
    const refusalCode =
      error instanceof ToolApiError || error instanceof VaultError || error instanceof ToolError
        ? error.code
        : undefined;
    const secretRefused =
      (error instanceof ToolApiError || error instanceof VaultError) &&
      error.code === "conflict" &&
      (error.message === "Template launch refused: secret_unavailable." ||
        error.message === "Template launch refused: secret_version_changed.");
    const rejected = await sql.transaction!(async (tx) => {
      await tx.query("select id from public.credentials where id=$1 for update", [entry.account_id]);
      const unchanged = await tx.query<{ stopped_runtime: boolean }>(
        `select (s.status='stopped' and coalesce(${RUNTIME_LANE},false)) as stopped_runtime from public.sandboxes s
        join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$2
        where s.id=$1 and q.state='dispatching' and s.lifecycle_generation=q.dispatch_generation
        and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
        and ((s.activity_lease_id is null and (s.status in ('ready','running')
          or ($3 and (s.provider='modal' or s.boat_runtime) and s.status='stopped')))
          or ($4 and s.status='stopped' and coalesce(${RUNTIME_LANE},false)))
        and not coalesce(${RUNTIME_REQUEST_EVIDENCE},false)
        for update of s,q`,
        [entry.sandbox_id, entry.request_id, secretRefused, refusalCode !== undefined],
      );
      const target = unchanged.rows[0];
      if (target) {
        const retry =
          !target.stopped_runtime &&
          !secretRefused &&
          origin instanceof VaultError &&
          (origin.code === "conflict" || origin.code === "unavailable");
        await tx.query(
          `with retried as (update public.account_turn_queue set state=$3,failure_reason=$4,dispatch_generation=null,dispatch_until=null
          where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
          delete from public.account_agent_reservations r using retried q where r.sandbox_id=q.sandbox_id`,
          [
            entry.sandbox_id,
            entry.request_id,
            retry ? "queued" : "failed",
            retry
              ? null
              : "Queued prompt rejected before dispatch; inspect sandbox and account settings before resending.",
          ],
        );
        return !retry;
      } else {
        await tx.query(
          `update public.account_turn_queue q set failure_reason='Dispatch outcome uncertain; inspect sandbox history before resending.',
           state=case when coalesce(${RUNTIME_LANE},false) then q.state else 'failed' end,
           dispatch_until=case when not coalesce(${RUNTIME_LANE},false) then null when ${RUNTIME_REQUEST_EVIDENCE} then now() else q.dispatch_until end
           from public.sandboxes s where s.id=q.sandbox_id and q.sandbox_id=$1 and q.request_id=$2 and q.state='dispatching'`,
          [entry.sandbox_id, entry.request_id],
        );
      }
      return false;
    });
    if (rejected) {
      const diagnostic = failureDiagnostic(origin);
      const errorClass =
        origin instanceof ToolApiError
          ? "ToolApiError"
          : origin instanceof ToolError
            ? "ToolError"
            : diagnostic.errorClass;
      recordOperatorDiagnostic(
        `account_turn.dispatch.${phase}`,
        { ...diagnostic, errorClass },
        {
          sandboxId: entry.sandbox_id,
          operationSequence: String(entry.sequence),
          correlationId: correlationId ?? null,
          code: refusalCode && dispatchRefusalCodes.has(refusalCode) ? refusalCode : undefined,
        },
      );
    }
  }
}
