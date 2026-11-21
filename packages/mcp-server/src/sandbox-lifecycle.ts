import type { SandboxPlacementProviderId, SandboxRecord, SandboxStatus } from "@armada/core";
import {
  decryptSecret,
  HOST_CAPABILITIES,
  isFinalPromptStatus,
  isSandboxProvider,
  type MachineIdentity,
  type OutputFailureReason,
  type Provider,
  ProviderError,
  type SandboxStore,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import { releaseAccountCapacity } from "./account-capacity.ts";
import { isDockerPromptRefusal } from "./docker-prompt-refusal.ts";
import type { Job } from "./jobs/runner.ts";
import { mergedWorkProof } from "./merged-work.ts";
import { nativeIdleDue, nativeQuiescent } from "./native-idle.ts";
import { LIVE_OUTPUT_CANDIDATE } from "./output-transfers.ts";
import { recordNativeIdleTurn } from "./runtime-idle-evidence.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";
import { INTERRUPTED_LAUNCH_REASON, isFailedModalLaunch, MODAL_LAUNCH_FAILURE } from "./turns.ts";
import { deferTransactionWake, eventFeedWakeKey, runtimeWakes } from "./wake-bus.ts";
import { preserveBeforeStop, purgeWorkRecovery, recordStopDispatch } from "./work-preservation.ts";

export type ModalLaunchSandbox = Pick<
  Parameters<SandboxStore["insert"]>[0],
  | "goldenId"
  | "harness"
  | "model"
  | "reasoningEffort"
  | "repositoryDir"
  | "requestedTtlSeconds"
  | "credentialId"
  | "credentialVersion"
  | "visibility"
  | "externalRef"
  | "stopWhenWorkMerged"
> & { effectiveTtlSeconds: number };

export async function insertStartingModalSandbox(
  tx: Sql,
  target: {
    sandboxId: string;
    orgId: string;
    ownerId: string;
    generation: number;
    visibility: "org" | "private";
    snapshot: string;
  },
  sandbox: ModalLaunchSandbox,
) {
  const { sandboxId, orgId, ownerId, generation, visibility, snapshot } = target;
  await tx.query(
    `insert into public.sandboxes
       (id, org_id, owner_id, access_owner_id, golden_id, provider, status, runtime_transport, lifecycle_generation,
        visibility, harness, model, reasoning_effort, repository_dir, requested_ttl_seconds, effective_ttl_seconds,
        expires_at, credential_id, credential_version, external_ref, stop_when_work_merged)
     values ($1,$2,$3,$3,$4,'modal','starting','dialout',$5,$6,$7,$8,$9,$10,$11,$12,
             now()+$12::integer*interval '1 second',$13,$14,$15,$16)`,
    [
      sandboxId,
      orgId,
      ownerId,
      sandbox.goldenId,
      generation,
      visibility,
      sandbox.harness,
      sandbox.model,
      sandbox.reasoningEffort,
      sandbox.repositoryDir ?? null,
      sandbox.requestedTtlSeconds ?? null,
      sandbox.effectiveTtlSeconds,
      sandbox.credentialId ?? null,
      sandbox.credentialVersion ?? null,
      sandbox.externalRef ?? null,
      sandbox.stopWhenWorkMerged ?? true,
    ],
  );
  await tx.query("insert into public.sandbox_source_snapshots (sandbox_id,snapshot_id) values ($1,$2)", [
    sandboxId,
    snapshot,
  ]);
}

export async function taintStartingModalSandbox(tx: Sql, sandboxId: string, generation: number) {
  const { rows } = await tx.query(
    `update public.sandboxes set application_secret_tainted=true
     where id=$1 and lifecycle_generation=$2 and status='starting' returning id`,
    [sandboxId, generation],
  );
  if (!rows.length) throw new Error("Modal launch exposure restrictions could not be applied.");
}

export async function bindModalLaunchMachine(tx: Sql, machine: MachineIdentity) {
  const { rows } = await tx.query(
    `update public.sandboxes set provider_sandbox_id=$3
     where id=$1 and lifecycle_generation=$2 and provider='modal' and runtime_transport='dialout'
       and status='starting' and stop_requested_at is null and deleted_at is null
       and provider_sandbox_id is null returning id`,
    [machine.sandboxId, machine.generation, machine.machineId],
  );
  return rows.length === 1;
}

export type StopFence = [
  providerId: string | null,
  token: string | null,
  generation: number | null,
  kind: string | null,
  provider: string | null,
];

export const WORK_STOP_OWNER = `stop_requested_at is not null and deleted_at is null
  and provider in ('boat','modal') and not boat_runtime
  and (provider='modal' or runtime_transport is distinct from 'dialout')
  and provider_sandbox_id=$2::text and provider::text=$6::text
  and lifecycle_generation=$4::bigint
  and (($5::text='activity' and activity_lease_id=$3::uuid and activity_until>clock_timestamp())
    or ($5::text='reconcile' and reconcile_lease=$3::uuid and reconcile_lease_until>clock_timestamp()
      and (activity_until is null or activity_until<=clock_timestamp())))
  and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)`;

export const STOP_EPOCH = `id=$1::uuid
  and (case when stop_requested_at is null then null else stop_generation end) is not distinct from $7::bigint
  and ($2::text is null or (${WORK_STOP_OWNER}))`;
const NATIVE_WORK_ROUTE = `provider in ('boat','modal') and not boat_runtime
  and runtime_transport is distinct from 'dialout'`;

const NATIVE_CAPTURE_CURRENT = `r.capture_generation=r.generation
  and r.capture_stop_generation=r.stop_generation
  and (r.archive_id is null or exists (
    select 1 from public.sandbox_work_recovery a where a.id=r.archive_id and a.sandbox_id=r.sandbox_id
  ))`;

export const COMPLETE_PRESERVATION = `stop_requested_at is not null
  and preservation_stop_generation is not distinct from stop_generation
  and (not (${NATIVE_WORK_ROUTE}) or exists (
    select 1 from public.sandbox_native_preservation_receipts r
    where r.sandbox_id=sandboxes.id and r.generation=sandboxes.lifecycle_generation
      and r.stop_generation=sandboxes.stop_generation and (${NATIVE_CAPTURE_CURRENT})
  ))`;

export const NOTE_FENCE = `${STOP_EPOCH} and not (${COMPLETE_PRESERVATION})`;

export async function readNativeCaptureAcknowledgements(
  sql: Sql,
  id: string,
  fence: StopFence,
  stopToken: string | null,
  captureId: string,
) {
  const { rows } = await sql.query<{ evidence: string }>(
    `select (
       select jsonb_build_object(
         'captureId',$8::text,
         'prompts',jsonb_object_agg(p.acknowledged_request_id,p.prompt_id)
           filter (where p.acknowledged_request_id is not null),
         'completedPrompts',jsonb_agg(p.prompt_id)
       )
       from public.native_webhook_prompts p
       where p.sandbox_id=sandboxes.id and p.provider=sandboxes.provider
         and p.provider_sandbox_id=sandboxes.provider_sandbox_id
         and p.owner_id=sandboxes.owner_id and p.org_id=sandboxes.org_id
         and p.completed_at is not null
     )::text as evidence
     from public.sandboxes where ${NOTE_FENCE} and not application_secret_tainted`,
    [id, ...fence, stopToken, captureId],
  );
  return rows[0]?.evidence;
}

function recordNativePreservation(archiveId: "$9::uuid" | "null", evidence: "$11" | "$8") {
  return `
    insert into public.sandbox_native_preservation_receipts
      (sandbox_id,generation,stop_generation,capture_generation,capture_stop_generation,archive_id,capture_acknowledgements)
    select id,$4::bigint,$7::bigint,$4::bigint,$7::bigint,${archiveId},${evidence}::jsonb from accepted
    where native and $2::text is not null
    on conflict(sandbox_id) do update set generation=excluded.generation,
      stop_generation=excluded.stop_generation,capture_generation=excluded.capture_generation,
      capture_stop_generation=excluded.capture_stop_generation,archive_id=excluded.archive_id,
      capture_acknowledgements=excluded.capture_acknowledgements`;
}

export function lockedNativePreservationWriter(sql: Sql, id: string) {
  return {
    async query<T>(statement: string, params?: unknown[]) {
      if (!sql.transaction) throw new Error("Native preservation writes require a transaction.");
      return sql.transaction(async (tx) => {
        // WARNING: The private receipt check needs a fresh snapshot after acquiring the sandbox lock.
        await tx.query("select id from public.sandboxes where id=$1 for update", [id]);
        return tx.query<T>(statement, params);
      });
    },
  } satisfies Sql;
}

export function writePreservationNote(
  sql: Sql,
  id: string,
  note: string | null,
  stopToken: string | null,
  fence: StopFence,
) {
  return sql.query(`update public.sandboxes set preservation_note=$8 where ${NOTE_FENCE}`, [
    id,
    ...fence,
    stopToken,
    note,
  ]);
}

export function recordWorkRecovery(
  sql: Sql,
  id: string,
  fence: StopFence,
  stopToken: string | null,
  note: string,
  recoveryId: string,
  encrypted: Uint8Array,
  acknowledgements: string | null,
) {
  return sql.query<{ id: string }>(
    `with accepted as (
    update public.sandboxes set preservation_note=$8,preservation_stop_generation=$7::bigint
    where ${NOTE_FENCE} and not application_secret_tainted returning id, (${NATIVE_WORK_ROUTE}) as native
  ), native_receipt as (${recordNativePreservation("$9::uuid", "$11")})
  insert into public.sandbox_work_recovery(id,sandbox_id,archive_enc)
    select $9::uuid,id,$10::bytea from accepted returning id`,
    [id, ...fence, stopToken, note, recoveryId, encrypted, acknowledgements],
  );
}

export function recordCleanWork(
  sql: Sql,
  id: string,
  fence: StopFence,
  stopToken: string | null,
  acknowledgements: string | null,
) {
  return sql.query<{ id: string }>(
    `with accepted as (
    update public.sandboxes set preservation_note=null,preservation_stop_generation=$7::bigint
    where ${NOTE_FENCE} and not application_secret_tainted returning id, (${NATIVE_WORK_ROUTE}) as native
  ), native_receipt as (${recordNativePreservation("null", "$8")})
  select id from accepted`,
    [id, ...fence, stopToken, acknowledgements],
  );
}

export function recordStoppedCheckpointNote(tx: Sql, id: string, epoch: string, watermark: number) {
  return tx.query(
    `update public.sandboxes set preservation_note=$2
     where id=$1 and stopped_at is not null and status in ('stopped','failed') and not application_secret_tainted
       and preservation_stop_generation is distinct from stop_generation`,
    [
      id,
      `Armada runtime checkpoint acknowledged for epoch ${epoch} through event ${watermark}; host stop is confirmed. No Git work archive is claimed.`,
    ],
  );
}

export async function claimOutputFailure(sql: Sql, id: string, reason: OutputFailureReason, generation: string | null) {
  const claim = await sql.query<{ provider: SandboxPlacementProviderId; status: string }>(
    `update public.sandboxes
     set outputs_failure_reasons=array_append(outputs_failure_reasons,$2)
     where id=$1 and status<>'deleted' and not application_secret_tainted
     and ($3::bigint is null or lifecycle_generation=$3::bigint)
     and not ($2 = any(outputs_failure_reasons))
     returning provider, status`,
    [id, reason, generation],
  );
  return claim.rows[0];
}

export async function markOutputCollectorSupported(sql: Sql, id: string, generation: string, providerId: string) {
  const verified = await sql.query(
    `update public.sandboxes set outputs_collector_supported=true
     where id=$1 and lifecycle_generation=$2::bigint and provider_sandbox_id=$3 and ${LIVE_OUTPUT_CANDIDATE} returning id`,
    [id, generation, providerId],
  );
  return verified.rows.length > 0;
}

export const UNENROLLED_RESUME_STOP = "runtime_resume_unenrolled";
const OPERATOR_CLEANUP_PREFIX = "Operator cleanup required:";

export async function attachDockerRestorePlacement(
  tx: Sql,
  claim: Pick<Job, "id" | "sandbox_id" | "generation" | "lease_epoch">,
  placement: { hostId: string; installationId: string; predecessor: string; replacement: string },
) {
  const { hostId, installationId, predecessor, replacement } = placement;
  const providerSandboxId = `armada-${installationId}-${hostId}-${claim.sandbox_id}-${replacement}`;
  const { rows } = await tx.query<{ provider_sandbox_id: string }>(
    `with locked_runner as materialized (
       select j.lease_until,j.deadline_at from public.jobs j join public.sandboxes s on s.id=j.sandbox_id
       where j.id=$1 and j.sandbox_id=$2 and j.generation=$3 and j.lease_epoch=$4
         and j.org_id=s.org_id and j.kind='turn_dispatch' and j.state='leased' and j.attempts <= j.max_attempts
       for update of j
     ), eligible as materialized (
       select s.id,s.docker_generation,s.provider_sandbox_id from public.sandboxes s cross join locked_runner j
       where s.id=$2 and s.lifecycle_generation=$3 and s.provider='docker'
         and s.docker_host_id=$5 and s.docker_installation_id=$6 and s.docker_generation in ($7,$8)
         and s.status='starting' and s.stop_requested_at is null and s.deleted_at is null
         and s.expires_at > clock_timestamp()
         and j.lease_until > clock_timestamp() and j.deadline_at > clock_timestamp()
     ), attached as (
       update public.sandboxes s set docker_generation=$8,provider_sandbox_id=$9
       from eligible e where s.id=e.id and e.docker_generation=$7
       returning s.provider_sandbox_id
     )
     select provider_sandbox_id from attached
     union all
     select provider_sandbox_id from eligible where docker_generation=$8`,
    [
      claim.id,
      claim.sandbox_id,
      claim.generation,
      claim.lease_epoch,
      hostId,
      installationId,
      predecessor,
      replacement,
      providerSandboxId,
    ],
  );
  return rows[0]?.provider_sandbox_id;
}

interface SandboxTransitionEffect {
  kind: "resume" | "turn_dispatch" | "stop" | "output_publication" | "webhook" | "metadata_retirement";
  idem_key: string;
  max_attempts: number;
  deadline_at: string;
  payload_enc?: string;
}

interface SandboxTransition {
  sandboxId: string;
  expectedGeneration: number | string;
  fromStates: readonly SandboxStatus[];
  toState: SandboxStatus;
  actor:
    | "resume_admission"
    | "runtime_enrolment"
    | "runtime_resume"
    | "runtime_observation"
    | "runtime_turn"
    | "native_turn"
    | "owner"
    | "api"
    | "finish"
    | "expiry"
    | "idle"
    | "lifecycle_runner"
    | "reconciler"
    | "docker_host"
    | "delete_job"
    | "retention_job";
  code: string;
  effects: readonly SandboxTransitionEffect[];
  settlement?: {
    lease: string | null;
    statusReason: string | null;
    stopRequestedAt: string | null;
    stoppedAt: string | null;
    activityLease?: string;
  };
}

type SandboxTransitionResult = { kind: "applied"; generation: number } | { kind: "conflict" };

export async function transitionSandbox(tx: Sql, input: SandboxTransition) {
  const settlement = input.settlement;
  const activityLease = settlement?.activityLease;
  const {
    rows: [result],
  } = await tx.query<{ applied: boolean; generation: string | null }>(
    `select applied, generation::text from public.sandbox_transition(
      $1::uuid, $2::bigint, array(select jsonb_array_elements_text($3::jsonb)::public.sandbox_status),
      $4::public.sandbox_status, $5::text, $6::text, $7::jsonb
      ${settlement ? ", $8::text, $9::timestamptz, $10::timestamptz, $11::uuid" : ""}
      ${activityLease === undefined ? "" : ", $12::uuid"}
    )`,
    [
      input.sandboxId,
      input.expectedGeneration,
      JSON.stringify(input.fromStates),
      input.toState,
      input.actor,
      input.code,
      JSON.stringify(input.effects),
      ...(settlement
        ? [settlement.statusReason, settlement.stopRequestedAt, settlement.stoppedAt, settlement.lease]
        : []),
      ...(activityLease === undefined ? [] : [activityLease]),
    ],
  );
  if (!result) throw new Error("Sandbox transition did not return a result.");
  if (!result.applied) return { kind: "conflict" } satisfies SandboxTransitionResult;
  if (result.generation === null) throw new Error("Applied sandbox transition did not return a generation.");
  const wakeKey = eventFeedWakeKey(input.sandboxId);
  if (!deferTransactionWake(tx, wakeKey)) runtimeWakes.notify(wakeKey);
  return { kind: "applied", generation: Number(result.generation) } satisfies SandboxTransitionResult;
}

export async function publishRuntimeReadiness(
  tx: Sql,
  sandboxId: string,
  generation: string,
  enrolment: "bootstrap" | "retained",
) {
  const { rows } = await tx.query(
    `select 1 from public.sandboxes s
     where s.id=$1 and s.status='starting' and s.lifecycle_generation=$3
       and (
         (s.provider='docker' and $2::boolean = exists(
           select 1 from public.docker_resume_claims c where c.sandbox_id=s.id
           and c.lifecycle_generation=s.lifecycle_generation-1 and c.accepted
         ) and ($2::boolean or exists(
           select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id
           and j.bound_operation='create' and j.outcome='completed'
         )))
         or (s.provider='modal' and not $2::boolean and exists(
           select 1 from public.jobs j
           where j.sandbox_id=s.id and j.org_id=s.org_id and j.request_owner_id=s.owner_id
             and j.generation=s.lifecycle_generation and j.kind='launch' and j.state in ('queued','leased')
             and j.outcome #>> '{modal_machine,entry,operation}'='create'
             and j.outcome #>> '{modal_machine,entry,phase}'='allocated'
             and j.outcome #>> '{modal_machine,entry,machineId}'=s.provider_sandbox_id
         ))
       )`,
    [sandboxId, enrolment === "retained", generation],
  );
  if (!rows.length) return "skipped";
  const transition = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting"],
    toState: "ready",
    actor: "runtime_enrolment",
    code: "runtime_enrolled",
    effects: [],
  });
  return transition.kind;
}

export async function finishLaunchSuccess(
  tx: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
  runtimeEpoch: string | undefined,
  prompt?: { promptId: string; conversationIds: string[] },
) {
  const {
    rows: [sandbox],
  } = await tx.query<{ enrolled_path: boolean; native_path: boolean; owned: boolean }>(
    `select ((s.provider='boat' and s.boat_runtime) or
             (s.provider='modal' and s.runtime_transport is not distinct from 'dialout')) as enrolled_path,
      (s.provider in ('boat','modal') and not s.boat_runtime and s.runtime_transport is null) as native_path,
      s.owner_id=$2 as owned
     from public.sandboxes s where s.id=$3::uuid and ${SANDBOX_VISIBLE} for update of s`,
    [...scope, sandboxId],
  );
  if (sandbox?.native_path) {
    if (!sandbox.owned) return "native_conflict";
    if (prompt)
      return (await finishPromptedNativeLaunch(tx, sandboxId, generation, activityToken, prompt))
        ? "applied"
        : "native_conflict";
    const result = await transitionSandbox(tx, {
      sandboxId,
      expectedGeneration: generation,
      fromStates: ["starting"],
      toState: "ready",
      actor: "lifecycle_runner",
      code: "native_launch_ready",
      effects: [],
      settlement: {
        statusReason: null,
        stopRequestedAt: null,
        stoppedAt: null,
        lease: null,
        activityLease: activityToken,
      },
    });
    return result.kind === "applied" ? "applied" : "native_conflict";
  }
  const conflict = runtimeEpoch ? "epoch_conflict" : "conflict";
  if (!sandbox?.owned || !sandbox.enrolled_path) return conflict;
  if (!runtimeEpoch || !(await hasPreparedRuntime(tx, sandboxId, generation, runtimeEpoch))) return "epoch_conflict";
  const eligible = await tx.query(
    `select s.id from public.sandboxes s where s.id=$3 and ${SANDBOX_VISIBLE}
      and s.status='starting' and s.lifecycle_generation=$5
      and s.activity_lease_id=$4 and s.activity_until>clock_timestamp() and s.expires_at>clock_timestamp()
      and s.stopped_at is null and s.stop_requested_at is null and s.deleted_at is null
      and not s.application_secret_tainted
      and (s.reconcile_lease_until is null or s.reconcile_lease_until<=clock_timestamp())
      and s.task_prompt_id is null and cardinality(s.conversation_ids)=0`,
    [...scope, sandboxId, activityToken, generation],
  );
  if (!eligible.rows.length) return "epoch_conflict";
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting"],
    toState: prompt ? "running" : "ready",
    actor: "runtime_enrolment",
    code: "runtime_enrolled",
    effects: [],
  });
  if (result.kind === "conflict") return "epoch_conflict";
  if (prompt) {
    await tx.query(
      `update public.sandboxes set task_prompt_id=$2,conversation_ids=$3::text[],
        activity_lease_id=null,activity_until=null where id=$1`,
      [sandboxId, prompt.promptId, prompt.conversationIds],
    );
    await settleRuntimeTurn(tx, sandboxId, generation);
  } else {
    await tx.query("update public.sandboxes set activity_lease_id=null,activity_until=null where id=$1", [sandboxId]);
  }
  return "applied";
}

async function hasPreparedRuntime(tx: Sql, sandboxId: string, generation: number, epoch: string) {
  const live = await tx.query(
    `select 1 from public.runtime_enrolments where sandbox_id=$1 and lifecycle_generation=$2
      and epoch=$3 and runtime_hash is not null for update`,
    [sandboxId, generation, epoch],
  );
  return live.rows.length > 0;
}

async function finishPromptedNativeLaunch(
  tx: Sql,
  sandboxId: string,
  generation: number,
  activityToken: string,
  prompt: { promptId: string; conversationIds: string[] },
) {
  const {
    rows: [receipt],
  } = await tx.query<{ generation: string }>(
    `update public.sandboxes s set lifecycle_generation=s.lifecycle_generation+1
     where s.id=$1 and s.lifecycle_generation=$2 and s.activity_lease_id=$3
       and s.status='starting' and s.stop_requested_at is null and s.stopped_at is null and s.deleted_at is null
       and s.task_prompt_id is null and cardinality(s.conversation_ids)=0
     returning s.lifecycle_generation::text as generation`,
    [sandboxId, generation, activityToken],
  );
  if (!receipt) return false;
  await publishNativeTurn(tx, sandboxId, "starting", receipt.generation, activityToken, "native_send_accepted");
  await tx.query(
    `update public.sandboxes set task_prompt_id=$2, conversation_ids=$3::text[],
       activity_lease_id=null, activity_until=null where id=$1`,
    [sandboxId, prompt.promptId, prompt.conversationIds],
  );
  return true;
}

export async function recordDockerPromptAccepted(
  tx: Sql,
  sandboxId: string,
  generation: string,
  receipt: { promptId: string; conversationId: string },
) {
  const { rows } = await tx.query(
    `select 1 from public.sandboxes s where s.id=$1 and s.provider='docker' and s.status='ready'
     and (cardinality(s.conversation_ids)=0 or s.conversation_ids=array[$3]::text[])
     and not exists(select 1 from public.runtime_idle_turns t
       where t.sandbox_id=s.id and t.prompt_id=$2 and t.settled)`,
    [sandboxId, receipt.promptId, receipt.conversationId],
  );
  if (!rows.length) return;
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["ready"],
    toState: "running",
    actor: "docker_host",
    code: "docker_prompt_accepted",
    effects: [],
  });
  if (result.kind === "conflict") throw Error("Docker prompt acceptance lost the lifecycle generation.");
}

export async function settleRuntimeTurn(tx: Sql, sandboxId: string, generation: number | string, key?: string) {
  const {
    rows: [eligible],
  } = await tx.query<{ needs_command_evidence: boolean; epoch: string }>(
    `select s.provider='docker' as needs_command_evidence,r.epoch::text
     from public.sandboxes s join public.runtime_enrolments r
       on r.sandbox_id=s.id and r.lifecycle_generation=s.lifecycle_generation
     where s.id=$1 and s.lifecycle_generation=$2 and s.status='running'
       and s.stop_requested_at is null and s.stopped_at is null and s.deleted_at is null
       and s.expires_at>clock_timestamp() and r.runtime_hash is not null
       and case when s.provider='docker' then
         $3::boolean and exists(select 1 from public.runtime_commands c
           where c.sandbox_id=s.id and c.epoch=r.epoch and starts_with(c.request_id,'docker_prompt_'))
         and not exists(
           select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.epoch=r.epoch
             and starts_with(c.request_id,'docker_prompt_')
             and (c.result_enc is null or (c.accepted_prompt_id is not null and not exists(
               select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id
                 and t.prompt_id=c.accepted_prompt_id::text and t.settled))))
       else
         ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))
         and exists(select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id
           and t.prompt_id=s.task_prompt_id and t.settled)
       end`,
    [sandboxId, generation, key !== undefined],
  );
  if (!eligible) return;
  if (eligible.needs_command_evidence && key !== undefined) {
    const ambiguousReplies = await tx.query<{ request_id: string; result_enc: Uint8Array<ArrayBuffer> }>(
      `select c.request_id,c.result_enc from public.runtime_commands c
       where c.sandbox_id=$1 and c.epoch=$2 and starts_with(c.request_id,'docker_prompt_')
         and c.sequence>coalesce((select max(p.sequence) from public.runtime_commands p
           where p.sandbox_id=$1 and p.epoch=$2 and starts_with(p.request_id,'docker_prompt_')
             and p.accepted_prompt_id is not null),0)
       order by c.sequence desc`,
      [sandboxId, eligible.epoch],
    );
    for (const { request_id, result_enc } of ambiguousReplies.rows) {
      const reply = JSON.parse(await decryptSecret(result_enc, key));
      if (
        reply.epoch === eligible.epoch &&
        reply.requestId === request_id &&
        isDockerPromptRefusal(reply.status, reply.body, request_id)
      )
        continue;
      if (reply.status !== 200) return;
      const promptId = reply.body?.result?.promptId;
      if (typeof promptId !== "string") return;
      const settled = await tx.query(
        "select 1 from public.runtime_idle_turns where sandbox_id=$1 and prompt_id=$2 and settled",
        [sandboxId, promptId],
      );
      if (!settled.rows.length) return;
      break;
    }
  }
  await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["running"],
    toState: "ready",
    actor: "runtime_turn",
    code: "runtime_turn_settled",
    effects: [],
  });
}

export async function admitCheckpointedIdleStop(tx: Sql, sandboxId: string, generation: string, requestId: string) {
  const locked = await tx.query(`select id from public.sandboxes where id=$1 and lifecycle_generation=$2 for update`, [
    sandboxId,
    generation,
  ]);
  if (!locked.rows.length) return { kind: "conflict" } satisfies SandboxTransitionResult;
  const {
    rows: [checkpoint],
  } = await tx.query<{ merge_stop: boolean }>(
    `select p.merge_stop from public.runtime_checkpoints p
     join public.runtime_enrolments r on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch
     where p.sandbox_id=$1 and p.request_id=$2::uuid and r.lifecycle_generation=$3
       and r.runtime_hash is not null
       and p.completed_at is not null
       and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=$1)`,
    [sandboxId, requestId, generation],
  );
  if (!checkpoint) return { kind: "conflict" } satisfies SandboxTransitionResult;
  return transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["ready", "running"],
    toState: "stopping",
    actor: "idle",
    code: checkpoint.merge_stop ? "runtime_checkpoint_work_merged" : "runtime_checkpoint_idle_paused",
    effects: [],
  });
}

export async function recordFailedModalLaunchExit(tx: Sql, sandboxId: string, generation: number) {
  const { rows } = await tx.query(
    `update public.sandboxes set stopped_at=coalesce(stopped_at, clock_timestamp())
     where id=$1 and lifecycle_generation=$2 and provider='modal' and runtime_transport='dialout'
       and status='failed' and status_reason=$3 and deleted_at is null and stop_requested_at is null
     returning id`,
    [sandboxId, generation, MODAL_LAUNCH_FAILURE],
  );
  if (!rows.length) throw new Error("Failed Modal launch exit target changed.");
}

export async function recordDockerCleanupReceipt(
  tx: Sql,
  sandboxId: string,
  expectedGeneration: number,
  operation: "stop" | "delete",
) {
  await tx.query(
    `update public.sandboxes set stopped_at=now()
     where id=$1 and lifecycle_generation=$2 and stopped_at is null
       and (status='failed' or ($3::boolean and status='stopped'))`,
    [sandboxId, expectedGeneration, operation === "stop"],
  );
  if (operation === "stop") {
    return transitionSandbox(tx, {
      sandboxId,
      expectedGeneration,
      fromStates: ["stopping"],
      toState: "stopped",
      actor: "lifecycle_runner",
      code: "docker_stop_completed",
      effects: [],
    });
  }
  return transitionSandbox(tx, {
    sandboxId,
    expectedGeneration,
    fromStates: ["stopped", "failed"],
    toState: "deleted",
    actor: "delete_job",
    code: "docker_delete_completed",
    effects: [],
  });
}

export async function expireAfterExtension(
  tx: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
) {
  const visible = await tx.query(
    `select s.id from public.sandboxes s where s.id=$3::uuid and ${SANDBOX_VISIBLE} for update`,
    [...scope, sandboxId],
  );
  if (!visible.rows.length) return false;

  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["ready", "running"],
    toState: "stopping",
    actor: "expiry",
    code: "extension_expired",
    effects: [],
    settlement: {
      lease: null,
      statusReason: null,
      stopRequestedAt: null,
      stoppedAt: null,
      activityLease: activityToken,
    },
  });
  return result.kind === "applied";
}

export async function recordNativeRetentionRefusal(
  tx: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
  providerSandboxId: string,
) {
  const { rows } = await tx.query<{ status: SandboxStatus }>(
    `select s.status from public.sandboxes s
     where s.id=$3::uuid and ${SANDBOX_VISIBLE} and s.provider_sandbox_id=$4 for update of s`,
    [...scope, sandboxId, providerSandboxId],
  );
  const current = rows[0];
  if (!current) return false;

  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: [current.status],
    toState: "stopping",
    actor: "lifecycle_runner",
    code: "native_retention_unconfirmed",
    effects: [],
    settlement: {
      lease: null,
      statusReason: null,
      stopRequestedAt: null,
      stoppedAt: null,
      activityLease: activityToken,
    },
  });
  return result.kind === "applied";
}

export async function carryNativePreservationAcrossStop(tx: Sql, sandboxId: string, generation: string) {
  await tx.query(
    `update public.sandbox_native_preservation_receipts r set generation=$2::bigint, capture_generation=$2::bigint
     from public.sandboxes
     where sandboxes.id=$1 and sandboxes.lifecycle_generation=$2::bigint
       and r.sandbox_id=sandboxes.id and r.generation=$2::bigint-1
       and r.stop_generation=sandboxes.stop_generation and (${NATIVE_CAPTURE_CURRENT})
       and sandboxes.preservation_stop_generation=sandboxes.stop_generation
       and not sandboxes.application_secret_tainted and (${NATIVE_WORK_ROUTE})`,
    [sandboxId, generation],
  );
}

export async function requestStartingModalStop(sql: Sql, scope: readonly [string[], string], sandbox: SandboxRecord) {
  const { id: sandboxId, lifecycleGeneration: generation, status, runtimeTransport } = sandbox;
  if (
    runtimeTransport !== "dialout" ||
    generation === undefined ||
    (status !== "starting" && !isFailedModalLaunch(sandbox))
  )
    return null;
  if (!sql.transaction) throw new Error("Modal launch cancellation requires a transaction.");
  return sql.transaction(async (tx) => {
    const params = [...scope, sandboxId, generation];
    const {
      rows: [launch],
    } = await tx.query<{ allowed: boolean }>(
      `select (s.owner_id=m.user_id or m.role='admin') as allowed
       from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
       join public.jobs j on j.sandbox_id=s.id and j.generation=$4 and j.kind='launch' and j.payload_enc is not null
         and j.org_id=s.org_id and j.request_owner_id=s.owner_id
       where s.id=$3 and s.org_id=any($1::uuid[]) and s.provider='modal'
         and s.runtime_transport='dialout' for share of m`,
      params,
    );
    if (!launch) return null;
    if (!launch.allowed) throw new VaultError("forbidden", "Only the owner or an org admin may stop this sandbox.");
    const {
      rows: [target],
    } = await tx.query<{ status: SandboxStatus; status_reason: string | null }>(
      `select status, status_reason from public.sandboxes
       where id=$1 and lifecycle_generation=$2 and deleted_at is null for update`,
      [sandboxId, generation],
    );
    if (target?.status === "failed" && target.status_reason === MODAL_LAUNCH_FAILURE)
      return { id: sandboxId, status: target.status };
    if (target?.status !== "starting") throw new VaultError("conflict", "Modal launch changed before stop admission.");
    await tx.query(
      `update public.sandboxes set stop_requested_at=coalesce(stop_requested_at, clock_timestamp()) where id=$1`,
      [sandboxId],
    );
    return { id: sandboxId, status: target.status };
  });
}

export async function clearStartingModalStop(tx: Sql, sandboxId: string, generation: number) {
  await tx.query(
    `update public.sandboxes set stop_requested_at=null where id=$1 and lifecycle_generation=$2
       and status='failed' and status_reason=$3 and stop_requested_at is not null`,
    [sandboxId, generation, MODAL_LAUNCH_FAILURE],
  );
}

export async function publishOwnerStop(
  tx: Sql,
  stop: {
    sandboxId: string;
    generation: string;
    fromState: SandboxStatus;
    toState: "stopping" | "stopped" | "failed";
    statusReason?: string | null;
    code: "owner_stop_admitted" | "runtime_retained_stop" | "owner_stop_settled";
  },
) {
  if (stop.fromState === stop.toState) return;
  const result = await transitionSandbox(tx, {
    sandboxId: stop.sandboxId,
    expectedGeneration: stop.generation,
    fromStates: [stop.fromState],
    toState: stop.toState,
    actor:
      stop.code === "owner_stop_settled" ? "lifecycle_runner" : stop.code === "runtime_retained_stop" ? "api" : "owner",
    code: stop.code,
    effects: [],
    ...(stop.statusReason !== undefined
      ? { settlement: { lease: null, statusReason: stop.statusReason, stopRequestedAt: null, stoppedAt: null } }
      : {}),
  });
  if (result.kind === "conflict") throw new Error("Locked owner stop could not transition.");
}

export async function recordNativeDrainDeleteOperation(
  sql: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
  operation: { provider: SandboxRecord["provider"]; placement: string; id: string },
) {
  const { rows } = await sql.query(
    `with owned as materialized (
       select s.id, s.provider, s.provider_sandbox_id, s.activity_until
       from public.sandboxes s
       where s.id=$3::uuid and ${SANDBOX_VISIBLE}
         and s.lifecycle_generation=$4 and s.activity_lease_id=$5 and s.native_drain_pending
         and s.provider=$6::public.sandbox_provider and s.provider in ('boat','modal')
         and s.provider_sandbox_id=$7 and not s.boat_runtime
         and s.runtime_transport is distinct from 'dialout' and s.deleted_at is null
       for update of s
     )
     insert into public.native_drain_delete_operations (sandbox_id, provider, placement, operation_id)
     select id, provider, provider_sandbox_id, $8 from owned where activity_until>clock_timestamp()
     on conflict (sandbox_id) do nothing
     returning sandbox_id`,
    [...scope, sandboxId, generation, activityToken, operation.provider, operation.placement, operation.id],
  );
  return rows.length > 0;
}

export async function completeSandboxDeletion(
  tx: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
  nativeDrain: boolean,
) {
  const { rows } = await tx.query<{ generation: string }>(
    `with owned as materialized (
       select s.id, s.activity_until from public.sandboxes s
       where s.id=$3 and ${SANDBOX_VISIBLE} and s.status in ('stopped','failed')
         and s.lifecycle_generation=$4 and s.activity_lease_id=$5 and s.native_drain_pending=$6::boolean
       for update of s
     ), settled as (update public.sandboxes s set
       lifecycle_generation=s.lifecycle_generation+1, native_drain_pending=false,
       activity_lease_id=null, activity_until=null, preservation_note=null,
       usage_runtime_seconds=case when s.stopped_at is null then null else s.usage_runtime_seconds end,
       usage_running_since=case when s.stopped_at is null then null else s.usage_running_since end,
       stopped_at=coalesce(s.stopped_at, clock_timestamp())
     from owned
     where s.id=owned.id and (not $6::boolean or owned.activity_until>clock_timestamp())
     returning s.id, s.lifecycle_generation::text as generation
     ), cleared as (
       delete from public.native_drain_delete_operations o using settled
       where $6::boolean and o.sandbox_id=settled.id
     )
     select generation from settled`,
    [...scope, sandboxId, generation, activityToken, nativeDrain],
  );
  const receipt = rows[0];
  if (!receipt) return false;
  const transition = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: receipt.generation,
    fromStates: ["stopped", "failed"],
    toState: "deleted",
    actor: "delete_job",
    code: "sandbox_deleted",
    effects: [],
  });
  if (transition.kind === "conflict") throw new Error("Locked sandbox deletion could not transition.");
  await purgeWorkRecovery(tx, sandboxId);
  await releaseAccountCapacity(tx, sandboxId);
  return true;
}

export async function finishLaunchFailure(
  tx: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
  message: string,
  runtimeEpoch: string | undefined,
) {
  if (runtimeEpoch) {
    const {
      rows: [current],
    } = await tx.query<{ status: string }>(
      `select s.status from public.sandboxes s where s.id=$3 and ${SANDBOX_VISIBLE} for update of s`,
      [...scope, sandboxId],
    );
    if (
      !current ||
      (current.status !== "failed" && !(await hasPreparedRuntime(tx, sandboxId, generation, runtimeEpoch)))
    )
      return "epoch_conflict";
  }
  const {
    rows: [sandbox],
  } = await tx.query<{ generation: string; status: "starting" | "failed" }>(
    `update public.sandboxes s set lifecycle_generation=s.lifecycle_generation+1,
       activity_lease_id=null, activity_until=null
     where s.id=$3 and ${SANDBOX_VISIBLE} and (s.status='starting' or (s.status='failed' and s.stopped_at is null))
       and s.provider in ('boat','modal') and s.deleted_at is null and s.stop_requested_at is null
       and s.lifecycle_generation=$4 and s.activity_lease_id=$5
       and (not $6::boolean or (s.activity_until>clock_timestamp() and s.expires_at>clock_timestamp()
         and (s.reconcile_lease_until is null or s.reconcile_lease_until<=clock_timestamp())))
     returning s.lifecycle_generation::text as generation, s.status`,
    [...scope, sandboxId, generation, activityToken, runtimeEpoch !== undefined],
  );
  if (!sandbox) return runtimeEpoch ? "epoch_conflict" : false;
  if (sandbox.status === "failed") return true;
  const result = await recordRuntimeStartupFailure(tx, sandboxId, sandbox.generation, "launch_failed", message);
  if (result.kind === "conflict") throw new Error("Locked launch failure could not transition.");
  return true;
}

export async function recordRuntimeStartupFailure(
  tx: Sql,
  sandboxId: string,
  generation: string,
  code: string,
  message: string,
) {
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting", "ready", "running"],
    toState: "failed",
    actor: "lifecycle_runner",
    code,
    effects: [],
  });
  if (result.kind === "applied") {
    await tx.query("update public.sandboxes set status_reason=$2 where id=$1 and lifecycle_generation=$3", [
      sandboxId,
      message,
      generation,
    ]);
  }
  return result;
}

export async function publishNativeResumeAdmission(
  tx: Sql,
  sandboxId: string,
  fromState: SandboxStatus,
  generation: string,
  activityLease: string,
) {
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: [fromState],
    toState: "starting",
    actor: "native_turn",
    code: "native_resume_admitted",
    effects: [],
    settlement: { lease: null, activityLease, statusReason: null, stopRequestedAt: null, stoppedAt: null },
  });
  if (result.kind === "conflict") throw new VaultError("conflict", "Native resume lost its activity fence.");
}

export async function publishNativeTurn(
  tx: Sql,
  sandboxId: string,
  fromState: SandboxStatus,
  generation: string,
  activityLease: string,
  code: "native_child_send_admitted" | "native_steer_accepted" | "native_send_accepted",
) {
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: [fromState],
    toState: "running",
    actor: "native_turn",
    code,
    effects: [],
    settlement: { lease: null, activityLease, statusReason: null, stopRequestedAt: null, stoppedAt: null },
  });
  if (result.kind === "conflict") throw new Error("Native turn publication lost its activity fence.");
}

export async function recordObservedProviderState(
  sql: Sql,
  scope: [string[], string],
  observation: {
    sandboxId: string;
    generation: number;
    fromState: SandboxStatus;
    toState: "failed" | "stopped" | "ready" | "running" | "starting" | "stopping";
    reason: string | null;
    stoppedAt: string | null;
    providerRunPlacement?: string;
  },
) {
  if (!sql.transaction) throw new Error("Provider observation publication requires a transaction.");
  const { sandboxId, generation, fromState, toState, reason, stoppedAt, providerRunPlacement } = observation;
  const live = fromState === "ready" || fromState === "running";
  const nativeExit = providerRunPlacement !== undefined && stoppedAt !== null;
  const nativeFailure =
    !live && nativeExit && toState === "failed" && (fromState === "failed" || fromState === "stopped");
  const nativeStoppedFailure =
    providerRunPlacement !== undefined && stoppedAt === null && fromState === "stopped" && toState === "failed";
  const nativeStop = !live && nativeExit && toState === "stopped";
  const nativeTurn = toState === "ready" || toState === "running";
  const nativePhase = providerRunPlacement !== undefined && (toState === "starting" || toState === "stopping");
  const nativeAvailability =
    (fromState === "stopped" || fromState === "failed") && nativeTurn && providerRunPlacement !== undefined;
  if (
    fromState === "deleted" ||
    (!live && !nativeStop && !nativeFailure && !nativeStoppedFailure && !nativeAvailability && !nativePhase)
  )
    return { kind: "conflict" } satisfies SandboxTransitionResult;
  if (nativeTurn && providerRunPlacement === undefined)
    throw new Error("Native turn observation requires the observed placement.");
  return sql.transaction(async (tx) => {
    const eligible = await tx.query(
      `select s.id from public.sandboxes s
       where s.id=$3::uuid and ${SANDBOX_VISIBLE}
         and s.provider in ('boat','modal')
         and case when $4::text is null then
           ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))
         else s.provider_sandbox_id=$4 and not s.boat_runtime and s.runtime_transport is distinct from 'dialout' end
         and ($5::boolean or s.stop_requested_at is null) and s.deleted_at is null and not s.native_drain_pending
         and (s.activity_until is null or s.activity_until<now())
         and (s.reconcile_lease_until is null or s.reconcile_lease_until<now())
       for update of s`,
      [...scope, sandboxId, providerRunPlacement ?? null, nativeStop],
    );
    if (!eligible.rows.length) return { kind: "conflict" } satisfies SandboxTransitionResult;
    const path = providerRunPlacement === undefined ? "runtime" : "native";
    const settlesExit = toState === "stopped" || nativeFailure;
    const providerActor = settlesExit ? "runtime_observation" : "lifecycle_runner";
    const providerCode = toState === "failed" ? "failure" : "stopped";
    const turnCode = nativeAvailability
      ? "native_provider_available"
      : toState === "running"
        ? "native_turn_running"
        : "native_turn_settled";
    const result = await transitionSandbox(tx, {
      sandboxId,
      expectedGeneration: generation,
      fromStates: [fromState],
      toState,
      actor: nativeTurn ? "native_turn" : providerActor,
      code: nativePhase ? "native_provider_phase" : nativeTurn ? turnCode : `${path}_provider_${providerCode}`,
      effects: [],
      ...(settlesExit || nativeTurn || nativeStoppedFailure || nativePhase
        ? { settlement: { lease: null, statusReason: reason, stopRequestedAt: null, stoppedAt } }
        : {}),
    });
    if (result.kind === "applied") {
      if (toState === "failed" && !nativeFailure && !nativeStoppedFailure)
        await tx.query(
          "update public.sandboxes set status_reason=$2,stopped_at=coalesce($3::timestamptz,stopped_at) where id=$1",
          [sandboxId, reason, stoppedAt],
        );
      if (stoppedAt !== null) await releaseAccountCapacity(tx, sandboxId);
    }
    return result;
  });
}

export async function deferAmbiguousBoatResume(
  tx: Sql,
  sandboxId: string,
  requestId: string,
  generation: number | undefined,
) {
  await tx.query(
    `update public.sandboxes set activity_until=clock_timestamp(),reconcile_after=clock_timestamp()
     where id=$1 and provider='boat' and boat_runtime and status='starting'
       and activity_lease_id=$2 and lifecycle_generation=$3 and activity_until>clock_timestamp()
       and stop_requested_at is null and deleted_at is null and expires_at>clock_timestamp()
       and (reconcile_lease_until is null or reconcile_lease_until<=clock_timestamp())`,
    [sandboxId, requestId, generation],
  );
}

export async function confirmRuntimeResumeActivation(
  sql: Sql,
  sandboxId: string,
  requestId: string,
  generation: number | undefined,
) {
  const saved = await sql.query(
    `with active as (
      select id,provider from public.sandboxes where id=$1 and status='starting'
        and activity_lease_id=$2 and lifecycle_generation=$3 and activity_until>clock_timestamp()
        and (reconcile_lease_until is null or reconcile_lease_until<=clock_timestamp())
        and stop_requested_at is null and deleted_at is null for update
    ), marked as (
      update public.runtime_resumes r set activated_at=coalesce(r.activated_at,clock_timestamp())
      from active where r.sandbox_id=active.id and r.request_id=$2 and r.phase='dispatched'
      returning r.request_id,active.id,active.provider
    ), protected as (
      update public.sandboxes s set reconcile_after='infinity'::timestamptz
      from marked where s.id=marked.id and marked.provider='modal'
    )
    select request_id from marked`,
    [sandboxId, requestId, generation],
  );
  return saved.rows.length > 0;
}

export async function restoreModalResumeSchedule(tx: Sql, sandboxId: string) {
  await tx.query("update public.sandboxes set reconcile_after=now() where id=$1", [sandboxId]);
}

export async function requestFailedRuntimeResumeStop(
  tx: Sql,
  sandboxId: string,
  requestId: string,
  generation: number | undefined,
  retained: boolean,
) {
  if (generation === undefined) return;
  const {
    rows: [sandbox],
  } = await tx.query<{ application_secret_tainted: boolean }>(
    "select application_secret_tainted from public.sandboxes where id=$1 for update",
    [sandboxId],
  );
  if (!sandbox) return;
  const toState = retained && !sandbox.application_secret_tainted ? "stopping" : "failed";
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting"],
    toState,
    actor: "runtime_resume",
    code: toState === "stopping" ? UNENROLLED_RESUME_STOP : "restore_unconfirmed",
    effects: [],
    settlement: {
      lease: null,
      activityLease: requestId,
      statusReason: null,
      stopRequestedAt: null,
      stoppedAt: null,
    },
  });
  if (result.kind === "applied") return toState;
}

const dockerStartupStates = ["starting", "ready", "running"] as const;

export async function failDockerStartup(
  tx: Sql,
  sandboxId: string,
  expectedGeneration: string | number,
  code: "docker_startup_failed" | "docker_host_retired",
  message: string,
) {
  const fenced = await tx.query<{ generation: string }>(
    `update public.sandboxes set lifecycle_generation=lifecycle_generation+1
     where id=$1 and lifecycle_generation=$2 and provider='docker'
       and status=any($3::public.sandbox_status[]) and stop_requested_at is null
     returning lifecycle_generation::text as generation`,
    [sandboxId, expectedGeneration, [...dockerStartupStates]],
  );
  const activation = fenced.rows[0];
  if (!activation) return false;

  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: activation.generation,
    fromStates: dockerStartupStates,
    toState: "failed",
    actor: "docker_host",
    code,
    effects: [],
  });
  if (result.kind === "conflict") throw new Error("Docker startup changed while settling its failure.");
  await tx.query("update public.sandboxes set status_reason=$2 where id=$1", [sandboxId, message]);
  return true;
}

export async function failDockerResumeActivation(
  tx: Sql,
  sandboxId: string,
  generation: number | string,
  requestId: string,
  reason: string,
) {
  const fenced = await tx.query<{ status: "starting" | "ready" | "running"; generation: string }>(
    `update public.sandboxes s set lifecycle_generation=s.lifecycle_generation+1
     from public.docker_host_jobs resumed
     where s.id=$1 and s.lifecycle_generation=$2 and s.provider='docker'
       and s.status in ('starting','ready','running') and s.stop_requested_at is null and s.deleted_at is null
       and resumed.request_id=$3 and resumed.bound_sandbox_id=s.id and resumed.host_id=s.docker_host_id
       and resumed.bound_operation='resume'
       and not exists (
         select 1 from public.docker_host_jobs later where later.bound_sandbox_id=s.id
           and later.host_id=resumed.host_id and later.bound_operation='resume' and later.position>resumed.position
       ) returning s.status, s.lifecycle_generation::text as generation`,
    [sandboxId, generation, requestId],
  );
  const activation = fenced.rows[0];
  if (!activation) return false;

  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: activation.generation,
    fromStates: [activation.status],
    toState: "failed",
    actor: "docker_host",
    code: "resume_ack_failed",
    effects: [],
  });
  if (result.kind === "conflict") throw new Error("Docker resume activation changed while settling its failure.");
  await tx.query("update public.sandboxes set status_reason=$2 where id=$1", [sandboxId, reason]);
  return true;
}

export async function requestRefusedDockerResumeStop(tx: Sql, sandboxId: string, generation: string) {
  const {
    rows: [eligible],
  } = await tx.query<{ status: "starting" | "failed"; generation: string }>(
    `select s.status,s.lifecycle_generation::text as generation from public.sandboxes s
     where s.id=$1 and s.provider='docker' and s.stop_requested_at is null and s.deleted_at is null
       and s.expires_at>now()
       and ((s.status='starting' and s.lifecycle_generation=$2::bigint)
         or (s.status='failed' and s.lifecycle_generation=$2::bigint+1 and exists (
           select 1 from public.sandbox_transitions t where t.sandbox_id=s.id
             and t.generation=s.lifecycle_generation and t.from_status='starting'
             and t.to_status='failed' and t.actor='docker_host' and t.code='resume_ack_failed'
         )))
     for update`,
    [sandboxId, generation],
  );
  if (!eligible) return false;
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: eligible.generation,
    fromStates: [eligible.status],
    toState: "stopping",
    actor: "docker_host",
    code: "docker_resume_refusal_stop",
    effects: [],
  });
  return result.kind === "applied";
}

export async function confirmRefusedDockerResumeRetention(
  tx: Sql,
  sandboxId: string,
  generation: string | number,
  requestId: string,
) {
  const retained = await tx.query(
    `select s.id from public.sandboxes s
     where s.id=$1 and s.lifecycle_generation=$2 and s.provider='docker' and s.status='stopping'
       and s.status_reason is null and s.stopped_at is null and s.deleted_at is null and s.expires_at>clock_timestamp()
       and not s.application_secret_tainted and cardinality(s.conversation_ids)=1
       and exists (
         select 1 from public.docker_host_jobs stop
         join public.docker_hosts h on h.id=stop.host_id
         join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=stop.bound_actor_id
         join public.members m on m.org_id=e.org_id and m.user_id=e.user_id
         join lateral (
           select r.* from public.docker_host_jobs r
           where r.bound_sandbox_id=s.id and r.bound_operation='resume' and r.position<stop.position
           order by r.position desc limit 1
         ) resume on resume.host_id=stop.host_id and resume.bound_actor_id=stop.bound_actor_id
             and resume.bound_actor_epoch=stop.bound_actor_epoch
         where stop.request_id=$3 and stop.bound_sandbox_id=s.id and stop.bound_operation='stop'
           and stop.host_id=s.docker_host_id and h.installation_id=s.docker_installation_id and h.revoked_at is null
           and stop.bound_actor_id=s.owner_id and stop.bound_actor_epoch=e.epoch
           and stop.created_at=s.stop_requested_at and stop.cancelled_at is null
           and resume.outcome is not null and resume.cancelled_at is null
           and exists (
             select 1 from public.sandbox_transitions t where t.sandbox_id=s.id
               and t.generation=s.lifecycle_generation and t.to_status='stopping'
               and t.actor='docker_host' and t.code='docker_resume_refusal_stop'
               and t.generation=resume.refused_resume_generation+
                 case t.from_status when 'starting' then 1 when 'failed' then 2 end
           )
           and not exists (
             select 1 from public.docker_host_jobs earlier where earlier.bound_sandbox_id=s.id
               and earlier.bound_operation='stop' and earlier.position between resume.position+1 and stop.position-1
           )
       )
       and exists (
         select 1 from public.runtime_enrolments r
         join public.runtime_checkpoints p on p.sandbox_id=r.sandbox_id and p.epoch=r.epoch
         where r.sandbox_id=s.id and p.completed_at is not null
           and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)
       )`,
    [sandboxId, generation, requestId],
  );
  if (!retained.rows.length) return;
  await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["stopping"],
    toState: "stopped",
    actor: "lifecycle_runner",
    code: "docker_resume_retention_confirmed",
    effects: [],
  });
}

async function recoverInterruptedRuntimeResume(
  tx: Sql,
  sandboxId: string,
  lease: string,
  generation: number,
  observedProviderId: string | null,
) {
  const {
    rows: [resume],
  } = await tx.query<{ request_id: string }>(
    `select r.request_id from public.sandboxes s
     join public.runtime_resumes r on r.sandbox_id=s.id and r.request_id=s.activity_lease_id
     join public.runtime_enrolments e on e.sandbox_id=r.sandbox_id and e.epoch=r.source_epoch
     join public.runtime_checkpoints c on c.sandbox_id=r.sandbox_id and c.epoch=r.source_epoch
     where s.id=$1 and s.reconcile_lease=$2 and s.lifecycle_generation=$3
       and s.reconcile_lease_until>clock_timestamp() and s.activity_until<=clock_timestamp()
       and s.status='starting'
       and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>clock_timestamp()
       and not s.application_secret_tainted
       and r.phase='dispatched' and r.receipt is null
       and e.runtime_hash is null
       and (
         (s.provider='boat' and s.boat_runtime and (s.provider_sandbox_id=$4::text or r.activated_at is not null
           or (e.enrolment_hash is not null and e.lifecycle_generation=$3)))
         or (s.provider='modal' and s.runtime_transport='dialout' and r.activated_at is not null)
       )
       and c.watermark=r.watermark
       and c.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)`,
    [sandboxId, lease, generation, observedProviderId],
  );
  if (!resume) return false;

  const transition = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting"],
    toState: "stopping",
    actor: "runtime_resume",
    code: UNENROLLED_RESUME_STOP,
    effects: [],
    settlement: { lease, statusReason: null, stopRequestedAt: null, stoppedAt: null },
  });
  if (transition.kind === "conflict") return false;

  const abandoned = await tx.query(
    `update public.runtime_resumes set phase='abandoned'
     where sandbox_id=$1 and request_id=$2 and phase='dispatched' and receipt is null returning request_id`,
    [sandboxId, resume.request_id],
  );
  if (!abandoned.rows.length) throw Error("Interrupted runtime resume changed before abandonment.");
  return true;
}

/** One bounded batch in the existing server loop. SQL leases serialize replicas; generation
 * fencing prevents an old observation from publishing over a newly admitted resume. */
export function createSandboxLifecycle(
  sql: Sql,
  providerFor: (id: string) => Promise<Provider>,
  options: { now?: () => number; delayMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const delay = options.delayMs ?? 600_000;
  if (!Number.isSafeInteger(delay) || delay < 1) throw Error("Invalid native idle delay.");
  const pending = new Set<Promise<unknown>>();
  // Four slots per authority (eight total). Reserve before SQL so concurrent
  // callers cannot over-admit; keep a reservation until every raw SDK call settles.
  const authorities = ["boat", "modal"] as const;
  const admitted = { boat: 0, modal: 0 };
  let next = 0;
  async function reconcile(providerId: "boat" | "modal", signal?: AbortSignal): Promise<boolean> {
    const raw = new Set<Promise<unknown>>();
    async function operation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      const running = work();
      raw.add(running);
      pending.add(running);
      const settled = running.finally(() => {
        raw.delete(running);
        pending.delete(running);
      });
      if (!signal) return settled;
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    }
    try {
      const token = crypto.randomUUID();
      const row = (
        await sql.query<{
          id: string;
          provider_sandbox_id: string;
          boat_runtime: boolean;
          runtime_transport: string | null;
          lifecycle_generation: number;
          expires_at: Date | string;
          status: string;
          status_reason: string | null;
          task_prompt_id: string | null;
          activity_lease_id: string | null;
          application_secret_tainted: boolean;
          credential_id: string | null;
          credential_version: number | null;
          owner_is_member: boolean;
          retained_resume: boolean;
          checkpointed_stop: boolean;
          interrupted_resume: boolean;
          protected_resume: boolean;
          work_merged: boolean | null;
          preservation_note: string | null;
          stop_requested_at: Date | string | null;
        }>(
          `update public.sandboxes s set reconcile_lease=$1::uuid,
          reconcile_lease_until=now()+interval '2 minutes'
        from (
          select candidate.id,recovery.retained_resume,recovery.modal_resume from public.sandboxes candidate
          cross join lateral (select candidate.status='stopping' and exists(
            select 1 from public.sandbox_transitions t where t.sandbox_id=candidate.id and t.generation=candidate.lifecycle_generation
            and t.actor='runtime_resume' and t.code=$3 and t.to_status='stopping'
          ) as retained_resume, (candidate.provider='modal' and candidate.runtime_transport='dialout'
            and candidate.status='starting' and exists(
              select 1 from public.runtime_resumes r where r.sandbox_id=candidate.id
                and r.request_id=candidate.activity_lease_id and r.phase='dispatched'
                and r.receipt is null and r.activated_at is not null
            )) as modal_resume) recovery
          where candidate.provider = $2 and candidate.status not in ('stopped','deleted')
          -- The launch job owns recovery across retries and worker replacement.
          and not (candidate.provider='modal' and exists(
            select 1 from public.jobs launch
            where launch.kind='launch' and launch.state in ('queued','leased')
              and launch.sandbox_id=candidate.id and launch.generation=candidate.lifecycle_generation
              and launch.org_id=candidate.org_id and launch.request_owner_id=candidate.owner_id
          ))
          -- This transition and the cleanup job commit together.
          and not (candidate.provider='modal' and candidate.status='failed' and exists(
            select 1 from public.sandbox_transitions failure
            where failure.sandbox_id=candidate.id and failure.generation=candidate.lifecycle_generation
              and failure.actor='lifecycle_runner' and failure.code=$5
              and failure.from_status='starting' and failure.to_status='failed'
          ))
          and not exists(select 1 from public.orchestrators parent where parent.sandbox_id=candidate.id)
          and not (candidate.status='failed' and candidate.stopped_at is not null)
          -- Only this worker understands the retained-resume handoff. Old
          -- replicas see an infinite schedule and cannot claim it.
          and (candidate.reconcile_after<=now() or recovery.modal_resume
            or (recovery.retained_resume and coalesce(candidate.lifecycle_error,'') not like $4))
          and (candidate.activity_until is null or candidate.activity_until<now())
          and (candidate.reconcile_lease_until is null or candidate.reconcile_lease_until<now())
          order by case
            when recovery.retained_resume then coalesce(candidate.reconcile_lease_until,candidate.stop_requested_at)
            when recovery.modal_resume then candidate.activity_until
            else candidate.reconcile_after end
          limit 1 for update of candidate skip locked
        ) due
        where s.id=due.id
        returning s.id,s.provider_sandbox_id,s.runtime_transport,s.boat_runtime,s.lifecycle_generation,s.expires_at,s.status::text as status,s.status_reason,s.task_prompt_id,s.activity_lease_id,s.application_secret_tainted,s.credential_id,s.credential_version,s.stop_requested_at,s.preservation_note,
          ${mergedWorkProof("s")} as work_merged,due.retained_resume,
          due.modal_resume as protected_resume,
          (s.status='stopping' and s.stop_requested_at is not null and exists(
            select 1 from public.sandbox_transitions t where t.sandbox_id=s.id
              and t.generation between s.lifecycle_generation-1 and s.lifecycle_generation
              and t.actor='api' and t.code='runtime_retained_stop' and t.to_status='stopping'
          )) as checkpointed_stop,
          (s.provider='boat' and s.boat_runtime and s.status='starting' and exists(
            select 1 from public.runtime_resumes r where r.sandbox_id=s.id and r.request_id=s.activity_lease_id
              and r.phase='dispatched' and r.receipt is null
          )) as interrupted_resume,
          exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id) as owner_is_member`,
          [token, providerId, UNENROLLED_RESUME_STOP, `${OPERATOR_CLEANUP_PREFIX}%`, MODAL_LAUNCH_FAILURE],
        )
      ).rows[0];
      if (!row) return false;
      const recoverInterruptedResume = async (observedProviderId: string | null) => {
        if (!row.interrupted_resume && !row.protected_resume) return false;
        if (!sql.transaction) throw Error("Runtime resume recovery requires a SQL transaction.");
        return sql.transaction(async (tx) => {
          const owned = await tx.query(
            `select id from public.sandboxes where id=$1 and reconcile_lease=$2 and lifecycle_generation=$3
               and reconcile_lease_until>clock_timestamp() for update`,
            [row.id, token, row.lifecycle_generation],
          );
          return (
            owned.rows.length > 0 &&
            (await recoverInterruptedRuntimeResume(tx, row.id, token, row.lifecycle_generation, observedProviderId))
          );
        });
      };
      if (await recoverInterruptedResume(null)) return true;
      // Only an already-requested stop may enter operator custody. This is not
      // provider authority: the worker never substitutes credentials or allocates.
      const operatorStop = row.status === "stopping" && row.stop_requested_at !== null;
      const deferToOperator = async (reason: string) => {
        await sql.query(
          `update public.sandboxes set lifecycle_error=$4,
            reconcile_after='infinity'::timestamptz,reconcile_lease=null,reconcile_lease_until=null
          where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
            and status='stopping' and stop_requested_at is not null
            and reconcile_lease_until>clock_timestamp()
            and (activity_until is null or activity_until<now())`,
          [
            row.id,
            token,
            row.lifecycle_generation,
            `${OPERATOR_CLEANUP_PREFIX} ${reason} Physical outcome unknown; retained identity unchanged. Follow docs/stopping-authority-loss.md.`,
          ],
        );
      };
      if (!row.owner_is_member) {
        if (operatorStop) {
          await deferToOperator("owner membership removed.");
          return true;
        }
        // Missing membership grants no worker management authority. Report the orphan
        // without resolving credentials, observing the machine or changing its status.
        await sql.query(
          `update public.sandboxes set
            lifecycle_error='Cleanup blocked: removed-owner authority is unavailable. Automatic cleanup requires service-owned worker authority.',
            reconcile_after=case when $4 then 'infinity'::timestamptz else now()+interval '1 minute' end,
            reconcile_lease=null,reconcile_lease_until=case when $4 then now()+interval '1 minute' end
          where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
            and reconcile_lease_until>now() and (activity_until is null or activity_until<now())`,
          [row.id, token, row.lifecycle_generation, row.protected_resume],
        );
        return true;
      }
      let terminal = false;
      let physicalExit = false;
      let error: string | null = null;
      let resolved = false;
      let observing = false;
      let initialObservation = true;
      let handingOffObservedResume = false;
      let waitingForRetention = false;
      let stoppedAt: Date | undefined;
      const expired = new Date(row.expires_at).getTime() <= now();
      const retainedResume = row.retained_resume;
      const rollbackRetainedResume = retainedResume && row.runtime_transport === "dialout";
      const native = !row.boat_runtime && row.runtime_transport !== "dialout";
      // Lease expiry is not evidence a native exec completed. Retain its identity
      // until an owner outcome or explicit/TTL cleanup, rather than inventing idle.
      const retainUnknownActivity =
        native &&
        row.activity_lease_id !== null &&
        !expired &&
        !row.stop_requested_at &&
        ["ready", "running"].includes(row.status);
      const canDeferInterruptedResume =
        row.interrupted_resume && !expired && !row.stop_requested_at && !row.application_secret_tainted;
      const deferInterruptedResume = () =>
        sql.query(
          `update public.sandboxes set reconcile_after=now()+interval '1 minute',
             reconcile_lease=null,reconcile_lease_until=null
           where id=$1 and reconcile_lease=$2 and lifecycle_generation=$3 and status='starting'
             and reconcile_lease_until>clock_timestamp() and activity_lease_id=$4
             and activity_until<=clock_timestamp() and expires_at>clock_timestamp()
             and stop_requested_at is null and deleted_at is null and not application_secret_tainted`,
          [row.id, token, row.lifecycle_generation, row.activity_lease_id],
        );
      const settle = async () => {
        if (!sql.transaction) throw new Error("Lifecycle settlement requires a transaction.");
        const lostLease = new Error("Lifecycle lease expired during settlement.");
        return sql
          .transaction(async (tx) => {
            const current = (
              await tx.query<{
                status: SandboxStatus;
                status_reason: string | null;
                stop_requested_at: string | null;
                stopped_at: string | null;
                settled_at: string;
              }>(
                `select status,status_reason,stop_requested_at::text,stopped_at::text,now()::text as settled_at
               from public.sandboxes where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
                 and reconcile_lease_until>clock_timestamp()
                 and (activity_until is null or activity_until<now()) for update`,
                [row.id, token, row.lifecycle_generation],
              )
            ).rows[0];
            if (!current) return true;

            const { status } = current;
            const interrupted = status === "starting";
            const failed = interrupted || physicalExit;
            const pendingRetention =
              waitingForRetention && (status === "ready" || status === "running" || status === "stopping");
            const toState = failed
              ? "failed"
              : terminal && status !== "failed"
                ? "stopped"
                : pendingRetention
                  ? "stopping"
                  : status;
            const expiredStop = terminal && expired && status !== "failed" && current.status_reason !== "work_merged";
            const statusReason = interrupted
              ? (current.status_reason ?? INTERRUPTED_LAUNCH_REASON)
              : physicalExit
                ? ((["idle_paused", "work_merged"].includes(current.status_reason ?? "")
                    ? null
                    : current.status_reason) ??
                  "Provider confirmed physical exit without a new verified recovery checkpoint.")
                : expiredStop
                  ? "expired"
                  : current.status_reason;
            const exitTime = terminal
              ? (current.stopped_at ?? stoppedAt?.toISOString() ?? current.settled_at)
              : current.stopped_at;
            const stopRequestedAt = terminal
              ? null
              : interrupted || pendingRetention
                ? (current.stop_requested_at ?? current.settled_at)
                : current.stop_requested_at;
            if (toState !== status) {
              const result = await transitionSandbox(tx, {
                sandboxId: row.id,
                expectedGeneration: row.lifecycle_generation,
                fromStates: [status],
                toState,
                actor: "reconciler",
                code: interrupted
                  ? "launch_interrupted"
                  : physicalExit
                    ? "provider_exit_without_checkpoint"
                    : pendingRetention
                      ? "stop_requested"
                      : expiredStop
                        ? "expired"
                        : "provider_stopped",
                effects: [],
                settlement: { lease: token, statusReason, stopRequestedAt, stoppedAt: exitTime },
              });
              if (result.kind === "conflict") return true;
            }
            if (toState === status) {
              await tx.query(
                `update public.sandboxes set
                 status_reason=$3,stop_requested_at=$4,stopped_at=$5,
                 transition_context=null,
                 stop_generation=case when $2 and stop_requested_at is null then stop_generation+1 else stop_generation end
               where id=$1`,
                [row.id, pendingRetention, statusReason, stopRequestedAt, exitTime],
              );
            }
            const saved = await tx.query(
              `update public.sandboxes set
               last_observed_at=case when $3::text is null then now() else last_observed_at end,
               activity_lease_id=case when $5 and not $2 then activity_lease_id else null end,
               activity_until=case when $5 and not $2 then activity_until else null end,
               lifecycle_error=$3,
               reconcile_after=case when $6 and not $2 then 'infinity'::timestamptz else now()+interval '1 minute' end,
               reconcile_lease=case when $4 then reconcile_lease else null end,
               reconcile_lease_until=case when $4 then reconcile_lease_until
                 when $6 and not $2 then now()+interval '1 minute' else null end
             where id=$1 and reconcile_lease=$7::uuid and lifecycle_generation=$8
               and reconcile_lease_until>clock_timestamp()
             returning id`,
              [
                row.id,
                terminal,
                error,
                signal?.aborted ?? false,
                retainUnknownActivity,
                retainedResume,
                token,
                row.lifecycle_generation,
              ],
            );
            if (!saved.rows.length) throw lostLease;
            return true;
          })
          .catch((failure: unknown) => {
            if (failure === lostLease) return true;
            throw failure;
          });
      };
      try {
        // Uses persisted owner membership, source credential visibility and pinned Modal App.
        const provider = await operation(signal, () => providerFor(row.id));
        resolved = true;
        if (rollbackRetainedResume) {
          const rollback = (provider as Partial<ModalProvider>).rollbackRuntimeResume;
          if (!rollback) throw Error("Modal rollback authority is unavailable.");
          await operation(signal, () =>
            rollback.call(provider, { sandboxId: row.provider_sandbox_id, generation: row.lifecycle_generation - 1 }),
          );
          terminal = true;
          return settle();
        }
        const observe = async () => {
          observing = true;
          const info = await operation(signal, () => provider.get(row.provider_sandbox_id));
          observing = false;
          return info;
        };
        let info = await observe();
        initialObservation = false;
        if (
          canDeferInterruptedResume &&
          info.id === row.provider_sandbox_id &&
          ["starting", "stopping", "failed"].includes(info.state) &&
          !info.physicalExitConfirmed
        ) {
          handingOffObservedResume = true;
          await deferInterruptedResume();
          return true;
        }
        if (
          row.interrupted_resume &&
          (info.state === "stopped" ||
            ((info.state === "ready" || info.state === "running") && !info.physicalExitConfirmed))
        ) {
          handingOffObservedResume = true;
          if (await recoverInterruptedResume(info.id)) return true;
          handingOffObservedResume = false;
        }
        // Name the persisted selection and provider observation before any capture.
        // No secret values or provider error bodies enter this diagnostic.
        try {
          console.info(
            JSON.stringify({
              event: "sandbox_lifecycle_observation",
              sandboxId: row.id,
              providerSandboxId: row.provider_sandbox_id,
              provider: providerId,
              status: row.status,
              statusReason:
                row.status_reason === null
                  ? null
                  : ["idle_paused", "expired", "agent_finished", "work_merged"].includes(row.status_reason)
                    ? row.status_reason
                    : "other",
              expired,
              stopRequested: row.stop_requested_at !== null,
              normalizedState: info.state,
              retainedSnapshot: info.retainedSnapshot,
              terminal: info.physicalExitConfirmed === true || ["stopped", "deleted"].includes(info.state),
            }),
          );
        } catch {
          /* Diagnostics cannot change lifecycle settlement. */
        }
        const host = isSandboxProvider(provider.id) ? HOST_CAPABILITIES[provider.id] : undefined;
        physicalExit = info.physicalExitConfirmed === true;
        // A native turn's terminal receipt frees model capacity immediately on observation,
        // independently of the later machine-idle timer. Never let a stale receipt settle
        // a new task or an uncertain activity lease.
        if (
          native &&
          row.task_prompt_id &&
          !row.activity_lease_id &&
          !row.stop_requested_at &&
          ["ready", "running"].includes(row.status) &&
          ["ready", "running"].includes(info.state)
        ) {
          const turn = await operation(signal, () =>
            provider.getPrompt({
              sandboxId: row.provider_sandbox_id,
              promptId: row.task_prompt_id!,
              ...(signal ? { signal } : {}),
            }),
          );
          if (turn.promptId === row.task_prompt_id && turn.done && isFinalPromptStatus(turn.status)) {
            await sql.query(
              `select public.enqueue_webhook_turn(id,task_prompt_id,$5) from public.sandboxes
               where id=$1 and reconcile_lease=$2::uuid and lifecycle_generation=$3
                 and reconcile_lease_until>now() and activity_lease_id is null
                 and task_prompt_id=$4 and stop_requested_at is null
                 and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)`,
              [row.id, token, row.lifecycle_generation, row.task_prompt_id, turn.status],
            );
            await recordNativeIdleTurn(sql, row.id, token, row.lifecycle_generation, row.task_prompt_id);
          }
        }
        const workMerged = row.work_merged === true && !row.stop_requested_at;
        const idleStop =
          native &&
          !expired &&
          (["idle_paused", "work_merged"].includes(row.status_reason ?? "") ||
            (!row.stop_requested_at &&
              row.activity_lease_id === null &&
              !row.application_secret_tainted &&
              row.credential_id !== null &&
              row.credential_version !== null &&
              ["ready", "running"].includes(row.status) &&
              (await operation(signal, () =>
                nativeIdleDue(provider, info, row.task_prompt_id, now(), workMerged ? 0 : delay, signal),
              ))));
        if (
          !physicalExit &&
          !["stopped", "deleted"].includes(info.state) &&
          !(host?.waitForPendingStop && info.state === "stopping") &&
          (row.stop_requested_at !== null ||
            row.status === "stopping" ||
            row.status === "starting" ||
            expired ||
            idleStop)
        ) {
          signal?.throwIfAborted();
          if (!sql.transaction) throw new Error("Reconciler stop admission requires a transaction.");
          const stopConflict = new Error("Reconciler stop transition lost ownership.");
          const owned = await sql
            .transaction(async (tx) => {
              const {
                rows: [current],
              } = await tx.query<{
                status: SandboxStatus;
                code: string;
                status_reason: string | null;
                stop_requested_at: string;
                stopped_at: string | null;
              }>(
                `update public.sandboxes
                set reconcile_lease_until=now()+interval '2 minutes',
                  stop_generation=case when status not in ('ready','running') and stop_requested_at is null
                    then stop_generation+1 else stop_generation end,
                  stop_requested_at=case when status not in ('ready','running')
                    then coalesce(stop_requested_at,clock_timestamp()) else stop_requested_at end,
                  status_reason=case when status in ('ready','running') then status_reason
                    when $4 and status='stopping' and status_reason is distinct from 'work_merged' then 'expired'
                    when $5 then case when $6 or status_reason='work_merged' then 'work_merged' else 'idle_paused' end
                    else status_reason end
                where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
                  and status in ('starting','ready','running','stopping','failed')
                  and reconcile_lease_until>clock_timestamp() and (activity_until is null or activity_until<now())
                  and (not $6 or (activity_lease_id is null and stop_requested_at is null and expires_at>now()
                    and ${mergedWorkProof("sandboxes")}))
                  and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)
                returning status, stopped_at::text, coalesce(stop_requested_at,clock_timestamp())::text as stop_requested_at,
                  case when $4 and status_reason is distinct from 'work_merged' then 'expired'
                    when $5 and ($6 or status_reason='work_merged') then 'work_merged'
                    when $5 then 'idle_paused' else 'stop_requested' end as code,
                  case when $4 and status_reason is distinct from 'work_merged' then 'expired'
                    when $5 then case when $6 or status_reason='work_merged' then 'work_merged' else 'idle_paused' end
                    else status_reason end as status_reason`,
                [row.id, token, row.lifecycle_generation, expired, idleStop, workMerged && idleStop],
              );
              if (!current) return false;
              if (current.status !== "ready" && current.status !== "running") return true;
              const result = await transitionSandbox(tx, {
                sandboxId: row.id,
                expectedGeneration: row.lifecycle_generation,
                fromStates: [current.status],
                toState: "stopping",
                actor: "reconciler",
                code: current.code,
                effects: [],
                settlement: {
                  lease: token,
                  statusReason: current.status_reason,
                  stopRequestedAt: current.stop_requested_at,
                  stoppedAt: current.stopped_at,
                },
              });
              if (result.kind === "conflict") throw stopConflict;
              return true;
            })
            .catch((failure: unknown) => {
              if (failure === stopConflict) return false;
              throw failure;
            });
          if (!owned) return true;
          signal?.throwIfAborted();
          // These durable phases already fence native admission. Active-only
          // observation or recapture would prevent the owning reconciler from retrying.
          const reconcilingStop =
            idleStop && info.state === "stopping" && host?.fencedStopPhases.includes(info.providerState) === true;
          const requireIdle = async () => {
            if (!(await nativeQuiescent(provider, info, signal)))
              throw new ProviderError({
                provider: provider.id,
                code: "sandbox_not_ready",
                retryable: true,
                message: "Native work is active or unknown; idle stop waits without interruption.",
              });
          };
          if (idleStop && !reconcilingStop) await operation(signal, requireIdle);
          const preservationProvider = idleStop
            ? new Proxy(provider, {
                get(target, property) {
                  if (property === "quiesce") return requireIdle;
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              })
            : provider;
          // Automatic idle stop may observe quiescence, never interrupt a turn.
          if (
            !idleStop &&
            !row.boat_runtime &&
            row.runtime_transport !== "dialout" &&
            ["ready", "running"].includes(info.state)
          )
            await operation(signal, () =>
              (provider.quiesce ?? provider.interrupt).call(provider, { sandboxId: row.provider_sandbox_id }),
            );
          signal?.throwIfAborted();
          if (
            !reconcilingStop &&
            (await preserveBeforeStop(sql, preservationProvider, row.id, row.provider_sandbox_id, "lifecycle_stop", {
              kind: "reconcile",
              token,
              generation: row.lifecycle_generation,
              signal,
            }).catch(() => "pending" as const)) === "pending"
          )
            throw new ProviderError({
              provider: provider.id,
              code: "sandbox_not_ready",
              retryable: true,
              message: "Interruption is pending; retry stop after turns settle.",
            });
          signal?.throwIfAborted();
          if (idleStop && !reconcilingStop) await operation(signal, requireIdle);
          const requireRetention =
            !expired &&
            (row.checkpointed_stop ||
              retainedResume ||
              idleStop ||
              ["idle_paused", "work_merged"].includes(row.status_reason ?? ""));
          recordStopDispatch(row.id, row.provider_sandbox_id, "lifecycle_stop");
          await operation(signal, () =>
            provider.stop({
              sandboxId: row.provider_sandbox_id,
              ...(requireRetention ? { requireRetention: true } : {}),
            }),
          );
          info = await observe();
        }
        signal?.throwIfAborted();
        physicalExit = info.physicalExitConfirmed === true || info.stopNote === "checkpoint_failed_disk_not_retained";
        stoppedAt = info.stoppedAt;
        waitingForRetention =
          providerId === "boat" &&
          info.state === "stopped" &&
          info.retainedSnapshot !== "usable" &&
          !physicalExit &&
          row.status !== "failed" &&
          row.status !== "starting";
        terminal = !waitingForRetention && (physicalExit || ["stopped", "deleted"].includes(info.state));
        if (waitingForRetention)
          error =
            info.retainedSnapshot === "pending"
              ? "Boat snapshot is pending. Retrying without deleting retained data."
              : "Boat archive has no verified retained snapshot. Retrying without deleting retained data.";
        else if (!terminal && (expired || row.status === "stopping" || row.stop_requested_at !== null))
          error = "Provider stop is not yet confirmed. Retrying without deleting retained data.";
      } catch (caught) {
        if (handingOffObservedResume) throw caught;
        const authorityLost =
          (caught instanceof VaultError &&
            ["missing_credential", "forbidden", "not_found", "credential_refused"].includes(caught.code)) ||
          (caught instanceof ProviderError && ["unauthorized", "forbidden"].includes(caught.code));
        if (authorityLost && operatorStop && !signal?.aborted) {
          await deferToOperator("original provider authority unavailable.");
          return true;
        }
        if (canDeferInterruptedResume && initialObservation && observing) {
          signal?.throwIfAborted();
          if (caught instanceof ProviderError && caught.code !== "not_found" && !authorityLost) {
            await deferInterruptedResume();
            return true;
          }
        }
        // A definitive absence for the exact registered identity is terminal.
        // Never infer absence from transport errors or discover resources by name.
        if (
          resolved &&
          !rollbackRetainedResume &&
          (!row.checkpointed_stop || expired) &&
          (providerId !== "boat" || observing) &&
          caught instanceof ProviderError &&
          caught.code === "not_found"
        ) {
          terminal = true;
          if (providerId === "boat") physicalExit = true;
        }
        // No provider exception text: SDK errors may contain credential-bearing requests.
        else error = "Provider lifecycle observation unavailable. Retrying without deleting retained data.";
      }
      return settle();
    } finally {
      if (raw.size === 0) admitted[providerId]--;
      else
        void Promise.allSettled([...raw]).then(() => {
          admitted[providerId]--;
        });
    }
  }
  return {
    async drain(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
    async reconcileOne(signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const first = next;
      next = (next + 1) % authorities.length;
      for (let offset = 0; offset < authorities.length; offset++) {
        const providerId = authorities[(first + offset) % authorities.length]!;
        if (admitted[providerId] >= 4) continue;
        admitted[providerId]++;
        if (await reconcile(providerId, signal)) return true;
        signal?.throwIfAborted();
      }
      return false;
    },
  };
}

export async function publishRuntimeWake(
  tx: Sql,
  sandboxId: string,
  generation: number,
  requestId: string,
  promptId: string,
  conversationIds: string[],
) {
  const published = await tx.query(
    `update public.sandboxes s set task_prompt_id=$4,conversation_ids=$5::text[],status_reason=null,
       activity_lease_id=null,activity_until=null
     where s.id=$1 and s.lifecycle_generation=$2 and s.activity_lease_id=$3
       and s.status='starting' and s.activity_until>clock_timestamp() and s.expires_at>clock_timestamp()
       and s.stop_requested_at is null and s.stopped_at is null and s.deleted_at is null
       and not s.application_secret_tainted
       and (s.reconcile_lease_until is null or s.reconcile_lease_until<=clock_timestamp())
       and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
     returning s.id`,
    [sandboxId, generation, requestId, promptId, conversationIds],
  );
  if (!published.rows.length) throw new VaultError("conflict", "Runtime wake publication is stale.");
  const transition = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting"],
    toState: "running",
    actor: "runtime_enrolment",
    code: "runtime_enrolled",
    effects: [],
  });
  if (transition.kind === "conflict") throw new VaultError("conflict", "Runtime wake publication is stale.");
  await releaseAccountCapacity(tx, sandboxId);
  await settleRuntimeTurn(tx, sandboxId, generation);
}
