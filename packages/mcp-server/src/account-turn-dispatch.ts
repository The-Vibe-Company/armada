import { API_FAILURE_STATUS } from "@armada/core";
import { sandboxOperations } from "@armada/core/contract";
import {
  decryptSecret,
  encryptSecret,
  failureDiagnostic,
  modalLaunchSetupKeySql,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { admitAccountCapacity } from "./account-capacity.ts";
import type { Caller } from "./caller.ts";
import type { Job, JobKind } from "./jobs/runner.ts";
import { continueRequest, recordOperatorDiagnostic } from "./request-observability.ts";
import type { RuntimeFollowupInput } from "./runtime-followup.ts";
import type { RuntimeTurnClaim } from "./runtime-resume.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";

function deferredDockerLaunch(sandbox: string, pending = false) {
  return `exists(select 1 from public.docker_launch_requests launch
    where launch.sandbox_id=${sandbox}.id and launch.async_launch${pending ? " and launch.result_enc is null" : ""})`;
}

export const LAUNCH_PENDING = `(exists(select 1 from public.jobs setup
  where setup.idem_key=${modalLaunchSetupKeySql()} and setup.state in ('queued','leased')) or ${deferredDockerLaunch("s", true)})`;

function idleStopPending(sandbox: string) {
  return `(${sandbox}.status='stopping' and ${sandbox}.stop_requested_at is not null
    and ${sandbox}.status_reason is not distinct from 'idle_paused'
    and exists (
      select 1 from (
        select to_status, actor, code, generation from public.sandbox_transitions
        where sandbox_id=${sandbox}.id order by id desc limit 1
      ) latest
      where latest.generation=${sandbox}.lifecycle_generation and latest.to_status='stopping'
        and latest.actor='idle'
        and ((${sandbox}.provider is not distinct from 'docker' and latest.code='docker_idle_paused')
          or (latest.code='runtime_checkpoint_idle_paused'
            and ((${sandbox}.provider is not distinct from 'boat' and ${sandbox}.boat_runtime is true)
              or (${sandbox}.provider is not distinct from 'modal' and ${sandbox}.runtime_transport is not distinct from 'dialout'))))
    ))`;
}

export const IDLE_STOP_PENDING = idleStopPending("s");

function lifecycleBlocksTurn(sandbox: string, turn: string) {
  return `(${idleStopPending(sandbox)} or exists(select 1 from public.jobs setup where setup.idem_key=${modalLaunchSetupKeySql(sandbox)}
    and (setup.state='failed' or (setup.state in ('queued','leased') and setup.id<>${turn}.request_id)
      or exists(
      select 1 from public.account_turn_queue initial
      where initial.sandbox_id=${sandbox}.id and initial.request_id=setup.id
        and initial.state in ('queued','dispatching') and initial.request_id<>${turn}.request_id)))
    or ${deferredDockerLaunch(sandbox, true)}
    or exists(select 1 from public.docker_queued_prompts pending
      where pending.sandbox_id=${sandbox}.id and pending.status in ('queued','dispatching')))`;
}

export const TURN_LIFECYCLE_WAITING = lifecycleBlocksTurn("s", "q");

export const TURN_FIFO_ELIGIBLE = `(exists(select 1 from public.credentials c where c.id=q.account_id and c.max_agents is null)
  or not exists(select 1 from public.account_turn_queue earlier join public.sandboxes target on target.id=earlier.sandbox_id
    where earlier.account_id=q.account_id and earlier.state='queued'
      and earlier.model is not distinct from q.model and earlier.sequence<q.sequence
      and not ${lifecycleBlocksTurn("target", "earlier")}))`;

export const RUNTIME_REQUEST_EVIDENCE = `(s.activity_lease_id=q.request_id
  or exists(select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.request_id in ('follow_'||q.request_id::text,'docker_prompt_'||q.request_id::text,'resume_'||q.request_id::text))
  or exists(select 1 from public.runtime_resumes r where r.sandbox_id=s.id and r.request_id=q.request_id)
  or exists(select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id and j.request_id=q.request_id))`;
const STOPPED_DOCKER_WAKE_IN_PROGRESS = `(s.provider='docker' and s.status='stopped' and exists(
  select 1 from public.docker_resume_claims c where c.sandbox_id=s.id and c.request_id=q.request_id
    and c.actor_id=q.owner_id and c.host_id=s.docker_host_id and c.installation_id=s.docker_installation_id
    and c.generation=s.docker_generation and c.lifecycle_generation=s.lifecycle_generation
    and c.lifecycle_generation=q.dispatch_generation and c.accepted is distinct from false))`;

export const QUEUED_DISPATCH_EVIDENCE = `(q.native_prompt_id is not null
  or (s.task_prompt_id=q.request_id::text) is true or (${RUNTIME_REQUEST_EVIDENCE}) is true)`;
export const RUNTIME_LANE = `(s.provider='docker' or s.boat_runtime or s.runtime_transport='dialout')`;
export const COMPLETED_RUNTIME_WAKE = `(s.provider in ('boat','modal') and ${RUNTIME_LANE}
  and s.status in ('ready','running') and s.activity_lease_id is null
  and q.dispatch_generation in (s.lifecycle_generation, s.lifecycle_generation - 1)
  and exists(
    select 1 from public.runtime_resumes r
    join public.runtime_enrolments e on e.sandbox_id=r.sandbox_id and e.epoch=r.target_epoch
    where r.sandbox_id=s.id and r.request_id=q.request_id
      and r.phase='complete' and r.receipt is not null and e.runtime_hash is not null
      and e.lifecycle_generation=s.lifecycle_generation
  ))`;
export const ENROLLED_PENDING_RUNTIME_WAKE = `(
  ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))
  and s.status in ('starting','ready','running') and s.activity_lease_id=q.request_id
  and q.dispatch_generation in (s.lifecycle_generation, s.lifecycle_generation - 1)
  and exists(
    select 1 from public.runtime_resumes r
    join public.runtime_enrolments e on e.sandbox_id=r.sandbox_id and e.epoch=r.target_epoch
    where r.sandbox_id=s.id and r.request_id=q.request_id
      and r.phase='dispatched' and r.receipt is null and e.runtime_hash is not null
      and e.lifecycle_generation=s.lifecycle_generation
  ))`;
export const CONFIRMED_WAKE_WITHOUT_TICKET = `(
  q.state='dispatching'
  and ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))
  and s.status='starting' and s.activity_lease_id=q.request_id and s.activity_until>clock_timestamp()
  and s.lifecycle_generation=q.dispatch_generation+1
  and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>clock_timestamp()
  and not s.application_secret_tainted
  and (s.reconcile_lease_until is null or s.reconcile_lease_until<=clock_timestamp())
  and exists(
    select 1 from public.runtime_resumes r
    join public.runtime_enrolments e on e.sandbox_id=r.sandbox_id and e.epoch=r.source_epoch
    where r.sandbox_id=s.id and r.request_id=q.request_id and r.target_epoch=e.epoch+1
      and r.phase='dispatched' and r.receipt is null and r.activated_at is not null
      and e.runtime_hash is null and e.enrolment_hash is null and e.lifecycle_generation<s.lifecycle_generation
  ))`;
const dockerResumeJob = (outcome: string) => `(s.provider = 'docker' and exists(
  select 1 from public.docker_resume_claims c
  join public.docker_host_jobs h_job on h_job.request_id = c.request_id
    and h_job.bound_sandbox_id = c.sandbox_id and h_job.bound_actor_id = c.actor_id and h_job.host_id = c.host_id
  join public.docker_hosts h on h.id = c.host_id and h.org_id = s.org_id and h.installation_id = c.installation_id
  join public.members issuer on issuer.org_id = h.org_id and issuer.user_id = h.owner_id
  join public.members actor on actor.org_id = s.org_id and actor.user_id = c.actor_id
  join public.mcp_actor_epochs a on a.org_id = actor.org_id and a.user_id = actor.user_id
  where c.request_id = q.request_id and c.sandbox_id = s.id and c.actor_id = s.owner_id and c.actor_id = q.owner_id
    and c.host_id = s.docker_host_id and c.installation_id = s.docker_installation_id
    and c.generation = s.docker_generation and c.accepted
    and c.lifecycle_generation = q.dispatch_generation and c.lifecycle_generation + 1 = s.lifecycle_generation
    and h_job.bound_operation = 'resume' and h_job.bound_actor_epoch = a.epoch
    and h_job.cancelled_at is null
    and (${outcome})
    and h.hash is not null and h.registration_hash is null and h.revoked_at is null
    and not exists(select 1 from public.runtime_commands p
      where p.sandbox_id = s.id and p.request_id = 'docker_prompt_' || q.request_id::text)
))`;

export const CURRENT_DOCKER_RESUME_JOB = dockerResumeJob(
  "h_job.refused_resume_generation is null and (h_job.outcome = 'completed' or (h_job.outcome is null and s.status = 'starting'))",
);
export const PENDING_READY_DOCKER_RESUME_ACK = `(s.status in ('ready','running')
  and s.activity_lease_id is null and ${dockerResumeJob("h_job.outcome is null and h_job.refused_resume_generation is null")})`;
export const FAILED_DOCKER_WAKE = dockerResumeJob(
  "h_job.outcome = 'failed' or h_job.refused_resume_generation = s.lifecycle_generation",
);

export const DOCKER_RESUME_WITHOUT_DISPATCH_DEADLINE = `(q.state='dispatching'
  and q.dispatch_until is null and s.status in ('ready','running')
  and s.activity_lease_id is null and ${CURRENT_DOCKER_RESUME_JOB})`;
export const TURN_RECOVERY_ELIGIBLE = `(q.dispatch_until<=now() and q.dispatch_generation is not null
  and ((${RUNTIME_LANE} and ${RUNTIME_REQUEST_EVIDENCE})
    or (s.lifecycle_generation=q.dispatch_generation and s.activity_lease_id is null
      and not coalesce(${RUNTIME_REQUEST_EVIDENCE},false))))`;
export const UNSETTLED_TASK = `s.task_prompt_id is not null
  and (s.status='running' or (s.status='ready' and ${RUNTIME_LANE} and (s.provider<>'docker' or ${deferredDockerLaunch("s")})))
  and not exists(select 1 from public.runtime_idle_turns t
    where t.sandbox_id=s.id and t.prompt_id=s.task_prompt_id and t.settled)`;

export const NATIVE_DISPATCH_UNCERTAIN = `(not coalesce(${RUNTIME_LANE},false)
  and (s.lifecycle_generation is distinct from q.dispatch_generation
    or s.activity_lease_id is not null or ${QUEUED_DISPATCH_EVIDENCE}))`;
export const DISPATCH_ABANDONED = `((q.dispatch_until is null or q.dispatch_until <= clock_timestamp())
  and s.stop_requested_at is null and s.deleted_at is null and s.expires_at > clock_timestamp()
  and (s.status in ('ready','running') or (s.status='stopped' and s.lifecycle_generation=q.queued_generation
    and not (s.provider='docker' and exists(
      select 1 from public.docker_resume_claims c where c.sandbox_id=s.id and c.request_id=q.request_id
    ))))
  and s.lifecycle_generation=q.dispatch_generation
  and s.activity_lease_id is null and not ${QUEUED_DISPATCH_EVIDENCE})`;
export const UNCERTAIN_DISPATCH_MESSAGE = "Dispatch outcome uncertain; inspect sandbox history before resending.";

const TURN_LIFECYCLE_CANCELLED = `(s.deleted_at is not null or s.expires_at <= now()
  or (s.status = 'stopped' and s.lifecycle_generation <> q.queued_generation))`;

export const QUEUED_TURN_CANCELLED = `(${TURN_LIFECYCLE_CANCELLED}
  or (not (${IDLE_STOP_PENDING} and s.lifecycle_generation=q.queued_generation)
    and (s.stop_requested_at is not null
      or (s.status not in ('ready','running','stopped') and not (s.status='starting' and ${LAUNCH_PENDING}))))
  or exists(select 1 from public.jobs setup where setup.idem_key=${modalLaunchSetupKeySql()} and setup.state='failed'))`;
export const DISPATCHING_TURN_CANCELLED = `(${TURN_LIFECYCLE_CANCELLED}
  or s.stop_requested_at is not null or s.status in ('deleted','stopping','failed'))`;

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

type TurnClaim = { job: Job; canDispatch(tx?: Sql): Promise<boolean> };

class TurnAdmissionLeaseLost extends Error {}

function turnJobRequest(job: Job) {
  const { kind, sandbox_id, payload } = job;
  if (
    kind !== "turn_dispatch" ||
    !sandbox_id ||
    !payload ||
    typeof payload !== "object" ||
    !("requestId" in payload) ||
    typeof payload.requestId !== "string"
  )
    throw new Error("Turn job is missing its sandbox or request ID.");
  return { sandboxId: sandbox_id, requestId: payload.requestId };
}

export async function admitClaimedAccountTurn(sql: Sql, claim: TurnClaim) {
  const { sandboxId, requestId } = turnJobRequest(claim.job);
  const {
    rows: [candidate],
  } = await sql.query<AdmissionEntry>(
    "select * from public.account_turn_queue where sandbox_id=$1 and request_id=$2 and state in ('queued','dispatching')",
    [sandboxId, requestId],
  );
  return candidate ? admitAccountTurn(sql, candidate, claim) : null;
}

export async function admitAccountTurn(sql: Sql, candidate: AdmissionEntry, claim?: TurnClaim) {
  if (!sql.transaction) throw new VaultError("unavailable", "Transactional account admission unavailable.");
  const recovering = candidate.state === "dispatching";
  return sql
    .transaction(async (tx) => {
      const member = (
        await tx.query<{ role: "admin" | "member"; epoch: string }>(
          `select m.role,e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
     where m.org_id=$1 and m.user_id=$2 for share of m`,
          [candidate.org_id, candidate.owner_id],
        )
      ).rows[0];
      await tx.query("select id from public.credentials where id=$1 for update", [candidate.account_id]);
      // WARNING: Startup model repair can queue ahead of a receipt table lock upgrade.
      if (claim) await tx.query("lock table public.account_turn_queue in row exclusive mode nowait");
      const current = await tx.query(
        `select q.request_id from public.account_turn_queue q join public.sandboxes s on s.id=q.sandbox_id
      where q.sandbox_id=$1 and q.request_id=$2 and q.state=$3
      and (q.state='queued' or q.dispatch_until<=now() or $4::boolean)
      and (q.state<>'queued' or not ${TURN_LIFECYCLE_WAITING})
      and ${TURN_FIFO_ELIGIBLE} for update of q`,
        [candidate.sandbox_id, candidate.request_id, candidate.state, Boolean(claim)],
      );
      if (!current.rows.length) return null;
      if (recovering && !claim) {
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
      if (claim) {
        // WARNING: Owner stop can hold the sandbox lock while waiting for the receipt.
        const {
          rows: [live],
        } = await tx.query<{ generation: string }>(
          "select lifecycle_generation::text as generation from public.sandboxes where id=$1 for update nowait",
          [candidate.sandbox_id],
        );
        if (!live || live.generation !== claim.job.generation || !(await claim.canDispatch(tx))) return null;
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
      if (!member || member.epoch !== String(candidate.actor_epoch) || !valid.rows.length) {
        await tx.query(
          "update public.account_turn_queue set state='failed',failure_reason='Authorization or sandbox lifecycle changed.' where sandbox_id=$1 and request_id=$2 and state='queued'",
          [candidate.sandbox_id, candidate.request_id],
        );
        if (claim && !(await claim.canDispatch(tx))) throw new TurnAdmissionLeaseLost();
        return null;
      }
      if (claim && recovering) {
        const { rows } = await tx.query(
          `select q.request_id from public.account_turn_queue q join public.sandboxes s on s.id=q.sandbox_id
           where q.sandbox_id=$1 and q.request_id=$2
             and (${FAILED_DOCKER_WAKE}) is not true
             and (${PENDING_READY_DOCKER_RESUME_ACK}) is not true
             and (${DISPATCH_ABANDONED} or ${TURN_RECOVERY_ELIGIBLE} or ${COMPLETED_RUNTIME_WAKE} or ${ENROLLED_PENDING_RUNTIME_WAKE}
               or ${CONFIRMED_WAKE_WITHOUT_TICKET} or ${DOCKER_RESUME_WITHOUT_DISPATCH_DEADLINE})`,
          [candidate.sandbox_id, candidate.request_id],
        );
        if (!rows.length) return null;
        if (await resetAbandonedTurn(tx, candidate.sandbox_id, candidate.request_id)) {
          if (!(await claim.canDispatch(tx))) throw new TurnAdmissionLeaseLost();
          return null;
        }
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
      if (claim && !(await claim.canDispatch(tx))) throw new TurnAdmissionLeaseLost();
      if (!claimed.rows.length) return null;
      return {
        entry: candidate,
        caller: {
          userId: candidate.owner_id,
          via: "service" as const,
          orgs: [{ orgId: candidate.org_id, role: member.role }],
        },
      };
    })
    .catch((error: unknown) => {
      const lockError = error as { errno?: string; code?: string } | null;
      if (claim && (error instanceof TurnAdmissionLeaseLost || (lockError?.errno ?? lockError?.code) === "55P03"))
        return null;
      throw error;
    });
}

export type DispatchTurn = (caller: Caller, input: RuntimeFollowupInput, claim?: RuntimeTurnClaim) => Promise<unknown>;

export function createTurnDispatchJob(sql: Sql, key: string, dispatch: DispatchTurn, now = Date.now) {
  return {
    concurrency: 32,
    async run(job, context) {
      const { sandboxId, requestId } = turnJobRequest(job);
      if (!(await context.canDispatch()))
        return {
          status: "fail",
          reason: "dispatch_budget_expired",
          unattempted: true,
          async commit(tx) {
            // WARNING: Waiting for the receipt here can deadlock with receipt-first claim reconciliation.
            await tx.query("lock table public.account_turn_queue in row exclusive mode nowait");
            await tx.query(
              `with locked as materialized (
                 select sandbox_id, request_id from public.account_turn_queue
                 where sandbox_id=$1 and request_id=$2 and state in ('queued','dispatching') for update nowait
               )
               update public.account_turn_queue q set state='failed', dispatch_until=null,
                 failure_reason=case when q.state='dispatching' or ${QUEUED_DISPATCH_EVIDENCE}
                   then '${UNCERTAIN_DISPATCH_MESSAGE}'
                   else 'Queued prompt could not start before its dispatch budget expired.' end
               from locked join public.sandboxes s on s.id=locked.sandbox_id
               where q.sandbox_id=locked.sandbox_id and q.request_id=locked.request_id`,
              [sandboxId, requestId],
            );
          },
        };
      const claim = { job, canDispatch: context.canDispatch, handoffGeneration: context.handoffGeneration };
      const admitted = await admitClaimedAccountTurn(sql, claim);
      if (admitted) await dispatchAccountTurn(sql, key, admitted.entry, admitted.caller, dispatch, claim);
      const {
        rows: [receipt],
      } = await sql.query<{ state: string }>(
        "select state from public.account_turn_queue where sandbox_id=$1 and request_id=$2",
        [sandboxId, requestId],
      );
      if (!receipt || receipt.state === "admitted" || receipt.state === "failed") return { status: "done" };
      const after = new Date(now() + 1_000);
      return admitted ? { status: "retry", after } : { status: "retry", after, unattempted: true };
    },
  } satisfies JobKind;
}

class TurnSettlementLeaseLost extends Error {}

async function settleAccountTurn<T>(
  sql: Sql,
  entry: DispatchEntry,
  claim: TurnClaim | undefined,
  write: (tx: Sql) => Promise<T>,
) {
  if (!sql.transaction) throw new VaultError("unavailable", "Transactional turn settlement unavailable.");
  try {
    return await sql.transaction(async (tx) => {
      await tx.query("select id from public.credentials where id=$1 for update", [entry.account_id]);
      if (claim) {
        await tx.query("lock table public.account_turn_queue in row exclusive mode nowait");
        await tx.query("select id from public.sandboxes where id=$1 for update", [entry.sandbox_id]);
        if (!(await claim.canDispatch(tx))) return;
      }
      const result = await write(tx);
      if (claim && !(await claim.canDispatch(tx))) throw new TurnSettlementLeaseLost();
      return result;
    });
  } catch (error) {
    if (!(error instanceof TurnSettlementLeaseLost)) throw error;
  }
}

export async function dispatchAccountTurn(
  sql: Sql,
  key: string,
  entry: DispatchEntry,
  caller: Caller,
  dispatch: DispatchTurn,
  claim?: TurnClaim & RuntimeTurnClaim,
) {
  if (claim) {
    const { kind, sandbox_id, payload } = claim.job;
    if (
      kind !== "turn_dispatch" ||
      sandbox_id !== entry.sandbox_id ||
      !payload ||
      typeof payload !== "object" ||
      !("requestId" in payload) ||
      payload.requestId !== entry.request_id
    )
      throw new Error("Turn job does not own the dispatch receipt.");
  }
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
    if (claim) {
      phase = "dispatch_fence";
      if (id.toLowerCase() !== entry.sandbox_id || request_id !== entry.request_id)
        throw new Error("Encrypted turn input does not match its receipt.");
      if (!(await claim.canDispatch())) return;
    }
    phase = "send";
    const result = await continueRequest(correlationId, () =>
      dispatch(caller, { id, request_id, prompt, model, reasoning_effort }, claim),
    );
    phase = "publish_receipt";
    const resultEnc = await encryptSecret(JSON.stringify(result), key);
    const publish = (tx: Sql) =>
      tx.query(
        `with admitted as (update public.account_turn_queue set state='admitted',result_enc=$3
             where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
           delete from public.account_agent_reservations r using admitted a where r.sandbox_id=a.sandbox_id`,
        [id, entry.request_id, resultEnc],
      );
    if (claim) await settleAccountTurn(sql, entry, claim, publish);
    else await publish(sql);
  } catch (error) {
    if (claim && (phase === "publish_receipt" || phase === "dispatch_fence")) throw error;
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
    const rejected = await settleAccountTurn(sql, entry, claim, async (tx) => {
      const unchanged = await tx.query<{ stopped_runtime: boolean }>(
        `select (s.status='stopped' and coalesce(${RUNTIME_LANE},false)) as stopped_runtime from public.sandboxes s
        join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$2
        where s.id=$1 and q.state='dispatching' and s.lifecycle_generation=q.dispatch_generation
        and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
        and ((s.activity_lease_id is null and (s.status in ('ready','running')
          or ($3 and (s.provider='modal' or s.boat_runtime) and s.status='stopped')))
          or ($4 and s.status='stopped' and coalesce(${RUNTIME_LANE},false)))
        and not coalesce(${RUNTIME_REQUEST_EVIDENCE} or ${STOPPED_DOCKER_WAKE_IN_PROGRESS},false)
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
           dispatch_until=case when not coalesce(${RUNTIME_LANE},false) then null
             when ${RUNTIME_REQUEST_EVIDENCE} or ${STOPPED_DOCKER_WAKE_IN_PROGRESS} then now() else q.dispatch_until end
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
