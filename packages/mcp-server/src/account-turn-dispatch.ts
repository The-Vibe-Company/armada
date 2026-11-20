import { API_FAILURE_STATUS } from "@armada/core";
import { sandboxOperations } from "@armada/core/contract";
import { decryptSecret, encryptSecret, failureDiagnostic, type Sql, VaultError } from "@armada/core/server";
import { admitAccountCapacity } from "./account-capacity.ts";
import type { Caller } from "./caller.ts";
import type { Job } from "./jobs/runner.ts";
import { continueRequest, recordOperatorDiagnostic } from "./request-observability.ts";
import type { RuntimeFollowupInput } from "./runtime-followup.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";

export const TURN_FIFO_ELIGIBLE = `(exists(select 1 from public.credentials c where c.id=q.account_id and c.max_agents is null) or not exists(select 1 from public.account_turn_queue earlier where earlier.account_id=q.account_id and earlier.state='queued' and earlier.model is not distinct from q.model and earlier.sequence<q.sequence))`;

export const RUNTIME_REQUEST_EVIDENCE = `(s.activity_lease_id=q.request_id
  or exists(select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.request_id in ('follow_'||q.request_id::text,'docker_prompt_'||q.request_id::text,'resume_'||q.request_id::text))
  or exists(select 1 from public.runtime_resumes r where r.sandbox_id=s.id and r.request_id=q.request_id)
  or exists(select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id and j.request_id=q.request_id))`;
export const QUEUED_DISPATCH_EVIDENCE = `(q.native_prompt_id is not null
  or (s.task_prompt_id=q.request_id::text) is true or (${RUNTIME_REQUEST_EVIDENCE}) is true)`;
export const RUNTIME_LANE = `(s.provider='docker' or s.boat_runtime or s.runtime_transport='dialout')`;
export const UNSETTLED_TASK = `s.task_prompt_id is not null
  and (s.status='running' or (s.status='ready' and ${RUNTIME_LANE} and s.provider<>'docker'))
  and not exists(select 1 from public.runtime_idle_turns t
    where t.sandbox_id=s.id and t.prompt_id=s.task_prompt_id and t.settled)`;

export const NATIVE_DISPATCH_UNCERTAIN = `(not coalesce(${RUNTIME_LANE},false)
  and (s.lifecycle_generation is distinct from q.dispatch_generation
    or s.activity_lease_id is not null or ${QUEUED_DISPATCH_EVIDENCE}))`;
export const DISPATCH_ABANDONED = `(q.dispatch_until <= clock_timestamp()
  and s.stop_requested_at is null and s.deleted_at is null and s.expires_at > clock_timestamp()
  and (s.status in ('ready','running') or (s.status='stopped' and s.lifecycle_generation=q.queued_generation
    and not (s.provider='docker' and exists(
      select 1 from public.docker_resume_claims c where c.sandbox_id=s.id and c.request_id=q.request_id
    ))))
  and s.lifecycle_generation=q.dispatch_generation
  and s.activity_lease_id is null and not ${QUEUED_DISPATCH_EVIDENCE})`;
export const UNCERTAIN_DISPATCH_MESSAGE = "Dispatch outcome uncertain; inspect sandbox history before resending.";

const TURN_LIFECYCLE_CANCELLED = `(s.deleted_at is not null or s.expires_at <= now() or s.stop_requested_at is not null
  or (s.status = 'stopped' and s.lifecycle_generation <> q.queued_generation))`;

export const QUEUED_TURN_CANCELLED = `(${TURN_LIFECYCLE_CANCELLED} or s.status not in ('ready','running','stopped'))`;
export const DISPATCHING_TURN_CANCELLED = `(${TURN_LIFECYCLE_CANCELLED} or s.status in ('deleted','stopping','failed'))`;

export async function failTurnReceipt(tx: Sql, sandboxId: string, requestId: string, uncertain = false) {
  await tx.query(
    `update public.account_turn_queue q set state='failed', failure_reason=case
       when $3 then '${UNCERTAIN_DISPATCH_MESSAGE}'
       when q.state='dispatching' then 'Dispatch cancelled by confirmed stop.'
       when ${QUEUED_DISPATCH_EVIDENCE}
         then 'Queued receipt already has dispatch evidence; inspect sandbox history before resending.'
       else 'Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.' end,
       dispatch_until=case when $3 then null else q.dispatch_until end
     from public.sandboxes s
     where q.sandbox_id=$1 and q.request_id=$2 and q.state in ('queued','dispatching') and s.id=q.sandbox_id`,
    [sandboxId, requestId, uncertain],
  );
}

export async function resetAbandonedTurn(tx: Sql, sandboxId: string, requestId: string) {
  const { rows } = await tx.query(
    `with retried as (update public.account_turn_queue q set state='queued',
       dispatch_generation=null,dispatch_until=null,failure_reason=null
       from public.sandboxes s where s.id=q.sandbox_id
       and q.sandbox_id=$1 and q.request_id=$2 and q.state='dispatching'
       and ${DISPATCH_ABANDONED} returning q.sandbox_id,q.account_id),
     released as (delete from public.account_agent_reservations r using retried q
       where r.sandbox_id=q.sandbox_id and r.account_id=q.account_id)
     select sandbox_id from retried`,
    [sandboxId, requestId],
  );
  return rows.length > 0;
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

type AdmissionEntry = DispatchEntry & {
  actor_epoch: string;
  credential_version: number;
  model: string | null;
  org_id: string;
  owner_id: string;
  queued_generation: string;
  state: string;
};

type TurnClaim = { job: Job; canDispatch(tx: Sql): Promise<boolean> };

export async function admitClaimedAccountTurn(sql: Sql, claim: TurnClaim) {
  const { kind, sandbox_id, payload } = claim.job;
  if (
    kind !== "turn_dispatch" ||
    !sandbox_id ||
    !payload ||
    typeof payload !== "object" ||
    !("requestId" in payload) ||
    typeof payload.requestId !== "string"
  )
    throw new Error("Turn job is missing its sandbox or request ID.");
  const {
    rows: [candidate],
  } = await sql.query<AdmissionEntry>(
    "select * from public.account_turn_queue where sandbox_id=$1 and request_id=$2 and state in ('queued','dispatching')",
    [sandbox_id, payload.requestId],
  );
  return candidate ? admitAccountTurn(sql, candidate, claim) : null;
}

export async function admitAccountTurn(sql: Sql, candidate: AdmissionEntry, claim?: TurnClaim) {
  if (!sql.transaction) throw new VaultError("unavailable", "Transactional account admission unavailable.");
  const recovering = candidate.state === "dispatching";
  return sql.transaction(async (tx) => {
    const member = (
      await tx.query<{ role: "admin" | "member"; epoch: string }>(
        `select m.role,e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
     where m.org_id=$1 and m.user_id=$2 for share of m`,
        [candidate.org_id, candidate.owner_id],
      )
    ).rows[0];
    await tx.query("select id from public.credentials where id=$1 for update", [candidate.account_id]);
    const current = await tx.query(
      `select q.request_id from public.account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2 and q.state=$3
      and (q.state='queued' or q.dispatch_until<=now())
      and ${TURN_FIFO_ELIGIBLE} for update of q`,
      [candidate.sandbox_id, candidate.request_id, candidate.state],
    );
    if (!current.rows.length) return null;
    if (recovering && !claim) {
      // Recheck under account, queue and sandbox locks: the discovery read may be stale.
      // Native providers cannot replay uncertain mutations, but an unchanged generation
      // with no request evidence proves the previous claim never began dispatch.
      const abandoned = await tx.query(
        `select s.id from public.sandboxes s
         join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$2
         where s.id=$1 and not coalesce(${RUNTIME_LANE},false) and ${DISPATCH_ABANDONED} for update of s`,
        [candidate.sandbox_id, candidate.request_id],
      );
      if (abandoned.rows.length) {
        await resetAbandonedTurn(tx, candidate.sandbox_id, candidate.request_id);
        return null;
      }
    }
    const valid = await tx.query<{ id: string; runtime: boolean }>(
      `select s.id,${RUNTIME_LANE} as runtime from public.sandboxes s join public.credentials c on c.id=s.credential_id
     where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.credential_id=$4 and s.credential_version=$5
     and c.version=$5 and c.status='active' and (c.expires_at is null or c.expires_at>now())
     and ((c.scope='user' and c.owner_id=$2) or (c.scope='org' and c.owner_id=$3))
     and s.deleted_at is null and s.stop_requested_at is null and s.expires_at>now()
     and (s.status<>'stopped' or s.lifecycle_generation=$7::bigint)
     and (s.status in ('ready','running','stopped') or ($6::boolean and s.status='starting')) for update of s`,
      [
        candidate.sandbox_id,
        candidate.owner_id,
        candidate.org_id,
        candidate.account_id,
        candidate.credential_version,
        recovering,
        candidate.queued_generation,
      ],
    );
    if (claim) {
      // The eligibility query may return no rows without locking a sandbox.
      // Fence every shared admission outcome, including authorization refusal.
      const {
        rows: [live],
      } = await tx.query<{ generation: string }>(
        "select lifecycle_generation::text as generation from public.sandboxes where id=$1 for update",
        [candidate.sandbox_id],
      );
      if (!live || live.generation !== claim.job.generation || !(await claim.canDispatch(tx))) return null;
    }
    if (!member || member.epoch !== String(candidate.actor_epoch) || !valid.rows.length) {
      await tx.query(
        "update public.account_turn_queue set state='failed',failure_reason='Authorization or sandbox lifecycle changed.' where sandbox_id=$1 and request_id=$2 and state='queued'",
        [candidate.sandbox_id, candidate.request_id],
      );
      return null;
    }
    if (recovering && !valid.rows[0]!.runtime) return null;
    const busy = await tx.query(
      `select 1 from public.account_turn_queue where sandbox_id=$1 and state='dispatching'
     union all select 1 from public.sandboxes s where s.id=$1 and (s.reconcile_lease_until>now() or s.activity_lease_id is not null
     or (${UNSETTLED_TASK})) limit 1`,
      [candidate.sandbox_id],
    );
    if (!recovering && busy.rows.length) return null;
    try {
      if (!recovering)
        await admitAccountCapacity(tx, candidate.account_id, candidate.sandbox_id, candidate.model ?? undefined);
      else
        await tx.query(
          "insert into public.account_agent_reservations(sandbox_id,account_id,model) values($1,$2,$3) on conflict(sandbox_id) do nothing",
          [candidate.sandbox_id, candidate.account_id, candidate.model],
        );
    } catch (error) {
      if (error instanceof VaultError && error.code === "conflict") return null;
      throw error;
    }
    const claimed = await tx.query(
      "update public.account_turn_queue set dispatch_generation=case when state='queued' then (select lifecycle_generation from public.sandboxes where id=$1) else dispatch_generation end,state='dispatching',dispatch_until=now()+interval '15 minutes' where sandbox_id=$1 and request_id=$2 and state=$3 returning request_id",
      [candidate.sandbox_id, candidate.request_id, candidate.state],
    );
    if (!claimed.rows.length) return null;
    return {
      entry: candidate,
      caller: {
        userId: candidate.owner_id,
        via: "service" as const,
        orgs: [{ orgId: candidate.org_id, role: member.role }],
      },
    };
  });
}

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
          `update public.account_turn_queue q set failure_reason='${UNCERTAIN_DISPATCH_MESSAGE}',
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
