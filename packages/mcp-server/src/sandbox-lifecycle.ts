import type {
  Harness,
  SandboxPlacementProviderId,
  SandboxRecord,
  SandboxStatus,
  SandboxStore,
  SandboxUsage,
  statusReasonOf,
  TaskOutcome,
  Visibility,
} from "@armada/core";
import {
  decryptSecret,
  type MachineIdentity,
  type OutputFailureReason,
  type Provider,
  ProviderError,
  SANDBOX_STOP_MARGIN_SECONDS,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { RELEASE_UPDATED_SANDBOX_RESERVATIONS, releaseAccountCapacity } from "./account-capacity.ts";
import { REFUSE_STOPPED_SANDBOX_TURNS } from "./account-turn-queue-sql.ts";
import type { ServerSandboxPatch } from "./data.ts";
import { DataError } from "./data-error.ts";
import { isDockerPromptRefusal } from "./docker-prompt-refusal.ts";
import type { Job } from "./jobs/runner.ts";
import { createJobsStore, dockerStopPending, mergeStopOutcome, wakeSandboxJobs } from "./jobs/store.ts";
import {
  installModalLaunchHandoff,
  type ModalLaunchHandoff,
  unresolvedModalLaunch,
  unresolvedResume,
} from "./modal-launch-handoff.ts";
import { LIVE_OUTPUT_CANDIDATE } from "./output-transfers.ts";
import { requiresMissingMachineObservation, usesDiskStopJob } from "./provider-runtime-admission.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { unsettledRuntimeCommands } from "./runtime-idle-evidence.ts";
import { SandboxStopTargetChanged } from "./runtime-reconciliation-conflict.ts";
import { requireGenerationHeadroom } from "./sandbox-activity.ts";
import { SANDBOX_DELETION_MANAGED, SANDBOX_VISIBLE } from "./sandbox-visibility.ts";
import { type StopRefusalEvidence, stopRefusalEvidence } from "./stop-refusal-evidence.ts";
import { INTERRUPTED_LAUNCH_REASON, isFailedModalLaunch, MODAL_LAUNCH_FAILURE } from "./turns.ts";
import { deferTransactionWake, eventFeedWakeKey, runtimeWakes } from "./wake-bus.ts";
import { purgeWorkRecovery } from "./work-preservation.ts";

export type DockerSandboxRow = {
  id: string;
  org_id: string;
  owner_id: string;
  provider: string;
  lifecycle_generation: string | number;
  conversation_ids: string[];
  task_prompt_id: string | null;
  provider_sandbox_id: string;
  docker_host_id: string;
  docker_installation_id: string;
  docker_generation: string;
  docker_image: string;
  docker_snapshot_id?: string | null;
  harness: Harness;
  visibility: string;
  status: SandboxRecord["status"];
  status_reason: string | null;
  deleted_at: Date | string | null;
  stop_requested_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
  effective_ttl_seconds: number;
  model: string;
  reasoning_effort: string;
  credential_id: string;
  credential_version: number;
};

export async function insertStartingDockerSandbox(
  tx: Sql,
  sandbox: {
    requestId: string;
    orgId: string;
    ownerId: string;
    physical: string;
    hostId: string;
    installationId: string;
    generation: string;
    image: string;
    model: string;
    reasoningEffort: string;
    credentialId: string;
    credentialVersion: number;
    ttlSeconds: number;
    requestedTtlSeconds: number | null;
    harness: Harness;
    snapshotId: string | null;
    stopWhenWorkMerged?: boolean;
    externalRef?: string;
  },
) {
  const result = await tx.query<DockerSandboxRow>(
    `insert into public.sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,visibility,access_owner_id,
           docker_host_id,docker_installation_id,docker_generation,docker_image,model,reasoning_effort,
           credential_id,credential_version,effective_ttl_seconds,expires_at,requested_ttl_seconds,docker_snapshot_id,stop_when_work_merged,external_ref)
           values($1,$2,$3,'docker',$4,$15,'starting','private',$3,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           now()+$13::integer*interval '1 second',$14,$16,$17,$18) returning *`,
    [
      sandbox.requestId,
      sandbox.orgId,
      sandbox.ownerId,
      sandbox.physical,
      sandbox.hostId,
      sandbox.installationId,
      sandbox.generation,
      sandbox.image,
      sandbox.model,
      sandbox.reasoningEffort,
      sandbox.credentialId,
      sandbox.credentialVersion,
      sandbox.ttlSeconds,
      sandbox.requestedTtlSeconds,
      sandbox.harness,
      sandbox.snapshotId,
      sandbox.stopWhenWorkMerged ?? true,
      sandbox.externalRef ?? null,
    ],
  );
  return result.rows[0];
}

export async function recordDockerPromptProjection(
  tx: Sql,
  sandboxId: string,
  promptId: string,
  requestId: string,
  epoch: string,
  conversationId?: string,
) {
  await tx.query(
    `update public.sandboxes s set task_prompt_id=$2 where s.id=$1 and exists (
   select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.request_id=$3 and c.epoch=$4
   and not exists(select 1 from public.runtime_commands newer where newer.sandbox_id=c.sandbox_id
     and newer.epoch=c.epoch and newer.sequence>c.sequence and starts_with(newer.request_id,'docker_prompt_')))`,
    [sandboxId, promptId, requestId, epoch],
  );
  if (conversationId !== undefined) {
    await tx.query(`update public.sandboxes set conversation_ids=array[$2]::text[] where id=$1`, [
      sandboxId,
      conversationId,
    ]);
  }
}

export async function clearDockerTaskOutcome(tx: Sql, sandboxId: string) {
  await tx.query("update public.sandboxes set task_outcome=null,task_prompt_id=null where id=$1", [sandboxId]);
}

export async function clearMissingDockerRetentionDeadlines(
  tx: Sql,
  hostId: string,
  deadlines: readonly { sandboxId: string; generation: string }[],
) {
  await tx.query(
    `update public.sandboxes set docker_retention_deadline=null
               where docker_host_id=$1 and docker_retention_deadline is not null
                 and not exists (
                   select 1 from unnest($2::uuid[],$3::uuid[]) as held(sandbox_id,generation)
                   where held.sandbox_id=sandboxes.id and held.generation=sandboxes.docker_generation
                 )`,
    [hostId, deadlines.map((entry) => entry.sandboxId), deadlines.map((entry) => entry.generation)],
  );
}

export async function recordDockerRetentionDeadline(
  tx: Sql,
  hostId: string,
  entry: { sandboxId: string; generation: string; deadline: string },
) {
  await tx.query(
    `update public.sandboxes set docker_retention_deadline=$3::timestamptz
               where id=$1 and docker_host_id=$2 and docker_generation=$4 and provider='docker'`,
    [entry.sandboxId, hostId, entry.deadline, entry.generation],
  );
}

export type ModalLaunchSandbox = {
  goldenId: string;
  harness: Harness;
  model: string;
  reasoningEffort: string;
  repositoryDir?: string | null;
  resourceProject?: SandboxRecord["resourceProject"];
  requestedTtlSeconds?: number;
  credentialId?: string;
  credentialVersion?: number;
  visibility?: Visibility;
  externalRef?: string;
  stopWhenWorkMerged?: boolean;
  effectiveTtlSeconds: number;
  machineSize: NonNullable<SandboxRecord["machineSize"]>;
};

export async function insertStartingModalSandbox(
  tx: Sql,
  target: {
    sandboxId: string;
    orgId: string;
    ownerId: string;
    generation: number;
    visibility: "org" | "private";
    snapshot: string;
    provider?: "boat" | "modal";
  },
  sandbox: ModalLaunchSandbox,
) {
  const { sandboxId, orgId, ownerId, generation, visibility, snapshot, provider = "modal" } = target;
  await tx.query(
    `with sandbox as (
       insert into public.sandboxes
       (id, org_id, owner_id, access_owner_id, golden_id, provider, status, runtime_transport, lifecycle_generation,
        visibility, harness, model, reasoning_effort, repository_dir, requested_ttl_seconds, effective_ttl_seconds,
        expires_at, credential_id, credential_version, external_ref, stop_when_work_merged, machine_size, resource_project, boat_runtime)
     values ($1,$2,$3,$3,$4,$19::public.sandbox_provider,'starting',case when $19::public.sandbox_provider='modal' then 'dialout' end,$5,$6,$7,$8,$9,$10,$11,$12,
             now()+$12::integer*interval '1 second',$13,$14,$15,$16,$17::text::jsonb,$18::text::jsonb,$19::public.sandbox_provider='boat')
       returning id
     )
     insert into public.sandbox_source_snapshots (sandbox_id,snapshot_id)
     select id,$20 from sandbox`,
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
      JSON.stringify(sandbox.machineSize),
      sandbox.resourceProject ? JSON.stringify(sandbox.resourceProject) : null,
      provider,
      snapshot,
    ],
  );
}

export async function taintStartingModalSandbox(tx: Sql, sandboxId: string, generation: number) {
  const { rows } = await tx.query(
    `update public.sandboxes set application_secret_tainted=true
     where id=$1 and lifecycle_generation=$2 and status='starting' returning id`,
    [sandboxId, generation],
  );
  if (!rows.length) throw new Error("Modal launch exposure restrictions could not be applied.");
}

export async function bindModalLaunchMachine(tx: Sql, machine: MachineIdentity, provider = "modal") {
  const { rows } = await tx.query(
    `update public.sandboxes set provider_sandbox_id=$3,
         boat_id=case when provider='boat' then $3 else boat_id end
     where id=$1 and lifecycle_generation=$2 and provider::text=$4
       and (runtime_transport='dialout' or boat_runtime)
       and status='starting' and stop_requested_at is null and deleted_at is null
       and provider_sandbox_id is null returning id`,
    [machine.sandboxId, machine.generation, machine.machineId, provider],
  );
  return rows.length === 1;
}

export type StopFence = [providerId: string, token: string, generation: number];

export const WORK_STOP_OWNER = `stop_requested_at is not null and deleted_at is null
  and provider='modal' and runtime_transport='dialout'
  and provider_sandbox_id=$2::text and lifecycle_generation=$4::bigint
  and exists(select 1 from public.jobs j where j.id=split_part($3::text,':',1)::uuid
    and j.lease_epoch::text=split_part($3::text,':',2) and j.sandbox_id=sandboxes.id
    and j.generation=sandboxes.lifecycle_generation and j.kind='stop' and j.state='leased'
    and j.lease_until>clock_timestamp())
  and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)`;

export const STOP_EPOCH = `id=$1::uuid and (${WORK_STOP_OWNER}) and stop_generation=$5::bigint`;
export const COMPLETE_PRESERVATION = `stop_requested_at is not null
  and preservation_stop_generation is not distinct from stop_generation`;

export const NOTE_FENCE = `${STOP_EPOCH} and not (${COMPLETE_PRESERVATION})`;

export function writePreservationNote(
  sql: Sql,
  id: string,
  note: string | null,
  stopToken: string | null,
  fence: StopFence,
) {
  return sql.query(`update public.sandboxes set preservation_note=$6 where ${NOTE_FENCE}`, [
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
) {
  return sql.query<{ id: string }>(
    `with accepted as (
    update public.sandboxes set preservation_note=$6,preservation_stop_generation=$5::bigint
    where ${NOTE_FENCE} and not application_secret_tainted returning id
  )
  insert into public.sandbox_work_recovery(id,sandbox_id,archive_enc)
    select $7::uuid,id,$8::bytea from accepted returning id`,
    [id, ...fence, stopToken, note, recoveryId, encrypted],
  );
}

export function recordCleanWork(sql: Sql, id: string, fence: StopFence, stopToken: string | null) {
  return sql.query<{ id: string }>(
    `with accepted as (
    update public.sandboxes set preservation_note=null,preservation_stop_generation=$5::bigint
    where ${NOTE_FENCE} and not application_secret_tainted returning id
  )
  select id from accepted`,
    [id, ...fence, stopToken],
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

const OPERATOR_CLEANUP_PREFIX = "Operator cleanup required:";

/** Cleanup can adopt a host-confirmed placement without publishing runtime readiness. */
export async function adoptDockerRestoreForCleanup(
  tx: Sql,
  sandboxId: string,
  generation: string | number,
  predecessor: string,
  replacement: string,
) {
  const { rows } = await tx.query(
    `update public.sandboxes set docker_generation=$4,
       provider_sandbox_id=concat('armada-',docker_installation_id,'-',docker_host_id,'-',id,'-',$4::uuid)
     where id=$1 and lifecycle_generation=$2 and provider='docker' and docker_generation=$3 returning id`,
    [sandboxId, generation, predecessor, replacement],
  );
  return rows.length === 1;
}

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
         and j.org_id=s.org_id and j.kind='resume' and j.state='leased' and j.attempts <= j.max_attempts
       for update of j
     ), eligible as materialized (
       select s.id,s.docker_generation,s.provider_sandbox_id from public.sandboxes s cross join locked_runner j
       where s.id=$2 and s.lifecycle_generation=$3 and s.provider='docker'
         and s.docker_host_id=$5 and s.docker_installation_id=$6 and s.docker_generation in ($7,$8)
         and (s.status='starting' or (s.docker_generation=$8 and s.status in ('ready','running')))
         and s.stop_requested_at is null and s.deleted_at is null and s.expires_at > clock_timestamp()
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
  const { rows } = await tx.query<{
    launch_job_id: string | null;
    provider_sandbox_id: string;
    org_id: string;
    owner_id: string;
    visibility: string;
    handoff: ModalLaunchHandoff | null;
  }>(
    `select launch.id as launch_job_id, s.provider_sandbox_id, s.org_id, s.owner_id, s.visibility, launch.handoff
     from public.sandboxes s
     left join lateral (
       select j.id, j.outcome->'modal_handoff' as handoff from public.jobs j
       where s.provider='modal' and not $2::boolean
         and j.sandbox_id=s.id and j.org_id=s.org_id and j.request_owner_id=s.owner_id
         and j.generation=s.lifecycle_generation and j.kind='launch' and j.state in ('queued','leased')
         and j.outcome #>> '{modal_machine,entry,operation}'='create'
         and j.outcome #>> '{modal_machine,entry,phase}'='allocated'
         and j.outcome #>> '{modal_machine,entry,machineId}'=s.provider_sandbox_id
     ) launch on true
     where s.id=$1 and s.status='starting' and s.lifecycle_generation=$3
       and (
         (s.provider='docker' and exists(
           select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id
           and j.bound_operation='create' and j.outcome='completed'
         ))
         or exists(select 1 from public.jobs j where not $2::boolean and j.kind='resume' and j.sandbox_id=s.id
           and j.generation=s.lifecycle_generation and j.outcome ? 'bootstrap_ticket_enc' and j.state in ('queued','leased'))
         or launch.id is not null
         or (s.provider='boat' and s.boat_runtime and not $2::boolean and exists(
           select 1 from public.jobs j where j.kind='launch' and j.sandbox_id=s.id
             and j.org_id=s.org_id and j.request_owner_id=s.owner_id
             and j.generation=s.lifecycle_generation and j.state in ('queued','leased')
             and j.outcome #>> '{modal_machine,entry,machineId}'=s.provider_sandbox_id
             and j.outcome->>'boat_authority_sha256' is not null
         ))
       )`,
    [sandboxId, enrolment === "retained", generation],
  );
  const [row] = rows;
  if (!row) return "skipped";
  if (row.launch_job_id !== null) {
    const handoff = row.handoff;
    if (
      rows.length !== 1 ||
      !handoff ||
      handoff.scope.orgId !== row.org_id ||
      handoff.scope.userId !== row.owner_id ||
      handoff.scope.visibility !== row.visibility ||
      handoff.record.info.id !== row.provider_sandbox_id ||
      handoff.record.physicalId !== row.provider_sandbox_id ||
      String(handoff.record.generation) !== generation
    )
      return "conflict";
    await installModalLaunchHandoff(tx, handoff);
  }
  const transition = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting"],
    toState: "ready",
    actor: "runtime_enrolment",
    code: "runtime_enrolled",
    effects: [],
  });
  if (transition.kind === "applied") {
    await wakeSandboxJobs(tx, sandboxId, ["launch", "resume", "stop"], generation);
  }
  return transition.kind;
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

export async function enqueueBoatStop(tx: Sql, id: string, generation: string | number, admissionToken?: string) {
  const {
    rows: [target],
  } = await tx.query<{ org_id: string; deadline: number }>(
    `update public.sandboxes set reconcile_after='infinity'::timestamptz,
       activity_lease_id=case when $3::uuid is not null then null else activity_lease_id end,
       activity_until=case when $3::uuid is not null then null else activity_until end
     where id=$1 and lifecycle_generation=$2 and provider='boat'
       and provider_sandbox_id is not null and status in ('stopping','failed')
       and stopped_at is null and stop_requested_at is not null and deleted_at is null
       and ($3::uuid is null or activity_lease_id=$3)
     returning org_id, (extract(epoch from clock_timestamp()+interval '2 minutes')*1000)::float8 as deadline`,
    [id, generation, admissionToken ?? null],
  );
  if (!target) return;
  await createJobsStore(tx).enqueue(
    "stop",
    id,
    requireGenerationHeadroom(generation, 0),
    "boat",
    null,
    { orgId: target.org_id, deadline: new Date(target.deadline), maxAttempts: 60 },
    tx,
  );
}

export async function holdUnconfirmedBoatStop(tx: Sql, id: string, generation: number) {
  await tx.query(
    `update public.sandboxes set lifecycle_error='Operator cleanup required: Boat stop could not confirm exact exit and required retention.',
       reconcile_after='infinity'::timestamptz
     where id=$1 and lifecycle_generation=$2 and provider='boat' and stop_requested_at is not null`,
    [id, generation],
  );
}

export async function settleBoatStop(tx: Sql, id: string, generation: number, note: string | null, stoppedAt: Date) {
  const {
    rows: [current],
  } = await tx.query<{ status: string }>(
    `update public.sandboxes set stopped_at=$4::timestamptz,stop_requested_at=null,
       activity_lease_id=null,activity_until=null,reconcile_lease=null,reconcile_lease_until=null,reconcile_after=now(),
       preservation_note=case when application_secret_tainted then 'Application-secret exposure forbids archives and disk reuse.' else coalesce($3,preservation_note) end,lifecycle_error=null
     where id=$1 and lifecycle_generation=$2 and provider='boat'
       and status in ('stopping','failed') and stop_requested_at is not null and stopped_at is null
     returning status::text`,
    [id, generation, note, stoppedAt],
  );
  if (!current) throw new Error("Boat stop settlement changed.");
  if (current.status === "stopping") {
    const settled = await transitionSandbox(tx, {
      sandboxId: id,
      expectedGeneration: generation,
      fromStates: ["stopping"],
      toState: "stopped",
      actor: "lifecycle_runner",
      code: "owner_stop_settled",
      effects: [],
    });
    if (settled.kind !== "applied") throw new Error("Boat stop settlement changed.");
  }
  await detachBoatExtension(tx, id, generation);
  await releaseAccountCapacity(tx, id);
}

export async function pendingModalStopOutput(tx: Sql, sandboxId: string, generation: number | string) {
  const { rows } = await tx.query(
    `select 1 from public.jobs where sandbox_id=$1 and generation=$2 and kind='stop'
       and state in ('queued','leased') and outcome ? 'output'`,
    [sandboxId, generation],
  );
  return rows.length > 0;
}

export function holdModalStop(tx: Sql, sandboxId: string, generation: string) {
  return tx.query(
    `update public.sandboxes set lifecycle_error=$3,reconcile_after='infinity'
     where id=$1 and lifecycle_generation=$2 and stop_requested_at is not null`,
    [
      sandboxId,
      generation,
      `${OPERATOR_CLEANUP_PREFIX} Original Modal authority unavailable. Follow docs/stopping-authority-loss.md.`,
    ],
  );
}

export function unresolvedModalStop(sandbox: string) {
  return `(${sandbox}.provider='modal' and ${sandbox}.stopped_at is null and exists(select 1 from public.jobs j where j.sandbox_id=${sandbox}.id
    and j.generation=${sandbox}.lifecycle_generation and j.kind='stop' and j.state in ('queued','leased')))`;
}

export async function enqueueModalStop(
  tx: Sql,
  sandboxId: string,
  generation: string | number,
  lease?: string,
  childOperation?: string,
) {
  const {
    rows: [target],
  } = await tx.query<{ org_id: string }>(
    `select org_id from public.sandboxes where id=$1 and lifecycle_generation=$2
     and provider='modal' and runtime_transport='dialout' and status in ('stopping','failed') and stopped_at is null`,
    [sandboxId, generation],
  );
  if (!target) return false;
  const jobId = await createJobsStore(tx).enqueue(
    "stop",
    sandboxId,
    requireGenerationHeadroom(generation, 0),
    "modal-stop",
    null,
    {
      orgId: target.org_id,
      deadline: new Date(Date.now() + 120_000),
      maxAttempts: 8,
    },
    tx,
  );
  if (childOperation) await mergeStopOutcome(tx, jobId, { modal_child_operation: childOperation });
  if (lease) {
    const result = await tx.query(
      `update public.sandboxes set activity_lease_id=null,activity_until=null,reconcile_lease=null,reconcile_lease_until=null
       where id=$1 and lifecycle_generation=$2 and $3::uuid in (activity_lease_id,reconcile_lease) returning id`,
      [sandboxId, generation, lease],
    );
    if (!result.rows.length) throw new Error("Modal stop admission lost its lease handoff.");
  }
  return true;
}

export async function prepareResumeGeneration(tx: Sql, id: string, generation: number) {
  await tx.query(
    "update public.sandboxes set task_prompt_id=null,task_outcome=null where id=$1 and lifecycle_generation=$2 and status='starting'",
    [id, generation],
  );
  await detachBoatExtension(tx, id, generation, true);
}

export async function stopUnfinishedResume(tx: Sql, sandboxId: string, generation: number, boat: boolean) {
  await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["starting", "ready"],
    toState: "stopping",
    actor: "expiry",
    code: "resume_dispatch_ended",
    effects: [
      {
        kind: "stop",
        idem_key: boat ? "boat" : "modal-stop",
        max_attempts: boat ? 60 : 8,
        deadline_at: new Date(Date.now() + 120_000).toISOString(),
      },
    ],
  });
}

export async function settleModalStop(
  tx: Sql,
  sandboxId: string,
  generation: string,
  status: "stopping" | "failed",
  retentionLost: boolean,
) {
  if (status === "stopping") {
    const result = await transitionSandbox(tx, {
      sandboxId,
      expectedGeneration: generation,
      fromStates: ["stopping"],
      toState: retentionLost ? "failed" : "stopped",
      actor: "lifecycle_runner",
      code: "owner_stop_settled",
      effects: [],
    });
    if (result.kind === "conflict") throw new Error("Modal stop settlement changed generation.");
  }
  const applied = await tx.query(
    `update public.sandboxes set stopped_at=coalesce(stopped_at,clock_timestamp()),stop_requested_at=null,
      status_reason=case when $3::boolean then 'modal_stop_retention_unconfirmed' else status_reason end
    where id=$1 and lifecycle_generation=$2 and status in ('failed','stopped') returning id`,
    [sandboxId, generation, status === "stopping" && retentionLost],
  );
  if (!applied.rows.length) throw new Error("Modal stop exit lost its generation.");
}

export async function admitCheckpointedIdleStop(tx: Sql, sandboxId: string, generation: string, requestId: string) {
  const locked = await tx.query(
    `select id from public.sandboxes s where id=$1 and lifecycle_generation=$2
       and not ${unresolvedModalLaunch("s")} for update`,
    [sandboxId, generation],
  );
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
  const result = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["ready", "running"],
    toState: "stopping",
    actor: "idle",
    code: checkpoint.merge_stop ? "runtime_checkpoint_work_merged" : "runtime_checkpoint_idle_paused",
    effects: [],
  });
  if (result.kind === "applied" && !(await enqueueModalStop(tx, sandboxId, result.generation)))
    await enqueueBoatStop(tx, sandboxId, result.generation);
  return result;
}

export async function recordFailedModalLaunchExit(tx: Sql, sandboxId: string, generation: number, provider = "modal") {
  const { rows } = await tx.query(
    `update public.sandboxes set stopped_at=coalesce(stopped_at, clock_timestamp())
     where id=$1 and lifecycle_generation=$2 and provider::text=$4 and (runtime_transport='dialout' or boat_runtime)
       and status='failed' and status_reason=$3 and deleted_at is null and stop_requested_at is null
     returning id`,
    [sandboxId, generation, MODAL_LAUNCH_FAILURE, provider],
  );
  if (!rows.length) throw new Error("Failed Modal launch exit target changed.");
}

export async function recordDockerCleanupReceipt(
  tx: Sql,
  sandboxId: string,
  expectedGeneration: number,
  operation: "stop" | "delete" | "stop_retention_lost",
) {
  if (operation === "stop_retention_lost") {
    const { rows } = await tx.query<{ status: string }>(
      `update public.sandboxes set stopped_at=coalesce(stopped_at,now()),stop_requested_at=null
       where id=$1 and lifecycle_generation=$2 and provider='docker' and status in ('failed','stopping') returning status`,
      [sandboxId, expectedGeneration],
    );
    if (!rows.length) return { kind: "conflict" } as const;
    if (rows[0]?.status === "failed") return { kind: "applied", generation: expectedGeneration } as const;
    return transitionSandbox(tx, {
      sandboxId,
      expectedGeneration,
      fromStates: ["stopping"],
      toState: "failed",
      actor: "lifecycle_runner",
      code: "docker_stop_retention_lost",
      effects: [],
    });
  }
  const { rows } = await tx.query(
    `update public.sandboxes set stopped_at=coalesce(stopped_at,now())
     where id=$1 and lifecycle_generation=$2
       and (status='failed' or ($3::boolean and status='stopped')) returning 1`,
    [sandboxId, expectedGeneration, operation === "stop"],
  );
  if (operation === "stop") {
    if (rows.length) return { kind: "applied", generation: expectedGeneration } as const;
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

export async function requestStartingModalStop(
  sql: Sql,
  scope: readonly [string[], string],
  sandbox: SandboxRecord,
  signal?: AbortSignal,
) {
  const { id: sandboxId, lifecycleGeneration: generation, status, modalTransport, boatRuntime } = sandbox;
  if (
    (modalTransport !== "dialout" && !boatRuntime) ||
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
       where s.id=$3 and s.org_id=any($1::uuid[])
         and (s.runtime_transport='dialout' or s.boat_runtime) for share of m`,
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
    if (target?.status !== "starting") throw new SandboxStopTargetChanged();
    signal?.throwIfAborted();
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

async function detachBoatExtension(tx: Sql, sandboxId: string, generation: number | string, resuming = false) {
  await tx.query(
    `update public.boat_runtime_extension_state e set pending_job_id=null
     from public.sandboxes s, public.jobs j
     where s.id=$1 and s.lifecycle_generation=$2 and s.provider='boat' and s.boat_runtime
       and (case when $3::boolean then s.status='starting' and j.generation<s.lifecycle_generation
         else s.status in ('stopped','failed') and s.stopped_at is not null end)
       and e.sandbox_id=s.id and j.id=e.pending_job_id and j.sandbox_id=s.id
       and j.kind='boat_runtime_extend' and j.generation<=s.lifecycle_generation`,
    [sandboxId, generation, resuming],
  );
}

export async function publishOwnerStop(
  tx: Sql,
  stop: {
    sandboxId: string;
    generation: string;
    fromState: SandboxStatus;
    toState: "stopping" | "failed";
    statusReason?: string | null;
    code: "owner_stop_admitted" | "runtime_retained_stop";
  },
) {
  if (stop.fromState !== stop.toState) {
    const result = await transitionSandbox(tx, {
      sandboxId: stop.sandboxId,
      expectedGeneration: stop.generation,
      fromStates: [stop.fromState],
      toState: stop.toState,
      actor: stop.code === "runtime_retained_stop" ? "api" : "owner",
      code: stop.code,
      effects: [],
      ...(stop.statusReason !== undefined
        ? { settlement: { lease: null, statusReason: stop.statusReason, stopRequestedAt: null, stoppedAt: null } }
        : {}),
    });
    if (result.kind === "conflict") throw new Error("Locked owner stop could not transition.");
  }
}

export async function completeSandboxDeletion(
  tx: Sql,
  scope: [string[], string],
  sandboxId: string,
  generation: number,
  activityToken: string,
) {
  const { rows } = await tx.query<{ generation: string }>(
    `with locked as materialized (
       select s.* from public.sandboxes s
       where s.id=$3 and ${SANDBOX_VISIBLE} and s.status in ('stopped','failed')
         and s.lifecycle_generation=$4 and s.activity_lease_id=$5
       for update of s
     ), settled as (update public.sandboxes s set
       lifecycle_generation=s.lifecycle_generation+1,
       activity_lease_id=null, activity_until=null, preservation_note=null,
       usage_runtime_seconds=case when s.stopped_at is null then null else s.usage_runtime_seconds end,
       usage_running_since=case when s.stopped_at is null then null else s.usage_running_since end,
       stopped_at=coalesce(s.stopped_at, clock_timestamp())
     from locked
     where s.id=locked.id
     returning s.id, s.lifecycle_generation::text as generation
     )
     select generation from settled`,
    [...scope, sandboxId, generation, activityToken],
  );
  const receipt = rows[0];
  if (!receipt) return false;
  await finishSandboxDeletion(tx, sandboxId, receipt.generation);
  return true;
}

async function finishSandboxDeletion(tx: Sql, sandboxId: string, generation: string) {
  const transition = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: generation,
    fromStates: ["stopped", "failed"],
    toState: "deleted",
    actor: "delete_job",
    code: "sandbox_deleted",
    effects: [],
  });
  if (transition.kind === "conflict") throw new Error("Locked sandbox deletion could not transition.");
  await purgeWorkRecovery(tx, sandboxId);
  await releaseAccountCapacity(tx, sandboxId);
}

export async function requestBoatLaunchFailure(tx: Sql, sandboxId: string, generation: string) {
  const { rows } = await tx.query(
    `update public.sandboxes s set stop_requested_at=coalesce(stop_requested_at, clock_timestamp())
     where s.id=$1 and s.lifecycle_generation=$2 and s.status='starting' and s.boat_runtime
       and ${unresolvedModalLaunch("s")} returning s.id`,
    [sandboxId, generation],
  );
  return rows.length > 0;
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
  },
) {
  if (!sql.transaction) throw new Error("Provider observation publication requires a transaction.");
  const { sandboxId, generation, fromState, toState, reason, stoppedAt } = observation;
  const live = fromState === "ready" || fromState === "running";
  if (!live || (toState !== "stopped" && toState !== "failed"))
    return { kind: "conflict" } satisfies SandboxTransitionResult;
  return sql.transaction(async (tx) => {
    const eligible = await tx.query(
      `select s.id from public.sandboxes s
       where s.id=$3::uuid and ${SANDBOX_VISIBLE}
         and ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))
         and s.stop_requested_at is null and s.deleted_at is null
         and not ${unresolvedModalLaunch("s")}
         and (s.activity_until is null or s.activity_until<now())
         and (s.reconcile_lease_until is null or s.reconcile_lease_until<now())
       for update of s`,
      [...scope, sandboxId],
    );
    if (!eligible.rows.length) return { kind: "conflict" } satisfies SandboxTransitionResult;
    const result = await transitionSandbox(tx, {
      sandboxId,
      expectedGeneration: generation,
      fromStates: [fromState],
      toState,
      actor: toState === "stopped" ? "runtime_observation" : "lifecycle_runner",
      code: toState === "stopped" ? "runtime_provider_stopped" : "runtime_provider_failure",
      effects: [],
      ...(toState === "stopped"
        ? { settlement: { lease: null, statusReason: reason, stopRequestedAt: null, stoppedAt } }
        : {}),
    });
    if (result.kind === "applied") {
      if (toState === "failed")
        await tx.query(
          "update public.sandboxes set status_reason=$2,stopped_at=coalesce($3::timestamptz,stopped_at) where id=$1",
          [sandboxId, reason, stoppedAt],
        );
      if (stoppedAt !== null) {
        if (toState === "stopped" || toState === "failed") await detachBoatExtension(tx, sandboxId, result.generation);
        await releaseAccountCapacity(tx, sandboxId);
      }
    }
    return result;
  });
}

export async function restoreResumeSchedule(tx: Sql, sandboxId: string) {
  await tx.query("update public.sandboxes set reconcile_after=now() where id=$1", [sandboxId]);
}

export async function recordBoatResumeCoverage(
  tx: Sql,
  id: string,
  machineId: string,
  generation: number,
  deadline: number,
) {
  const saved = await tx.query(
    `insert into public.boat_runtime_extension_state
       (sandbox_id,observed_provider_id,observed_generation,observed_at,observed_expires_at)
     select id,provider_sandbox_id,lifecycle_generation,clock_timestamp(),$4::timestamptz from public.sandboxes
     where id=$1 and boat_runtime and provider_sandbox_id=$2 and lifecycle_generation=$3
       and $4::timestamptz >= expires_at + $5::integer * interval '1 second'
     on conflict (sandbox_id) do update set observed_provider_id=excluded.observed_provider_id,
       observed_generation=excluded.observed_generation,observed_at=excluded.observed_at,
       observed_expires_at=excluded.observed_expires_at returning sandbox_id`,
    [id, machineId, generation, new Date(deadline).toISOString(), SANDBOX_STOP_MARGIN_SECONDS],
  );
  if (!saved.rows.length) throw Error("Boat resume compute coverage changed.");
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
       and not ${dockerStopPending("sandboxes.id", "sandboxes.lifecycle_generation")}
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

/** One bounded batch in the existing server loop. SQL leases serialize replicas; generation
 * fencing prevents an old observation from publishing over a newly admitted resume. */
export function createSandboxLifecycle(
  sql: Sql,
  providerFor: (id: string) => Promise<Provider>,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
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
          lifecycle_generation: number;
          expiry_epoch: string;
          status: string;
          status_reason: string | null;
          task_prompt_id: string | null;
          application_secret_tainted: boolean;
          owner_is_member: boolean;
          checkpointed_stop: boolean;
          preservation_note: string | null;
          stop_requested_at: Date | string | null;
        }>(
          `update public.sandboxes s set reconcile_lease=$1::uuid,
          reconcile_lease_until=now()+interval '2 minutes'
        from (
          select candidate.id from public.sandboxes candidate
          where candidate.provider = $2 and candidate.status not in ('stopped','deleted')
          and (candidate.provider<>'modal' or candidate.runtime_transport='dialout')
          and not ${unresolvedModalStop("candidate")}
          -- The launch job owns recovery across retries and worker replacement.
          and not ${unresolvedModalLaunch("candidate")} and not ${unresolvedResume("candidate")}
          -- This transition and the cleanup job commit together.
          and not ((candidate.provider='modal' or candidate.boat_runtime) and candidate.status='failed' and exists(
            select 1 from public.sandbox_transitions failure
            where failure.sandbox_id=candidate.id and failure.generation=candidate.lifecycle_generation
              and failure.actor='lifecycle_runner' and failure.code=$3
              and failure.from_status='starting' and failure.to_status='failed'
          ))
          and not exists(select 1 from public.orchestrators parent where parent.sandbox_id=candidate.id)
          and not (candidate.status='failed' and candidate.stopped_at is not null)
          and candidate.reconcile_after<=now()
          and (candidate.activity_until is null or candidate.activity_until<now())
          and (candidate.reconcile_lease_until is null or candidate.reconcile_lease_until<now())
          -- Skip known contention before LIMIT. The lease trigger checks again under the row lock.
          and not (candidate.provider='boat' and exists(
            select 1 from public.jobs j where j.sandbox_id=candidate.id
              and ((j.kind='boat_runtime_extend' and j.state='leased' and j.lease_until>now())
                or (j.kind='stop' and j.generation=candidate.lifecycle_generation))
          ))
          order by candidate.reconcile_after
          limit 1 for update of candidate skip locked
        ) due
        where s.id=due.id
        returning s.id,s.provider_sandbox_id,s.boat_runtime,s.lifecycle_generation,extract(epoch from s.expires_at)::text as expiry_epoch,s.status::text as status,s.status_reason,s.task_prompt_id,s.application_secret_tainted,s.stop_requested_at,s.preservation_note,
          ((s.boat_runtime or s.runtime_transport is not distinct from 'dialout')
            and s.status='stopping' and s.stop_requested_at is not null and exists(
            select 1 from public.sandbox_transitions t where t.sandbox_id=s.id
              and t.generation between s.lifecycle_generation-1 and s.lifecycle_generation
              and t.actor='api' and t.code='runtime_retained_stop' and t.to_status='stopping'
          )) as checkpointed_stop,
          exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id) as owner_is_member`,
          [token, providerId, MODAL_LAUNCH_FAILURE],
        )
      ).rows[0];
      if (!row) return false;
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
            reconcile_after=now()+interval '1 minute',reconcile_lease=null,reconcile_lease_until=null
          where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
            and reconcile_lease_until>now() and (activity_until is null or activity_until<now())`,
          [row.id, token, row.lifecycle_generation],
        );
        return true;
      }
      let terminal = false;
      let physicalExit = false;
      let error: string | null = null;
      let resolved = false;
      let observing = false;
      const jobOwnsStop = usesDiskStopJob(providerId);
      const requireMissingObservation = requiresMissingMachineObservation(providerId);
      let stoppedAt: Date | undefined;
      const logicalDeadline = Number(row.expiry_epoch) * 1000;
      const expired = logicalDeadline <= now();
      const handoffBoatStop = async (expiry: boolean) => {
        if (!sql.transaction) throw Error("Boat stop handoff requires a transaction.");
        await sql.transaction(async (tx) => {
          const {
            rows: [current],
          } = await tx.query<{ status: SandboxStatus; stop_at: string }>(
            `select status,coalesce(stop_requested_at,clock_timestamp())::text as stop_at
             from public.sandboxes where id=$1 and lifecycle_generation=$2 and reconcile_lease=$3
               and reconcile_lease_until>clock_timestamp() and (activity_until is null or activity_until<=clock_timestamp())
               and deleted_at is null and stopped_at is null and provider_sandbox_id=$4
               and extract(epoch from expires_at)=$5::numeric
               and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)
             for update`,
            [row.id, row.lifecycle_generation, token, row.provider_sandbox_id, row.expiry_epoch],
          );
          if (!current) {
            await tx.query(
              "update public.sandboxes set reconcile_lease=null,reconcile_lease_until=null where id=$1 and reconcile_lease=$2",
              [row.id, token],
            );
            return;
          }
          if (current.status === "ready" || current.status === "running" || current.status === "starting") {
            const starting = current.status === "starting";
            const applied = await transitionSandbox(tx, {
              sandboxId: row.id,
              expectedGeneration: row.lifecycle_generation,
              fromStates: [current.status],
              toState: starting ? "failed" : "stopping",
              actor: "reconciler",
              code: starting ? "launch_interrupted" : expiry ? "expired" : "stop_requested",
              effects: [],
              settlement: {
                lease: token,
                statusReason: starting
                  ? (row.status_reason ?? INTERRUPTED_LAUNCH_REASON)
                  : expiry
                    ? "expired"
                    : row.status_reason,
                stopRequestedAt: current.stop_at,
                stoppedAt: null,
              },
            });
            if (applied.kind !== "applied") throw Error("Boat stop admission changed.");
          }
          await tx.query(
            `update public.sandboxes set reconcile_lease=null,reconcile_lease_until=null,
               activity_lease_id=null,activity_until=null,
               stop_requested_at=coalesce(stop_requested_at,$2::timestamptz)
             where id=$1`,
            [row.id, current.stop_at],
          );
          await enqueueBoatStop(tx, row.id, row.lifecycle_generation);
        });
        return true;
      };
      if (
        jobOwnsStop &&
        row.provider_sandbox_id &&
        row.status !== "starting" &&
        (expired || row.stop_requested_at !== null || row.status === "stopping")
      )
        return handoffBoatStop(expired);
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
               from public.sandboxes s where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
                 and reconcile_lease_until>clock_timestamp()
                 and (activity_until is null or activity_until<now()) for update`,
                [row.id, token, row.lifecycle_generation],
              )
            ).rows[0];
            if (!current) return true;

            const { status } = current;
            const interrupted = status === "starting";
            const failed = interrupted || physicalExit;
            const toState = failed ? "failed" : terminal && status !== "failed" ? "stopped" : status;
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
              : interrupted
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
                 status_reason=$2,stop_requested_at=$3,stopped_at=$4,
                 transition_context=null
               where id=$1`,
                [row.id, statusReason, stopRequestedAt, exitTime],
              );
            }
            const saved = await tx.query(
              `update public.sandboxes set
               last_observed_at=case when $2::text is null then now() else last_observed_at end,
               activity_lease_id=null,
               activity_until=null,
               lifecycle_error=$2,
               reconcile_after=now()+interval '1 minute',
               reconcile_lease=case when $3 then reconcile_lease else null end,
               reconcile_lease_until=case when $3 then reconcile_lease_until else null end
             where id=$1 and reconcile_lease=$4::uuid and lifecycle_generation=$5
               and reconcile_lease_until>clock_timestamp()
             returning id`,
              [row.id, error, signal?.aborted ?? false, token, row.lifecycle_generation],
            );
            if (!saved.rows.length) throw lostLease;
            if (terminal) await detachBoatExtension(tx, row.id, row.lifecycle_generation);
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
        const observe = async () => {
          observing = true;
          const info = await operation(signal, () => provider.get(row.provider_sandbox_id));
          observing = false;
          return info;
        };
        const info = await observe();
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
        } catch {}
        physicalExit = info.physicalExitConfirmed === true;
        const physicalDeadline = info.expiresAt?.getTime() ?? Number.NaN;
        const observedBoatDeadline =
          row.boat_runtime &&
          !expired &&
          row.stop_requested_at === null &&
          (row.status === "ready" || row.status === "running") &&
          provider.id === providerId &&
          info.id === row.provider_sandbox_id &&
          (info.state === "ready" || info.state === "running") &&
          !physicalExit &&
          Number.isFinite(physicalDeadline) &&
          Number.isFinite(logicalDeadline);
        if (observedBoatDeadline) {
          signal?.throwIfAborted();
          const saved = await sql.query(
            `with locked as materialized (
               select s.* from public.sandboxes s where s.id=$1 for update
             )
             insert into public.boat_runtime_extension_state as extension
               (sandbox_id,observed_provider_id,observed_generation,observed_at,observed_expires_at)
             select s.id,s.provider_sandbox_id,s.lifecycle_generation,to_timestamp($6::float8),to_timestamp($7::float8)
             from locked s
             where s.provider='boat' and s.boat_runtime and s.provider_sandbox_id=$2 and s.lifecycle_generation=$3
               and s.reconcile_lease=$4 and s.reconcile_lease_until>clock_timestamp()
               and (s.activity_until is null or s.activity_until<=clock_timestamp())
               and s.status in ('ready','running') and s.stop_requested_at is null and s.deleted_at is null
               and extract(epoch from s.expires_at)=$5::numeric and s.expires_at>clock_timestamp()
               and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
             on conflict (sandbox_id) do update set
               observed_provider_id=excluded.observed_provider_id, observed_generation=excluded.observed_generation,
               observed_at=excluded.observed_at, observed_expires_at=excluded.observed_expires_at,
               pending_job_id=case
                 when $7::numeric >= $5::numeric + $8::integer and exists (
                   select 1 from public.jobs j
                   where j.id=extension.pending_job_id and j.sandbox_id=excluded.sandbox_id
                     and j.generation=excluded.observed_generation and j.kind='boat_runtime_extend'
                     and j.state in ('done','failed')
                 ) then null
                 else extension.pending_job_id
               end
             returning sandbox_id`,
            [
              row.id,
              row.provider_sandbox_id,
              row.lifecycle_generation,
              token,
              row.expiry_epoch,
              now() / 1000,
              physicalDeadline / 1000,
              SANDBOX_STOP_MARGIN_SECONDS,
            ],
          );
          if (!saved.rows.length) return true;
        }
        const shortBoatDeadline =
          observedBoatDeadline && physicalDeadline < logicalDeadline + SANDBOX_STOP_MARGIN_SECONDS * 1000;
        if (jobOwnsStop && shortBoatDeadline) return handoffBoatStop(true);
        if (
          jobOwnsStop &&
          info.state === "stopped" &&
          info.retainedSnapshot !== "usable" &&
          !physicalExit &&
          row.status !== "failed" &&
          row.status !== "starting"
        )
          return handoffBoatStop(false);
        if (jobOwnsStop && row.status === "starting" && !physicalExit && !["stopped", "deleted"].includes(info.state)) {
          if (info.id !== row.provider_sandbox_id) throw Error("Interrupted launch identity changed.");
          return handoffBoatStop(expired);
        }
        if (
          !jobOwnsStop &&
          !physicalExit &&
          !["stopped", "deleted"].includes(info.state) &&
          (row.stop_requested_at !== null || row.status === "stopping" || row.status === "starting" || expired)
        ) {
          signal?.throwIfAborted();
          if (!sql.transaction) throw new Error("Reconciler stop admission requires a transaction.");
          const stopConflict = new Error("Reconciler stop transition lost ownership.");
          await sql
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
                    else status_reason end
                where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
                  and status in ('starting','ready','running','stopping','failed')
                  and reconcile_lease_until>clock_timestamp() and (activity_until is null or activity_until<now())
                  and (provider<>'modal' or not $4 or expires_at<=clock_timestamp())
                  and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)
                returning status, stopped_at::text, coalesce(stop_requested_at,clock_timestamp())::text as stop_requested_at,
                  case when $4 and status_reason is distinct from 'work_merged' then 'expired'
                    else 'stop_requested' end as code,
                  case when $4 and status_reason is distinct from 'work_merged' then 'expired'
                    else status_reason end as status_reason`,
                [row.id, token, row.lifecycle_generation, expired],
              );
              if (!current) return;
              if (current.status === "ready" || current.status === "running" || current.status === "starting") {
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
              }
              if (!(await enqueueModalStop(tx, row.id, row.lifecycle_generation, token))) throw stopConflict;
            })
            .catch((failure: unknown) => {
              if (failure === stopConflict) return;
              throw failure;
            });
          return true;
        }
        signal?.throwIfAborted();
        physicalExit = info.physicalExitConfirmed === true || info.stopNote === "checkpoint_failed_disk_not_retained";
        stoppedAt = info.stoppedAt;
        terminal = physicalExit || ["stopped", "deleted"].includes(info.state);
        if (!terminal && (expired || shortBoatDeadline || row.status === "stopping" || row.stop_requested_at !== null))
          error = "Provider stop is not yet confirmed. Retrying without deleting retained data.";
      } catch (caught) {
        const authorityLost =
          (caught instanceof VaultError &&
            ["missing_credential", "forbidden", "not_found", "credential_refused"].includes(caught.code)) ||
          (caught instanceof ProviderError && ["unauthorized", "forbidden"].includes(caught.code));
        if (authorityLost && operatorStop && !signal?.aborted) {
          await deferToOperator("original provider authority unavailable.");
          return true;
        }
        if (
          resolved &&
          (!row.checkpointed_stop || expired) &&
          (!requireMissingObservation || observing) &&
          caught instanceof ProviderError &&
          caught.code === "not_found"
        ) {
          terminal = true;
          if (requireMissingObservation) physicalExit = true;
        } else {
          if (row.status === "stopping") {
            const phase = observing ? "observe" : resolved ? "prepare" : "resolve_provider";
            recordOperatorFailure(`sandbox.lifecycle.${providerId}.${phase}`, caught, { sandboxId: row.id });
          }
          error = "Provider lifecycle observation unavailable. Retrying without deleting retained data.";
        }
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

export async function recordSandboxSkills(
  sql: Sql,
  id: string,
  ownerId: string,
  skills: Parameters<NonNullable<SandboxStore["recordSkills"]>>[1],
) {
  const result = await sql.query(
    "update public.sandboxes s set skills=$3::text::jsonb where s.id=$1::uuid and s.owner_id=$2::uuid returning id",
    [id, ownerId, JSON.stringify(skills)],
  );
  if (result.rows.length !== 1) throw new DataError("Skill receipts could not be recorded.");
}

export function mergeSandboxUsage(
  sql: Sql,
  scope: [string[], string],
  id: string,
  usage: Pick<SandboxUsage, "turnCount" | "turns">,
  unpriced: boolean,
) {
  return sql.query<{ usage: Pick<SandboxUsage, "turnCount" | "turns"> }>(
    `update public.sandboxes s set usage_turns=(
            with snapshots as (
              select value, ordinality as ordinal
              from jsonb_array_elements(coalesce(s.usage_turns->'turns','[]'::jsonb) ||
                coalesce(($4::text::jsonb)->'turns','[]'::jsonb)) with ordinality
            ), lifetime_snapshots as (
              select *,
                bool_or(value ? 'cacheWriteTokensByTtl') over identity as has_ttl,
                bool_or(value#>'{cacheWriteTokensByTtl,conflicted}'='true'::jsonb) over identity as ttl_conflicted,
                max((value#>>'{cacheWriteTokensByTtl,fiveMinute}')::bigint) over identity as ttl_five,
                max((value#>>'{cacheWriteTokensByTtl,oneHour}')::bigint) over identity as ttl_hour,
                max((value->>'cacheWriteTokens')::bigint) over identity as ttl_total
              from snapshots
              window identity as (partition by value->>'promptId', value->>'model')
            ), merged as (
              select distinct on (value->>'promptId', value->>'model')
                value || jsonb_strip_nulls(jsonb_build_object(
                  'unavailableReason', first_value(value->'unavailableReason') over diagnostic,
                  'inputTokens', max((value->>'inputTokens')::bigint) over identity,
                  'outputTokens', max((value->>'outputTokens')::bigint) over identity,
                  'cachedTokens', max((value->>'cachedTokens')::bigint) over identity,
                  'cacheWriteTokens', max((value->>'cacheWriteTokens')::bigint) over identity,
                  'reasoningTokens', max((value->>'reasoningTokens')::bigint) over identity)) ||
                  -- Keep monotone lifetime subsets across stale writers, without inventing a
                  -- coherent breakdown when conflicting snapshots exceed the aggregate.
                  -- A conflict is sticky: ordinary replays carry no authoritative reset/order proof.
                  case when has_ttl then jsonb_build_object('cacheWriteTokensByTtl',
                    case when ttl_conflicted or
                        (ttl_total is not null and coalesce(ttl_five,0)+coalesce(ttl_hour,0)>ttl_total)
                      then jsonb_build_object('fiveMinute',null,'oneHour',null,'conflicted',true)
                      else jsonb_build_object('fiveMinute',ttl_five,'oneHour',ttl_hour) end)
                    else '{}'::jsonb end as value
              from lifetime_snapshots
              window identity as (partition by value->>'promptId', value->>'model'),
                diagnostic as (partition by value->>'promptId', value->>'model' order by
                  case when jsonb_typeof(value->'unavailableReason')='object' then
                    case when value#>>'{unavailableReason,code}' in ('compute_inactive','reader_unavailable') then 1 else 0 end
                    else 2 end, ordinal desc)
              order by value->>'promptId', value->>'model', ordinal desc
            ), retained as (
              select case when m.value->>'inputTokens' is not null or m.value->>'outputTokens' is not null
                or m.value->>'cachedTokens' is not null or m.value->>'cacheWriteTokens' is not null
                or m.value->>'reasoningTokens' is not null then value - 'unavailableReason' else value end as value
              from merged m where m.value->>'model' is not null
                or m.value->>'inputTokens' is not null or m.value->>'outputTokens' is not null
                or m.value->>'cachedTokens' is not null or m.value->>'cacheWriteTokens' is not null
                or m.value->>'reasoningTokens' is not null
                or not exists (select 1 from merged known
                  where known.value->>'promptId'=m.value->>'promptId' and known.value->>'model' is not null
                    and (known.value->>'inputTokens' is not null or known.value->>'outputTokens' is not null
                      or known.value->>'cachedTokens' is not null or known.value->>'cacheWriteTokens' is not null
                      or known.value->>'reasoningTokens' is not null))
            )
            select jsonb_build_object(
              'turnCount', greatest((s.usage_turns->>'turnCount')::int,
                (($4::text::jsonb)->>'turnCount')::int,
                (select nullif(count(distinct prompt_id),0)::int from (
                  select prompt_id from public.sandbox_turn_models where sandbox_id=s.id
                  union select value->>'promptId' from retained
                ) admitted_prompts)),
              'turns', coalesce((select jsonb_agg(value order by value->>'promptId', value->>'model') from retained),'[]'::jsonb))
          )
          where ${SANDBOX_VISIBLE} and s.id=$3::uuid
            -- Managed parents use their durable journal as the sole usage writer.
            and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
            ${
              unpriced
                ? `and not exists(select 1 from jsonb_array_elements(coalesce(s.usage_turns->'turns','[]'::jsonb)) r
              where jsonb_typeof(r->'pricing')='object')`
                : ""
            }
            returning s.usage_turns as usage`,
    [
      ...scope,
      id,
      JSON.stringify({
        ...usage,
        turns: usage.turns.map(({ pricing: _ignored, ...native }) => ({
          ...native,
          ...(unpriced ? { pricing: null } : {}),
        })),
      }),
    ],
  );
}

export async function saveSandboxUsage(
  tx: Sql,
  scope: [string[], string],
  id: string,
  priced: Pick<SandboxUsage, "turnCount" | "turns">,
) {
  const saved = await tx.query<{ id: string }>(
    `update public.sandboxes s set usage_turns=$4::text::jsonb
     where ${SANDBOX_VISIBLE} and s.id=$3::uuid returning s.id`,
    [...scope, id, JSON.stringify(priced)],
  );
  if (saved.rows.length !== 1) throw new DataError("Usage admission changed during recording.");
}

export async function applyScopedSandboxPatch(
  sql: Sql,
  scope: [string[], string],
  id: string,
  patch: ServerSandboxPatch,
  stopStatus: "stopping" | "failed" | undefined,
  reason: ReturnType<typeof statusReasonOf>,
) {
  const sets: string[] = [];
  const params: unknown[] = [...scope, id];
  const set = (column: string, value: unknown, cast: string) => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if ((patch.advanceGeneration || patch.turnActivity === "claim") && patch.activityToken) {
    set("activity_lease_id", patch.activityToken, "::uuid");
    sets.push("activity_until = now() + interval '2 minutes'");
  }
  if (patch.rearmDeadline) sets.push("expires_at = now() + s.effective_ttl_seconds * interval '1 second'");
  if (patch.stopRequested !== undefined) {
    sets.push(
      patch.stopRequested
        ? "stop_requested_at = coalesce(s.stop_requested_at, clock_timestamp())"
        : "stop_requested_at = null",
    );
    if (patch.stopRequested)
      sets.push(
        "reconcile_after = now()",
        "stop_generation = case when s.stop_requested_at is null then s.stop_generation + 1 else s.stop_generation end",
      );
  }
  if (patch.renewActivity) sets.push("activity_until = now() + interval '2 minutes'");
  if (
    (patch.finishActivity || patch.turnActivity === "finish") &&
    patch.expectedGeneration !== undefined &&
    patch.activityToken
  ) {
    sets.push("activity_lease_id = null", "activity_until = null");
    if (patch.finishActivity) sets.push("lifecycle_generation = s.lifecycle_generation + 1");
  }
  if (patch.advanceGeneration && !patch.renewLifecycle) sets.push("lifecycle_generation = s.lifecycle_generation + 1");
  if (patch.renewLifecycle) {
    sets.push(
      "lifecycle_generation = s.lifecycle_generation + 1",
      "expires_at = now() + s.effective_ttl_seconds * interval '1 second'",
      "reconcile_after = now()",
      "lifecycle_error = null",
    );
  }
  if (patch.clearTaskOutcome) sets.push("task_outcome = null", "task_prompt_id = null");
  if (patch.taskPromptId !== undefined) set("task_prompt_id", patch.taskPromptId, "::text");
  if (patch.conversationIds !== undefined) set("conversation_ids", patch.conversationIds, "::text[]");
  if (patch.stoppedAt !== undefined) set("stopped_at", patch.stoppedAt, "::timestamptz");
  if (patch.expiresAt !== undefined) set("expires_at", patch.expiresAt, "::timestamptz");
  const extensionDeadlineParam = patch.expiresAt === undefined ? undefined : params.length;
  if (patch.effectiveTtlSeconds !== undefined) set("effective_ttl_seconds", patch.effectiveTtlSeconds, "::integer");
  const stopAdmissionReason = stopStatus === "stopping" ? reason : undefined;
  if (reason !== undefined && stopAdmissionReason === undefined) set("status_reason", reason, "::text");
  if (sets.length === 0) return;
  const admission = !!patch.advanceGeneration && !!patch.activityToken;
  let fence = patch.renewActivity ? " and s.id=renewal_target.id" : "";
  if (patch.activityToken && (patch.advanceGeneration || patch.turnActivity === "claim"))
    fence += ` and not (s.provider='boat' and exists(select 1 from public.jobs j
      where j.sandbox_id=s.id and j.generation=s.lifecycle_generation and j.kind='stop'
        and j.state in ('queued','leased')))`;
  if (patch.turnActivity !== undefined)
    fence += " and s.status in ('ready','running') and s.stop_requested_at is null and s.deleted_at is null";
  if (patch.turnActivity === "claim") fence += " and s.activity_lease_id is null";
  if (patch.modalRuntimeExtensionTarget !== undefined) {
    if (extensionDeadlineParam === undefined || patch.expectedGeneration === undefined)
      throw new DataError("Modal runtime extension requires a verified deadline and lifecycle generation.");
    params.push(patch.modalRuntimeExtensionTarget);
    fence += ` and s.provider='modal' and s.runtime_transport='dialout'
      and s.provider_sandbox_id=$${params.length}::text and s.status in ('ready','running')
      and s.stop_requested_at is null and s.deleted_at is null
      and s.expires_at>clock_timestamp() and s.expires_at<$${extensionDeadlineParam}::timestamptz
      and exists(select 1 from public.runtime_enrolments r where r.sandbox_id=s.id
        and r.lifecycle_generation=s.lifecycle_generation and r.runtime_hash is not null
        and r.epoch=r.command_grant_epoch and r.command_grant_expires_at>=$${extensionDeadlineParam}::timestamptz)`;
  }
  if (patch.advanceGeneration && patch.activityToken && patch.stopRequested === undefined && !patch.deleteRequested)
    fence += " and s.stop_requested_at is null";
  if (patch.advanceGeneration && patch.activityToken && patch.stopRequested === false)
    fence +=
      " and (coalesce(s.status_reason,'') not in ('idle_paused','work_merged') or (s.status<>'stopping' and s.expires_at>clock_timestamp()))";
  if (patch.queueRequestId !== undefined) {
    params.push(patch.queueRequestId);
    fence += ` and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=s.id and q.request_id=$${params.length}::uuid and q.state<>'dispatching')`;
  }
  let generationParam: number | undefined;
  if (patch.expectedGeneration !== undefined) {
    params.push(patch.expectedGeneration);
    generationParam = params.length;
    fence += ` and s.lifecycle_generation = $${params.length}`;
  }
  let retainedProof: string | undefined;
  if (patch.retainedRuntimeStop !== undefined) {
    params.push(patch.retainedRuntimeStop);
    retainedProof = `exists(select 1 from public.runtime_checkpoints p join public.runtime_enrolments r
      on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch
      where p.sandbox_id=s.id and p.request_id=$${params.length}::uuid
      and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id))`;
    fence += ` and s.status in ('ready','running') and s.stop_requested_at is null
      and s.expires_at>clock_timestamp() and not s.application_secret_tainted and ${retainedProof}`;
  }
  if (patch.deleteRequested) {
    params.push(MODAL_LAUNCH_FAILURE);
    fence += ` and s.status in ('stopped','failed')
      and not (s.status='failed' and (s.provider='modal' or s.boat_runtime) and s.status_reason is not distinct from $${params.length}::text
        and s.stopped_at is null)
      and not (s.provider='boat' and s.stopped_at is null and s.stop_requested_at is not null)
      and not ${unresolvedModalStop("s")}
      and not ${SANDBOX_DELETION_MANAGED}`;
  }
  // WARNING: Only an admitted generation CAS may supersede an observation lease.
  const supersedeObservation = patch.advanceGeneration && patch.activityToken && patch.expectedGeneration !== undefined;
  const observationFence = supersedeObservation
    ? "(s.reconcile_lease_until is null or s.reconcile_lease_until < now() or (s.status in ('ready','running') and s.stop_requested_at is null and s.expires_at > clock_timestamp()))"
    : "(s.reconcile_lease_until is null or s.reconcile_lease_until < now())";
  if (supersedeObservation) sets.push("reconcile_lease = null", "reconcile_lease_until = null");
  const ownsActivity =
    !!patch.activityToken && (patch.finishActivity || patch.renewActivity || patch.turnActivity === "finish");
  if (ownsActivity) {
    params.push(patch.activityToken);
    fence += ` and s.activity_lease_id = $${params.length}::uuid`;
  }
  // WARNING: Transfer capacity in the sandbox update statement to avoid an uncounted admission window.
  const releaseReservation =
    patch.taskPromptId !== undefined || (patch.stoppedAt !== undefined && patch.stoppedAt !== null);
  const idleAdmission = patch.onlyIfIdle === true && patch.stopRequested === true && patch.advanceGeneration;
  if (idleAdmission)
    fence += ` and (s.status='ready' or (s.status='running' and
      ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))))
      and s.stop_requested_at is null
      and not exists(select 1 from public.account_turn_queue q
        where q.sandbox_id=s.id and q.state in ('queued','dispatching'))
      and not exists(${unsettledRuntimeCommands("s.id", "s.lifecycle_generation")})`;
  if (stopStatus !== undefined) {
    fence += patch.queueModalStop
      ? " and s.provider='modal' and s.runtime_transport='dialout' and s.deleted_at is null"
      : " and s.provider='boat' and s.deleted_at is null";
    fence += ` and not ${unresolvedModalLaunch("s")}`;
    fence +=
      stopStatus === "failed"
        ? " and s.status='failed' and s.stop_requested_at is null"
        : " and s.status in ('starting','ready','running') and s.stop_requested_at is null";
  }
  const cancelTurns = patch.stopRequested === true && !idleAdmission;
  const wrapped = releaseReservation || cancelTurns;
  // WARNING: Read refusal evidence in the CAS snapshot because a later read can miss a concurrent lease release.
  const observeRefusal = !!patch.deleteRequested && admission && !wrapped;
  const publishTransition = stopStatus !== undefined;
  const returning = publishTransition ? "id, status, generation" : "id";
  const update = `update public.sandboxes s set ${sets.join(", ")} from public.goldens g${patch.renewActivity ? ", renewal_target" : ""}
     where s.id = $3 and g.id = s.golden_id and ${SANDBOX_VISIBLE}
       and (${ownsActivity && patch.expectedGeneration !== undefined ? "true" : `${observationFence} and (s.activity_until is null or s.activity_until < now())`}) ${fence} returning ${publishTransition ? "s.id, s.status, s.lifecycle_generation::text as generation" : "s.id"}`;
  const effects = `${cancelTurns ? `, ${REFUSE_STOPPED_SANDBOX_TURNS}` : ""}${releaseReservation ? `, ${RELEASE_UPDATED_SANDBOX_RESERVATIONS}` : ""}`;
  const applyUpdate = (connection: Sql) =>
    connection.query<{
      id: string | null;
      status?: SandboxStatus;
      generation?: string;
      observed?: (Record<string, unknown> & { activityLeaseHeld: boolean; reconcileLeaseHeld: boolean }) | null;
      stop_evidence?: StopRefusalEvidence | null;
    }>(
      patch.renewActivity
        ? `with renewal_target as materialized (
             select s.id from public.sandboxes s
             where s.id=$3::uuid and ${SANDBOX_VISIBLE} for update of s
           ) ${update}`
        : observeRefusal
          ? `with observed as (select s.status::text as status,
            s.activity_lease_id as "activityLeaseId",
            coalesce(s.activity_until>=now(),false) as "activityLeaseHeld",
            coalesce(s.reconcile_lease_until>=now(),false) as "reconcileLeaseHeld",
            s.stop_requested_at is not null as "stopRequested",
            ${generationParam ? `s.lifecycle_generation<>$${generationParam}::bigint` : "false"} as "generationChanged",
            ${SANDBOX_DELETION_MANAGED} as managed
          from public.sandboxes s where s.id=$3::uuid and ${SANDBOX_VISIBLE}),
        updated as (${update})
        select (select id from updated) as id, (select row_to_json(o) from observed o) as observed`
          : stopStatus !== undefined
            ? `with updated as (${update})${effects}
             select u.id,u.status,u.generation,
               case when u.id is null then (select row_to_json(e) from
                 (select ${stopRefusalEvidence}, $${generationParam}::bigint::text as "requestGeneration",
                   ${retainedProof ?? "null"} as "retainedCheckpointCurrent"
                   from public.sandboxes s
                   where s.id=$3::uuid and ${SANDBOX_VISIBLE}) e) end as stop_evidence
             from (values (1)) seed left join updated u on true`
            : wrapped
              ? `with updated as (${update})${effects} select ${returning} from updated`
              : update,
      params,
    );
  let result: Awaited<ReturnType<typeof applyUpdate>> & { observationBlocked?: boolean };
  if (
    stopStatus !== undefined ||
    patch.modalRuntimeExtensionTarget !== undefined ||
    (patch.deleteRequested && admission)
  ) {
    if (!sql.transaction) throw new Error("Fenced sandbox admission requires a transaction.");
    result = await sql.transaction(async (tx) => {
      // WARNING: The queue check needs a fresh statement snapshot after acquiring the sandbox lock.
      const locked = await tx.query<{ observation_blocked: boolean }>(
        `select not (${observationFence}) as observation_blocked
         from public.sandboxes s where s.id=$3::uuid and ${SANDBOX_VISIBLE} for update`,
        [...scope, id],
      );
      if (!locked.rows.length) return { rows: [] };
      patch.ownerStopSignal?.throwIfAborted();
      const updated = await applyUpdate(tx);
      if (!updated.rows[0]?.id && !ownsActivity && !patch.retainedRuntimeStop && locked.rows[0]?.observation_blocked)
        return { ...updated, observationBlocked: true };
      const row = updated.rows[0];
      if (stopStatus !== undefined && row?.id) {
        if (!row.status || !row.generation) throw new Error("Owner stop update did not return its fence.");
        await publishOwnerStop(tx, {
          sandboxId: id,
          generation: row.generation,
          fromState: row.status,
          toState: stopStatus,
          ...(stopAdmissionReason !== undefined ? { statusReason: stopAdmissionReason } : {}),
          code: patch.retainedRuntimeStop ? "runtime_retained_stop" : "owner_stop_admitted",
        });
        if (
          patch.queueModalStop &&
          (!patch.activityToken ||
            !(await enqueueModalStop(
              tx,
              id,
              row.generation,
              patch.activityToken,
              typeof patch.queueModalStop === "string" ? patch.queueModalStop : undefined,
            )))
        )
          throw new Error("Modal stop admission lost the exact target.");
        if (!patch.queueModalStop) await enqueueBoatStop(tx, id, row.generation, patch.activityToken);
      }
      return updated;
    });
  } else if (
    patch.taskPromptId &&
    patch.expectedGeneration !== undefined &&
    patch.turnActivity === "finish" &&
    sql.transaction
  ) {
    const generation = patch.expectedGeneration + (patch.finishActivity ? 1 : 0);
    result = await sql.transaction(async (tx) => {
      const published = await applyUpdate(tx);
      if (published.rows[0]?.id) await settleRuntimeTurn(tx, id, generation);
      return published;
    });
  } else {
    result = await applyUpdate(sql);
  }
  return { result, admission, observeRefusal };
}

export async function reportSandboxTaskOutcome(
  sql: Sql,
  scope: [string[], string],
  id: string,
  promptId: string,
  outcome: TaskOutcome,
  expectedGeneration?: number,
) {
  const result = await sql.query(
    `update public.sandboxes s set task_outcome=$5::text::jsonb,
       pull_request_reports=(s.pull_request_reports - (s.lifecycle_generation::text || ':' || $4::text)) ||
         case when $5::text::jsonb->>'state'='ready' and ($5::text::jsonb ? 'prNumber' or $5::text::jsonb ? 'prUrl')
           then jsonb_build_object(s.lifecycle_generation::text || ':' || $4::text, $5::text::jsonb)
           else '{}'::jsonb end,
       pull_request_merge_proof=null
     where ${SANDBOX_VISIBLE} and s.id=$3::uuid and s.task_prompt_id=$4::text
     and ($6::bigint is null or s.lifecycle_generation=$6::bigint)
     and (s.activity_until is null or s.activity_until < now())
     and s.status not in ('starting','deleted')
     and (s.status<>'running' or (s.provider='docker' and s.stop_requested_at is null
       and exists(select 1 from public.runtime_idle_turns where sandbox_id=s.id and prompt_id=$4 and settled)))
     returning s.id`,
    [...scope, id, promptId, JSON.stringify(outcome), expectedGeneration ?? null],
  );
  if (!result.rows.length) throw new DataError("The turn changed or this sandbox is not reportable.");
}

type Report = { prNumber?: number; prUrl?: string };
export type PullRequestIdentity = { repository: string; number: number };
type PullRequestScan = {
  pushes: Record<string, [string, string[]][]>;
  discovered: PullRequestIdentity[];
  untracked?: true;
  heads?: Record<string, Record<string, Record<string, string>>>;
};
export type PullRequestScanTarget = {
  id: string;
  owner_id: string;
  provider: "boat" | "modal" | "docker";
  provider_sandbox_id: string;
  harness: "codex" | "claude" | "opencode";
  runtime_epoch: string | null;
  active: boolean;
  launch_authorized: boolean;
  settled: boolean;
  created_at: string;
  lifecycle_generation: string;
  task_prompt_id: string | null;
  connection_epoch: string;
  github_id: string;
  membership_epoch: string;
  repositories: unknown;
  repository_dir: string | null;
  pull_request_scan: PullRequestScan | null;
  pull_request_reports: Record<string, Report>;
};

export const PULL_REQUEST_SCAN_ELIGIBLE = `from public.sandboxes s
          join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
          join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
          join public.github_connections c on c.user_id=s.owner_id and c.revoked_at is null
          join lateral (
            select repositories,priority from (
              select s.pull_request_source->'repositories' as repositories, 3 as priority, 0::bigint as revision
              where s.pull_request_source->>'connectionEpoch'=c.connection_epoch::text
              union all
              select binding->'repositories', 2, revision
              from public.runtime_github_capabilities
              where sandbox_id=s.id and delivered_at is not null
                and binding->>'connectionEpoch'=c.connection_epoch::text
                and binding->>'membershipEpoch'=e.epoch::text
              union all
              select binding->'identity'->'repositories', 1, revision from public.github_runtime_capabilities
              where sandbox_id=s.id and binding->'identity'->>'connectionEpoch'=c.connection_epoch::text
                and binding->'identity'->>'membershipEpoch'=e.epoch::text
              union all
              select jsonb_build_array(s.resource_project), 0, 0::bigint
              where s.provider<>'docker' and s.pull_request_source is null and s.resource_project is not null
            ) grants order by priority desc, revision desc limit 1
          ) grant_row on true
          where ((s.status in ('ready','running') and s.stop_requested_at is null)
              or (s.status='stopped' and (s.pull_request_scan is not null or s.pull_request_reports<>'{}'::jsonb)))
            and s.activity_lease_id is null and not s.application_secret_tainted
            and s.expires_at>now()`;

export function clearPullRequestMergeProof(sql: Sql, id: string | null, generation: string | null) {
  return sql.query<PullRequestScanTarget>(
    `with target as (
          select s.id,c.connection_epoch,c.github_id,e.epoch as membership_epoch,
            grant_row.repositories,grant_row.priority>0 as launch_authorized
          ${PULL_REQUEST_SCAN_ELIGIBLE} and s.id=$1 and s.lifecycle_generation=$2
        )
        update public.sandboxes s set pull_request_merge_proof=null from target where s.id=target.id
        returning s.id,s.owner_id,s.provider::text,s.provider_sandbox_id,s.harness::text,
          s.status in ('ready','running') as active,
          (select r.epoch::text from public.runtime_enrolments r
            where r.sandbox_id=s.id and r.lifecycle_generation=s.lifecycle_generation and r.runtime_hash is not null)
            as runtime_epoch,
          s.created_at::text,s.lifecycle_generation::text,s.task_prompt_id,
          (s.task_prompt_id is not null
            and exists(select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id and t.prompt_id=s.task_prompt_id and t.settled)
            and not exists(select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id and not t.settled)) as settled,
          target.connection_epoch::text,target.github_id::text,target.membership_epoch::text,
          target.repositories,target.launch_authorized,s.repository_dir,s.pull_request_scan,s.pull_request_reports`,
    [id, generation],
  );
}

export function markPullRequestScanUntracked(sql: Sql, id: string) {
  return sql.query(
    `update public.sandboxes set pull_request_merge_proof=null,
              pull_request_scan=jsonb_set(coalesce(pull_request_scan,'{"pushes":{},"discovered":[]}'::jsonb),'{untracked}','true'::jsonb)
             where id=$1 returning id`,
    [id],
  );
}

export function retainPullRequestScan(sql: Sql, id: string, scan: string, generation: string) {
  return sql.query(
    `update public.sandboxes set pull_request_scan=$2::text::jsonb
         where id=$1 and lifecycle_generation=$3 and (status='stopped' or stop_requested_at is null)
           and activity_lease_id is null returning id`,
    [id, scan, generation],
  );
}

export function commitPullRequestScan(sql: Sql, row: PullRequestScanTarget, list: string, proof: string, scan: string) {
  return sql.query<{ stopped: boolean }>(
    `update public.sandboxes s set pull_requests=$2::text::jsonb,pull_request_merge_proof=$3::text::jsonb,
          pull_request_scan=$9::text::jsonb
          where s.id=$1 and s.lifecycle_generation=$4 and s.task_prompt_id is not distinct from $5
            and s.pull_request_reports=$6::text::jsonb and s.activity_lease_id is null
            and (s.status='stopped' or (s.status in ('ready','running') and s.stop_requested_at is null))
            and exists(select 1 from public.github_connections c where c.user_id=s.owner_id
              and c.revoked_at is null and c.connection_epoch=$7)
            and exists(select 1 from public.mcp_actor_epochs e join public.members m
              on m.org_id=e.org_id and m.user_id=e.user_id
              where e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=$8)
          returning s.status='stopped' as stopped`,
    [
      row.id,
      list,
      proof,
      row.lifecycle_generation,
      row.task_prompt_id,
      JSON.stringify(row.pull_request_reports),
      row.connection_epoch,
      row.membership_epoch,
      scan,
    ],
  );
}

export function changeStoppedSandboxCredential(sql: Sql, id: string, credentialId: string, credentialVersion: number) {
  return sql.query(
    "update public.sandboxes set credential_id=$2,credential_version=$3,lifecycle_generation=lifecycle_generation+1 where id=$1",
    [id, credentialId, credentialVersion],
  );
}

export const RESOURCE_SAMPLING_VISIBLE = `not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id) and s.org_id=any($1::uuid[]) and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid)
  and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and (s.owner_id=$2::uuid or m.role='admin'))`;

export function claimSandboxResourceSample(
  sql: Sql,
  orgIds: string[],
  userId: string,
  id: string,
  token: string,
  at: string,
) {
  return sql.query<{ token: string }>(
    `update public.sandboxes s set resource_sampling_claim_id=$4::uuid,
           resource_sampling_after=$5::timestamptz+interval '10 seconds',resource_sampling_generation=s.lifecycle_generation
         where ${RESOURCE_SAMPLING_VISIBLE} and s.id=$3::uuid and s.status in ('ready','running')
           and s.resource_project is not null and s.resource_project<>'null'::jsonb and s.machine_size->'capacity' is not null
           and s.machine_size->'capacity'<>'null'::jsonb
           and (s.resource_sampling_after is null or s.resource_sampling_after <= $5::timestamptz)
           and (s.activity_until is null or s.activity_until <= $5::timestamptz)
           and (s.reconcile_lease_until is null or s.reconcile_lease_until <= $5::timestamptz)
         returning s.resource_sampling_claim_id::text as token`,
    [orgIds, userId, id, token, at],
  );
}
