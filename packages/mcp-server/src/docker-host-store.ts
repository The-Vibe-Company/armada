import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  DOCKER_JOB_FAILURE_REASONS,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  DOCKER_SNAPSHOT_FAILURE_MESSAGES,
  type DockerHostSummary,
  type DockerJobFailureReason,
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_READ_BYTES,
  ProviderError,
  type SandboxStatus,
  type Sql,
} from "@armada/core";
import {
  type DockerHostUpdatePolicy,
  type DockerHostUpdateResult,
  isDockerHostUpdateResult,
  type parseDockerHostUpdateReport,
} from "@armada/core/contract";
import {
  decryptSecret,
  encryptSecret,
  isSnapshotBaselineTool,
  type Machine,
  type MachineIdentity,
  type MachineIncarnation,
  type MachineObservation,
  readOutputArchive,
  type SnapshotBaselineTool,
  VaultError,
} from "@armada/core/server";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  dockerMachineJobId,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";
import type { DockerHostResources } from "../../core/src/docker-resources.ts";
import { type DockerResourceOverrides, dockerResourcePolicy } from "../../core/src/docker-resources.ts";
import {
  admitDockerCapacity,
  DOCKER_CAPACITY_USAGE_SQL,
  DockerHostDraining,
  DockerHostFull,
  DockerLimitsRefused,
  type DockerPolicyRow,
  hostResourcePolicy,
} from "./docker-capacity.ts";
import { hostDrainingSql } from "./docker-host-drain.ts";
import { dockerHostVersionStatus, supportsDockerHostProtocol } from "./docker-host-version.ts";
import {
  createDockerMachineAdapter,
  type DockerMachineMailbox,
  DockerMachinePending,
} from "./docker-machine-adapter.ts";
import { createDockerMachineGenerationBindings, projectDockerMachineInventory } from "./docker-machine-bindings.ts";
import { type DockerInventoryContainer, dockerInventoryDeploymentId } from "./docker-machine-inventory.ts";
import { authorizeSnapshotBuild, resolveDockerSnapshot } from "./docker-snapshot-data.ts";
import { resumeDispatchAuthority } from "./jobs/resume-authority.ts";
import type { Job as RunnerJob } from "./jobs/runner.ts";
import type { DockerStopIntent } from "./jobs/stop.ts";
import {
  createJobsStore,
  dockerStopPending,
  jobRequestKey,
  recordDockerRestoreEvidence,
  wakeSandboxJobs,
} from "./jobs/store.ts";
import { recordLaunchStageForActivation } from "./launch-stage-record.ts";
import { collectOutputTransfers, DOCKER_RETAINED_OUTPUT_STOP, recordDockerOutputUpload } from "./output-transfers.ts";
import { noteAdmission } from "./request-observability.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import { currentDockerRuntimeIssuer, unsettledRuntimeCommands } from "./runtime-idle-evidence.ts";
import { requireGenerationHeadroom } from "./sandbox-activity.ts";
import {
  adoptDockerRestoreForCleanup,
  attachDockerRestorePlacement,
  clearMissingDockerRetentionDeadlines,
  failDockerStartup,
  recordDockerCleanupReceipt,
  recordDockerRetentionDeadline,
  transitionSandbox,
} from "./sandbox-lifecycle.ts";
import { deferTransactionWake } from "./wake-bus.ts";

type Actor = { userId: string; orgId: string };
type Job = DockerHostJob;
type MachineHost = {
  hostId: string;
  installationId: string;
  actorEpoch?: string;
  canDispatch?: (tx: Sql, actorEpoch: string) => Promise<boolean>;
};
type RestoreClaim = Pick<RunnerJob, "id" | "sandbox_id" | "generation" | "lease_epoch">;
type DockerMachineOptions = MachineHost & {
  actor: Actor;
  inventory?: { hostToken: string; serverUrl: string; report: readonly DockerInventoryContainer[] };
  bootstrapDescriptor?: BootstrapDescriptor;
  restoreClaim?: RestoreClaim;
};
type RestoreJob = Extract<Job, { operation: "restore" }>;
type MachineCreateResult = { kind: "pending" | "unknown" } | { kind: "completed"; machine: MachineIdentity };
const dispatchPriority =
  "case when j.bound_operation in ('stop','delete') then 0 when j.bound_operation='restore' then 2 else 1 end,(j.snapshot_id is not null),j.position";

type Host = { id: string; org_id: string; owner_id: string };
type Bound = {
  snapshot_id?: string | null;
  bound_sandbox_id: string | null;
  bound_actor_id: string | null;
  bound_actor_epoch: string | null;
  bound_operation: string | null;
};
type StoredJob = Bound & {
  request_id: string;
  host_id: string;
  position: number | string;
  input_enc: Uint8Array<ArrayBuffer>;
  outcome: string | null;
  result_image_id?: string | null;
  result_machine_id?: string | null;
  absent_machine_id?: string | null;
  cancelled_at?: string | null;
};
function mailboxOutcome(receipt: StoredJob) {
  if (receipt.cancelled_at || receipt.outcome === "failed") return { kind: "unknown" } as const;
  return receipt.outcome === "completed"
    ? ({ kind: "completed", value: undefined } as const)
    : ({ kind: "pending" } as const);
}
type Sandbox = {
  id: string;
  org_id: string;
  owner_id: string;
  provider: string;
  provider_sandbox_id: string;
  docker_host_id: string;
  docker_installation_id: string;
  docker_generation: string;
  docker_image: string;
  docker_snapshot_id?: string | null;
  effective_ttl_seconds: number;
  expires_at: Date | string;
  status: string;
  lifecycle_generation: string | number;
  status_reason?: string | null;
  stop_requested_at: unknown;
  stopped_at?: unknown;
  deleted_at: unknown;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{64}$/;

export class DockerHostDenied extends Error {
  constructor() {
    super("Docker host denied");
    this.name = "DockerHostDenied";
  }
}
export class DockerHostUnavailable extends Error {
  constructor(cause: unknown) {
    super("Docker host unavailable", { cause });
    this.name = "DockerHostUnavailable";
  }
}
function deny(): never {
  throw new DockerHostDenied();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) deny();
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) deny();
}
function hash(token: unknown): string {
  if (typeof token !== "string" || !tokenPattern.test(token)) deny();
  return createHash("sha256").update(token).digest("hex");
}
/** SQL predicate over job alias `j`: not reported running, not behind a running job of
 * its sandbox, and no second snapshot build while one runs. `$n` is the running uuid[].
 * Only a running job whose outcome is not yet recorded blocks: the daemon reports the
 * list once per held poll, and a job completed during the hold must free its sandbox
 * and the snapshot slot at once, not when the hold expires (#2561). */
function notRunning(n: number): string {
  return `not (j.request_id=any($${n}::uuid[])) and not exists(select 1 from public.docker_host_jobs r
    where r.host_id=j.host_id and r.request_id=any($${n}::uuid[]) and r.outcome is null
    and ((r.bound_sandbox_id=j.bound_sandbox_id
      and (j.bound_operation is distinct from 'restore' or r.bound_operation not in ('stop','delete','deletePhysical')))
      or (r.snapshot_id is not null and j.snapshot_id is not null)))`;
}
const bootstrapIdSql =
  "left(encode(sha256(convert_to('docker-machine:' || b.daemon_generation::text || ':bootstrap', 'UTF8')), 'hex'),32)::uuid";
const machineStartupMailbox = `(j.bound_operation='create' and j.request_id=b.daemon_generation
  or j.bound_operation='bootstrap' and j.request_id=${bootstrapIdSql})`;
function eligibleMachineLaunch(capability: number) {
  return `not exists(select 1 from public.jobs launch
    join public.docker_machine_bindings b on b.sandbox_id=launch.sandbox_id and b.machine_generation=launch.generation
    where launch.kind='launch' and launch.outcome ? 'docker_actor_epoch'
      and b.sandbox_id=j.bound_sandbox_id and b.host_id=j.host_id and ${machineStartupMailbox}
      and (not $${capability}::boolean or launch.deadline_at<=clock_timestamp()
        or launch.attempts>launch.max_attempts
        or (launch.state in ('failed','done') and not (
          j.bound_operation='create' and ${dockerStopPending("launch.sandbox_id", "launch.generation", true)}
        ))))`;
}
function eligibleJob(physical: number, restore: number, bootstrap: number) {
  return `($${physical}::boolean or j.bound_operation is distinct from 'deletePhysical')
    and ($${restore}::boolean or j.bound_operation is distinct from 'restore')
    and ($${bootstrap}::boolean or j.bound_operation is distinct from 'bootstrap' or not exists(
      select 1 from public.docker_machine_bindings b
      where b.sandbox_id=j.bound_sandbox_id and b.host_id=j.host_id and j.request_id=${bootstrapIdSql}))
    and ${eligibleMachineLaunch(bootstrap)}
    and (j.bound_operation='restore' or not exists(
      select 1 from public.docker_host_jobs pending
      where pending.host_id=j.host_id and pending.bound_sandbox_id=j.bound_sandbox_id
        and pending.bound_operation='restore' and pending.outcome is null))`;
}

export async function cancelDockerLaunchMailbox(tx: Sql, sandboxId: string, generation: string) {
  await tx.query(
    `update public.docker_host_jobs j set outcome='failed',completed_at=now(),cancelled_at=now()
     from public.docker_machine_bindings b where b.sandbox_id=$1 and b.machine_generation=$2
       and j.bound_sandbox_id=b.sandbox_id and j.host_id=b.host_id and j.outcome is null
       and ${machineStartupMailbox}`,
    [sandboxId, generation],
  );
}

type MachineCleanupOperation = "stop" | "delete";
function isCleanupOperation(operation: string | null): operation is MachineCleanupOperation {
  return operation === "stop" || operation === "delete";
}

function generationFenced(operation: string | null) {
  return operation === "deletePhysical" || operation === "restore";
}
function input(job: Job): string {
  try {
    return canonicalDockerHostJob(job);
  } catch {
    return deny();
  }
}

/** Internal service-role store, deliberately not mounted as a route or wired into placement.
 * Poll is at-least-once; a host must serialize execution per sandbox, report what it is
 * still executing, and deduplicate request IDs durably.
 * Only trusted bootstrap tickets and authorized snapshot definitions enter this mailbox; Docker argv is generated on the host, and model credentials never enter build jobs.
 */
export function createDockerHostStore(sql: Sql, key: string) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      if (!sql.transaction) throw new Error("Docker host store requires transactions");
      return await sql.transaction(work);
    } catch (error) {
      if (
        error instanceof DockerHostDenied ||
        error instanceof DockerMachinePending ||
        error instanceof DockerHostDraining ||
        error instanceof DockerHostFull ||
        error instanceof DockerLimitsRefused ||
        error instanceof ProviderError ||
        error instanceof VaultError
      )
        throw error;
      throw new DockerHostUnavailable(error);
    }
  }
  async function admin(tx: Sql, actor: Actor) {
    exact(actor, ["userId", "orgId"]);
    id(actor.userId);
    id(actor.orgId);
    const result = await tx.query(
      `select 1 from public.members where org_id=$1 and user_id=$2 and role='admin' for share`,
      [actor.orgId, actor.userId],
    );
    if (!result.rows.length) deny();
  }
  async function owned(tx: Sql, actor: Actor, hostId: string) {
    await admin(tx, actor);
    id(hostId);
    const result = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2 and revoked_at is null for update`,
      [hostId, actor.orgId],
    );
    return result.rows[0] ?? deny();
  }
  async function authenticate(
    tx: Sql,
    hostToken: string,
    installationId: string,
    actorId?: string,
    refusalActors: readonly string[] = [],
  ) {
    id(installationId);
    const result = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts
      where hash=$1 and installation_id=$2 and revoked_at is null`,
      [hash(hostToken), installationId],
    );
    const host = result.rows[0] ?? deny();
    const member = await tx.query<{ user_id: string }>(
      `select user_id from public.members where org_id=$1 and user_id=any($2::uuid[]) order by user_id for share`,
      [host.org_id, [host.owner_id, actorId ?? host.owner_id, ...refusalActors]],
    );
    if (!member.rows.some((row) => row.user_id === host.owner_id)) deny();
    // Membership -> host -> job is the lock order for every operation. Recheck the
    // credential after taking the host lock so a concurrent revoke cannot slip through.
    const locked = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
       and hash=$4 and installation_id=$5 and revoked_at is null for update`,
      [host.id, host.org_id, host.owner_id, hash(hostToken), installationId],
    );
    return locked.rows[0] ?? deny();
  }
  // Retained credentials accept physical facts, never new launch authority.
  async function reconcileHost(
    tx: Sql,
    hostToken: string,
    installationId: string,
    actorId?: string,
    refusalActors: readonly string[] = [],
  ) {
    id(installationId);
    const actorIds = actorId ? [actorId, ...refusalActors] : refusalActors;
    if (actorIds.length) {
      // Preserve membership -> host lock order for cleanup dispatch authorization.
      await tx.query(
        `select m.user_id from public.members m join public.docker_hosts h on h.org_id=m.org_id
         where h.hash=$1 and h.installation_id=$2 and m.user_id=any($3::uuid[]) order by m.user_id for share of m`,
        [hash(hostToken), installationId, actorIds],
      );
    }
    const result = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts where hash=$1 and installation_id=$2 for update`,
      [hash(hostToken), installationId],
    );
    return result.rows[0] ?? deny();
  }
  async function insert(
    tx: Sql,
    hostId: string,
    job: Job,
    bound: Bound,
    lifecycleGeneration?: string,
    runnerJobId?: string,
    machineRetain?: boolean,
    machinePhysicalDelete?: true,
    retryAfter?: string,
  ) {
    const canonical = input(job);
    if (retryAfter && (job.operation !== "stop" || !machineRetain || !lifecycleGeneration)) deny();
    if (
      isCleanupOperation(job.operation) &&
      (job.requestId === dockerMachineJobId(retryAfter ?? job.request.generation, job.operation)) !==
        (lifecycleGeneration !== undefined)
    )
      deny();
    // Deliberately incompatible with old strict mailbox readers: a mixed-version
    // server must fail closed, never deliver bound work without actor admission.
    const serialized = JSON.stringify({
      bound: 1,
      job: JSON.parse(canonical),
      lifecycleGeneration,
      runnerJobId,
      machineRetain,
      machinePhysicalDelete,
      retryAfter,
    });
    const metadata: Bound = { snapshot_id: null, ...bound };
    const inserted = await tx.query(
      `insert into public.docker_host_jobs(request_id,host_id,input_enc,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation,snapshot_id)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning request_id`,
      [
        job.requestId,
        hostId,
        await encryptSecret(serialized, key),
        metadata.bound_sandbox_id,
        metadata.bound_actor_id,
        metadata.bound_actor_epoch,
        metadata.bound_operation,
        metadata.snapshot_id ?? null,
      ],
    );
    const existing =
      (await tx.query<StoredJob>(`select * from public.docker_host_jobs where request_id=$1`, [job.requestId]))
        .rows[0] ?? deny();
    if (
      existing.host_id !== hostId ||
      (await decryptSecret(existing.input_enc, key)) !== serialized ||
      Object.keys(metadata).some(
        (field) => String(existing[field as keyof Bound]) !== String(metadata[field as keyof Bound]),
      )
    )
      deny();
    // A conflicting row is a replay of an already admitted request: no new host work.
    if (inserted.rows.length) {
      // The SQL adapter publishes after the outer transaction commits, including
      // enqueues made through a scoped transaction owned by another service.
      deferTransactionWake(tx, `host:${hostId}`);
      noteAdmission();
    }
    return { requestId: job.requestId };
  }
  async function readJob(row: StoredJob, expectedGeneration?: Sandbox["lifecycle_generation"]): Promise<Job> {
    return (await readStoredJob(row, expectedGeneration)).job;
  }

  async function readStoredJob(row: StoredJob, expectedGeneration?: Sandbox["lifecycle_generation"]) {
    let runnerJobId: string | undefined;
    let lifecycleGeneration: string | undefined;
    let machineRetain: boolean | undefined;
    let machinePhysicalDelete = false;
    let retryAfter: string | undefined;
    const plaintext = await decryptSecret(row.input_enc, key).catch((error: unknown) => {
      if (row.bound_operation === "restore" && error instanceof DOMException && error.name === "OperationError") deny();
      throw error;
    });
    let stored: unknown;
    try {
      stored = JSON.parse(plaintext);
    } catch (error) {
      if (row.bound_operation === "restore") deny();
      throw error;
    }
    if (row.bound_sandbox_id !== null || row.snapshot_id) {
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) deny();
      const fenced =
        generationFenced(row.bound_operation) ||
        (isCleanupOperation(row.bound_operation) && "lifecycleGeneration" in stored);
      const machineStop = fenced && row.bound_operation === "stop";
      machinePhysicalDelete = row.bound_operation === "deletePhysical" && "machinePhysicalDelete" in stored;
      exact(stored, [
        "bound",
        "job",
        ...(fenced ? ["lifecycleGeneration"] : []),
        ...(machineStop ? ["machineRetain"] : []),
        ...(machineStop && "retryAfter" in stored ? ["retryAfter"] : []),
        ...(machinePhysicalDelete ? ["machinePhysicalDelete"] : []),
        ...(row.bound_operation === "restore" ? ["runnerJobId"] : []),
      ]);
      if (row.bound_operation === "restore") {
        id(stored.runnerJobId);
        runnerJobId = stored.runnerJobId;
      }
      if (stored.bound !== 1 || (machinePhysicalDelete && stored.machinePhysicalDelete !== true)) deny();
      if (machineStop) {
        if (typeof stored.machineRetain !== "boolean") deny();
        machineRetain = stored.machineRetain;
        if ("retryAfter" in stored) {
          id(stored.retryAfter);
          if (!machineRetain) deny();
          retryAfter = stored.retryAfter;
        }
      }
      if (fenced) {
        if (
          typeof stored.lifecycleGeneration !== "string" ||
          !/^[1-9][0-9]*$/.test(stored.lifecycleGeneration) ||
          (expectedGeneration !== undefined && stored.lifecycleGeneration !== String(expectedGeneration))
        )
          deny();
        lifecycleGeneration = stored.lifecycleGeneration;
      }
      stored = stored.job;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) deny();
    let job: Job;
    try {
      job = parseDockerHostJob({ ...stored, requestId: row.request_id });
    } catch (error) {
      if (row.bound_operation === "restore") deny();
      throw error;
    }
    if (generationFenced(job.operation) && row.bound_sandbox_id === null) deny();
    if (
      row.bound_sandbox_id !== null &&
      (job.request.sandboxId !== row.bound_sandbox_id || job.operation !== row.bound_operation)
    )
      deny();
    if (
      row.snapshot_id &&
      (job.operation !== "buildSnapshot" ||
        job.build.id !== row.snapshot_id ||
        job.build.ownerId !== row.bound_actor_id)
    )
      deny();
    const machineCleanup = isCleanupOperation(job.operation) && lifecycleGeneration !== undefined;
    if (
      isCleanupOperation(job.operation) &&
      machineCleanup &&
      job.requestId !== dockerMachineJobId(retryAfter ?? job.request.generation, job.operation)
    )
      deny();
    return { job, runnerJobId, lifecycleGeneration, machineCleanup, machineRetain, machinePhysicalDelete };
  }
  async function sandbox(tx: Sql, sandboxId: string, host: Host, installationId: string) {
    const row = (await tx.query<Sandbox>(`select * from public.sandboxes where id=$1 for update`, [sandboxId])).rows[0];
    if (
      !row ||
      row.org_id !== host.org_id ||
      row.docker_host_id !== host.id ||
      row.docker_installation_id !== installationId ||
      row.provider_sandbox_id !== `armada-${installationId}-${host.id}-${row.id}-${row.docker_generation}`
    )
      deny();
    return row;
  }
  async function lockSandboxAdmission(
    tx: Sql,
    actor: Actor,
    sandboxId: string,
    operation: "create" | "stop" | "delete" | "restore" | "deletePhysical" | "bootstrap",
    scope?: MachineHost,
  ) {
    exact(actor, ["userId", "orgId"]);
    id(actor.userId);
    id(actor.orgId);
    id(sandboxId);
    const hint =
      (
        await tx.query<Sandbox & { issuer_id: string }>(
          `select s.*,h.owner_id as issuer_id from public.sandboxes s join public.docker_hosts h on h.id=s.docker_host_id
       where s.id=$1 and s.org_id=$2`,
          [sandboxId, actor.orgId],
        )
      ).rows[0] ?? deny();
    if (scope && (scope.hostId !== hint.docker_host_id || scope.installationId !== hint.docker_installation_id)) deny();
    const members = await tx.query<{ user_id: string }>(
      `select user_id from public.members where org_id=$1 and user_id in ($2,$3,$4) order by user_id for update`,
      [actor.orgId, actor.userId, hint.issuer_id, hint.owner_id],
    );
    const locked = new Set(members.rows.map((m) => m.user_id));
    const cleanup = operation === "stop" || operation === "delete";
    if (!locked.has(actor.userId) || (!cleanup && !locked.has(hint.issuer_id))) deny();
    const host =
      (
        await tx.query<Host & { revoked: boolean; draining: boolean }>(
          `select id,org_id,owner_id,revoked_at is not null as revoked,draining_at is not null as draining from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
       and installation_id=$4 and hash is not null and registration_hash is null and ($5::boolean or revoked_at is null) for update`,
          [hint.docker_host_id, actor.orgId, hint.issuer_id, hint.docker_installation_id, cleanup],
        )
      ).rows[0] ?? deny();
    const row = await sandbox(tx, sandboxId, host, hint.docker_installation_id);
    if (row.owner_id !== hint.owner_id) deny();
    return { host, row };
  }
  async function permission(tx: Sql, actor: Actor, row: Sandbox, operation: string, epoch?: string | null) {
    const member = (
      await tx.query<{ role: string; epoch: string }>(
        `select m.role,e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
       where m.org_id=$1 and m.user_id=$2`,
        [actor.orgId, actor.userId],
      )
    ).rows[0];
    if (
      !member ||
      row.org_id !== actor.orgId ||
      (epoch != null && member.epoch !== String(epoch)) ||
      (row.owner_id !== actor.userId && (!(operation === "stop" || operation === "delete") || member.role !== "admin"))
    )
      deny();
    return member.epoch;
  }
  async function fenceFreshStartup(tx: Sql, row: Sandbox) {
    const { rows } = await tx.query(`select 1 where ${dockerStopPending("$1", "$2")}`, [
      row.id,
      row.lifecycle_generation,
    ]);
    if (rows.length) deny();
  }
  async function state(tx: Sql, row: Sandbox, operation: string) {
    if (operation === "stop") return;
    if (operation === "deletePhysical") {
      if (!["failed", "deleted"].includes(row.status)) deny();
      return;
    }
    if (operation === "delete") {
      if (!["stopped", "failed", "deleted"].includes(row.status)) deny();
      return;
    }
    if (
      !(operation === "create" ? row.status === "starting" : ["starting", "ready", "running"].includes(row.status)) ||
      row.stop_requested_at !== null ||
      row.deleted_at !== null
    )
      deny();
    const live = await tx.query(`select 1 from public.sandboxes where id=$1 and expires_at>now()`, [row.id]);
    if (!live.rows.length) deny();
  }
  async function assertIdleStop(tx: Sql, row: Sandbox, hostId: string, sequence: string) {
    if (row.status !== "ready") deny();
    const pendingWork = await tx.query(
      `select 1 from public.docker_launch_manifests where sandbox_id=$1 and result_enc is null
             union all
             select 1 from public.account_turn_queue where sandbox_id=$1 and state in ('queued','dispatching')
             union all
             ${unsettledRuntimeCommands("$1", "$2", "$3")}
             union all select 1 from public.runtime_commands where sandbox_id=$1
               and starts_with(request_id,'docker_prompt_') and sequence>$4
             limit 1`,
      [row.id, row.lifecycle_generation, hostId, sequence],
    );
    if (pendingWork.rows.length) deny();
  }
  async function checkpointedStop(tx: Sql, row: Sandbox, checkpoint: string) {
    const proof = await tx.query<{ work_merged: boolean; epoch: string }>(
      `select p.merge_stop as work_merged,p.epoch::text from public.sandboxes s join public.runtime_enrolments r
       on r.sandbox_id=s.id and r.lifecycle_generation=s.lifecycle_generation and r.runtime_hash is not null
       join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
       where s.id=$1 and p.request_id=$2 and p.watermark is not null
       and ${currentDockerRuntimeIssuer("s.docker_host_id")}
       and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)
       and s.status in ('ready','running') and s.stop_requested_at is null and s.expires_at>now()
       and s.activity_lease_id is null and not s.application_secret_tainted
       and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=s.id
         and q.state in ('queued','dispatching'))`,
      [row.id, checkpoint],
    );
    return proof.rows[0] ?? deny();
  }
  async function machine(tx: Sql, row: Sandbox, operation: string) {
    const original = (
      await tx.query<StoredJob>(
        `select * from public.docker_host_jobs where bound_sandbox_id=$1
         and (bound_operation='create' or (bound_operation='restore' and request_id=$2 and outcome='completed'
           and cancelled_at is null))
         order by (bound_operation='restore') desc limit 1`,
        [row.id, row.docker_generation],
      )
    ).rows[0];
    if (!original) {
      if (operation !== "create" && (!isCleanupOperation(operation) || !(await currentMachineCleanup(tx, row)))) deny();
      // Cleanup and replay validate an existing sandbox's identity; a drain must not hide its source.
      const source =
        operation === "create" && row.docker_snapshot_id
          ? await resolveDockerSnapshot(tx, { userId: row.owner_id, orgId: row.org_id }, row.docker_snapshot_id, {
              allowDraining: true,
            })
          : undefined;
      if (
        source &&
        (source.image_id !== row.docker_image ||
          source.host_id !== row.docker_host_id ||
          source.installation_id !== row.docker_installation_id)
      )
        deny();
      return {
        ...(source ? { snapshot: { id: source.id, ownerId: source.owner_id, visibility: source.visibility } } : {}),
        sandboxId: row.id,
        generation: row.docker_generation,
        image: row.docker_image,
        ttlSeconds: row.effective_ttl_seconds,
        expiresAt: new Date(row.expires_at).getTime(),
      };
    }
    const saved = await readJob(original);
    if (
      original.host_id !== row.docker_host_id ||
      (saved.operation !== "create" && saved.operation !== "restore") ||
      saved.request.sandboxId !== row.id ||
      saved.request.generation !== row.docker_generation ||
      saved.request.image !== row.docker_image ||
      (saved.request.snapshot?.id ?? null) !== (row.docker_snapshot_id ?? null) ||
      saved.request.expiresAt === undefined
    )
      deny();
    if (operation === "bootstrap" && original.outcome !== "completed") deny();
    return saved.request;
  }
  async function writeBoundCleanup(
    tx: Sql,
    row: Sandbox,
    operation: MachineCleanupOperation,
    requestId: string,
    actorId: string,
    actorEpoch: string,
  ) {
    return insert(
      tx,
      row.docker_host_id,
      { operation, requestId, request: await machine(tx, row, operation) },
      {
        bound_sandbox_id: row.id,
        bound_actor_id: actorId,
        bound_actor_epoch: actorEpoch,
        bound_operation: operation,
      },
    );
  }

  async function supersededLifecycle(
    tx: Sql,
    job: Pick<StoredJob, "bound_sandbox_id" | "request_id" | "position">,
    restoreOnly = false,
  ) {
    if (!restoreOnly) {
      const legacy = await tx.query(
        `select 1 from public.docker_host_jobs
         where bound_sandbox_id=$1 and position>$2
         and (bound_operation='bootstrap' and outcome is distinct from 'failed')
         limit 1`,
        [job.bound_sandbox_id, job.position],
      );
      if (legacy.rows.length) return true;
    }

    const { rows } = await tx.query<
      StoredJob & {
        target_generation: string;
        target_daemon_generation: string;
        source_daemon_generation: string;
      }
    >(
      `select later.*, target.machine_generation::text as target_generation,
         target.daemon_generation as target_daemon_generation, source.daemon_generation as source_daemon_generation
       from public.docker_host_jobs later
       join public.sandboxes s on s.id=later.bound_sandbox_id and s.docker_host_id=later.host_id
       join public.docker_machine_bindings target on target.sandbox_id=s.id
         and target.host_id=s.docker_host_id and target.installation_id=s.docker_installation_id
         and target.machine_generation between s.lifecycle_generation-case
           when s.status in ('failed','stopping','stopped') then 1 else 0 end and s.lifecycle_generation
         and target.daemon_generation<>s.docker_generation
       join public.docker_machine_bindings source on source.sandbox_id=s.id
         and source.host_id=s.docker_host_id and source.installation_id=s.docker_installation_id
         and source.daemon_generation=s.docker_generation and source.machine_generation<target.machine_generation
       where later.bound_sandbox_id=$1 and later.request_id<>$2 and later.bound_operation='restore'
         and (later.outcome is distinct from 'failed' or later.cancelled_at is not null)`,
      [job.bound_sandbox_id, job.request_id],
    );
    for (const row of rows) {
      try {
        const intent = await readJob(row, row.target_generation);
        if (
          intent.operation === "restore" &&
          intent.request.generation === row.target_daemon_generation &&
          intent.predecessor.request.generation === row.source_daemon_generation
        )
          return true;
      } catch (error) {
        if (!(error instanceof DockerHostDenied)) throw error;
      }
    }
    return false;
  }

  async function validateRestoreTarget(tx: Sql, logical: Sandbox, job: RestoreJob) {
    if (
      job.request.sandboxId !== logical.id ||
      logical.status !== "starting" ||
      logical.docker_generation !== job.predecessor.request.generation ||
      logical.docker_image !== job.request.image ||
      (logical.docker_snapshot_id ?? null) !== (job.request.snapshot?.id ?? null) ||
      new Date(logical.expires_at).getTime() !== job.request.expiresAt
    )
      deny();
    await state(tx, logical, "restore");
    await requireRestoreBindings(tx, logical, job);
  }

  async function requireRestoreBindings(
    tx: Sql,
    logical: Sandbox,
    job: RestoreJob,
    targetGeneration = logical.lifecycle_generation,
  ) {
    const bindings = await tx.query(
      `select 1 from public.docker_machine_bindings target join public.docker_machine_bindings source
         on source.sandbox_id=target.sandbox_id and source.host_id=target.host_id
         and source.installation_id=target.installation_id and source.machine_generation<target.machine_generation
       where target.sandbox_id=$1 and target.host_id=$2 and target.installation_id=$3
         and target.machine_generation=$4 and target.daemon_generation=$5 and source.daemon_generation=$6`,
      [
        logical.id,
        logical.docker_host_id,
        logical.docker_installation_id,
        targetGeneration,
        job.request.generation,
        job.predecessor.request.generation,
      ],
    );
    if (!bindings.rows.length) deny();
  }

  async function requireRestoreRunner(tx: Sql, runnerJobId: unknown, logical: Sandbox, leaseEpoch?: string) {
    id(runnerJobId);
    const { rows } = await tx.query(
      `select 1 from public.jobs j join public.sandboxes s on s.id=j.sandbox_id
       where j.id=$1 and j.org_id=$2 and j.sandbox_id=$3 and j.generation=$4
         and j.kind='resume' and s.lifecycle_generation=j.generation
         and case when $5::bigint is null then ${resumeDispatchAuthority("j", "s", true)}
           else j.state='leased' and j.lease_epoch=$5 and j.lease_until>clock_timestamp()
             and j.deadline_at>clock_timestamp() and j.attempts<=j.max_attempts end
       for update of j`,
      [runnerJobId, logical.org_id, logical.id, logical.lifecycle_generation, leaseEpoch ?? null],
    );
    if (!rows.length) deny();
  }

  async function enqueueRestore(tx: Sql, row: Sandbox, job: RestoreJob, bound: Bound, runnerJobId: string) {
    input(job);
    if (job.requestId !== job.request.generation) deny();
    if (job.request.ttlSeconds !== row.effective_ttl_seconds) deny();
    await validateRestoreTarget(tx, row, job);
    await verifyRestoreSource(tx, row, job);
    return insert(tx, row.docker_host_id, job, bound, String(row.lifecycle_generation), runnerJobId);
  }

  async function refuseDraining(tx: Sql, hostId: string) {
    const draining = await tx.query(
      `select 1 from public.docker_hosts where id=$1 and ${hostDrainingSql("docker_hosts")}`,
      [hostId],
    );
    if (draining.rows.length) throw new DockerHostDraining();
  }

  async function admitRestore(tx: Sql, row: StoredJob, host: Host, installationId: string, deliver = false) {
    const logical = await sandbox(tx, row.bound_sandbox_id ?? deny(), host, installationId);
    const { job, runnerJobId } = await readStoredJob(row, logical.lifecycle_generation);
    if (job.operation !== "restore") deny();
    id(runnerJobId);
    await permission(
      tx,
      { userId: row.bound_actor_id ?? deny(), orgId: host.org_id },
      logical,
      "restore",
      row.bound_actor_epoch,
    );
    await validateRestoreTarget(tx, logical, job);
    await requireRestoreRunner(tx, runnerJobId, logical);
    if (deliver) await recordDockerRestoreEvidence(tx, runnerJobId, { restoreDelivered: true });
    return job;
  }

  async function verifyRestoreSource(tx: Sql, logical: Sandbox, job: RestoreJob) {
    const { rows } = await tx.query<StoredJob>(
      `select * from public.docker_host_jobs where bound_sandbox_id=$1 and host_id=$2
       and bound_operation in ('create','restore') and outcome='completed'`,
      [logical.id, logical.docker_host_id],
    );
    for (const row of rows) {
      let allocation: Job;
      try {
        allocation = await readJob(row);
      } catch (error) {
        if (!(error instanceof DockerHostDenied)) throw error;
        continue;
      }
      if (
        allocation.request.generation === logical.docker_generation &&
        input({ ...job, predecessor: { ...job.predecessor, request: allocation.request } }) === input(job) &&
        allocation.request.snapshot?.ownerId === job.request.snapshot?.ownerId &&
        allocation.request.snapshot?.visibility === job.request.snapshot?.visibility &&
        allocation.request.snapshot?.id === job.request.snapshot?.id
      )
        return;
    }
    deny();
  }

  async function matchesMachineCreateGeneration(
    tx: Sql,
    row: Pick<
      Sandbox,
      "id" | "docker_host_id" | "docker_installation_id" | "docker_generation" | "lifecycle_generation"
    >,
    requestId: string,
  ) {
    if (requestId !== row.docker_generation) return true;
    const bindings = createDockerMachineGenerationBindings(tx, {
      hostId: row.docker_host_id,
      installationId: row.docker_installation_id,
    });
    return (await bindings.lookup({ sandboxId: row.id, generation: Number(row.lifecycle_generation) })) === requestId;
  }

  async function currentMachineCleanup(tx: Sql, row: Sandbox) {
    const generation = (
      await tx.query<{ machine_generation: string }>(
        `select machine_generation::text from public.docker_machine_bindings
         where sandbox_id=$1 and host_id=$2 and installation_id=$3 and daemon_generation=$4`,
        [row.id, row.docker_host_id, row.docker_installation_id, row.docker_generation],
      )
    ).rows[0]?.machine_generation;
    if (!generation) return undefined;
    const current = BigInt(row.lifecycle_generation);
    if (
      current === BigInt(generation) ||
      (["stopping", "stopped", "failed"].includes(row.status) && current === BigInt(generation) + 1n)
    )
      return generation;
    return undefined;
  }
  function restoreCleanupGeneration(row: Sandbox, generation: string) {
    return (
      String(row.lifecycle_generation) === generation ||
      (["stopping", "stopped", "failed"].includes(row.status) &&
        BigInt(row.lifecycle_generation) === BigInt(generation) + 1n)
    );
  }

  async function reconcileRestoreStop(tx: Sql, row: Sandbox) {
    const {
      rows: [resume],
    } = await tx.query<{ delivered: boolean; request_id: string | null; generation: string }>(
      `select coalesce((coalesce(w.outcome->'evidence',w.outcome)->>'restoreDelivered')::boolean,false) as delivered,
         h.request_id,w.generation::text
       from public.jobs w left join public.docker_machine_bindings b on b.sandbox_id=w.sandbox_id
         and b.machine_generation=w.generation and b.host_id=$3 and b.installation_id=$4
       left join public.docker_host_jobs h on h.request_id=b.daemon_generation
         and h.host_id=b.host_id and h.bound_sandbox_id=b.sandbox_id and h.bound_operation='restore'
       where w.sandbox_id=$1 and w.kind='resume' and w.generation between $2::bigint-case when $5::boolean then 1 else 0 end and $2::bigint
       order by w.generation desc limit 1`,
      [
        row.id,
        row.lifecycle_generation,
        row.docker_host_id,
        row.docker_installation_id,
        ["failed", "stopped", "stopping"].includes(row.status),
      ],
    );
    if (!resume) return undefined;
    const receipt = resume.request_id && (await machineJob(tx, row, resume.request_id, "restore"));
    if (!receipt || receipt.request_id === row.docker_generation) return receipt ? undefined : null;
    const { job } = await readStoredJob(receipt, resume.generation);
    if (job.operation !== "restore" || job.predecessor.request.generation !== row.docker_generation) deny();
    await requireRestoreBindings(tx, row, job, resume.generation);
    if (receipt.outcome === "completed" && receipt.result_machine_id && !receipt.cancelled_at) {
      if (
        !(await adoptDockerRestoreForCleanup(
          tx,
          row.id,
          row.lifecycle_generation,
          row.docker_generation,
          receipt.request_id,
        ))
      )
        deny();
      return { machineId: receipt.result_machine_id, generation: Number(resume.generation) };
    }
    if (!resume.delivered || (receipt.outcome === "failed" && !receipt.cancelled_at)) return null;
    throw new DockerMachinePending("pending");
  }

  async function allocationReceipt(
    tx: Sql,
    row: Pick<Sandbox, "id" | "docker_host_id" | "docker_generation">,
    daemonGeneration = row.docker_generation,
  ) {
    return (
      await tx.query<{ result_machine_id: string | null }>(
        `select result_machine_id from public.docker_host_jobs
         where request_id=$1 and host_id=$2 and bound_sandbox_id=$3
           and bound_operation in ('create','restore') and outcome='completed' and cancelled_at is null`,
        [daemonGeneration, row.docker_host_id, row.id],
      )
    ).rows[0]?.result_machine_id;
  }
  async function machineCleanupReceipt(tx: Sql, row: Sandbox, operation: MachineCleanupOperation) {
    let requestId = dockerMachineJobId(row.docker_generation, operation);
    let latest: (StoredJob & { retain: boolean | undefined }) | undefined;
    const generation = await currentMachineCleanup(tx, row);
    if (!generation) return undefined;
    for (;;) {
      const receipt = await machineJob(tx, row, requestId, operation);
      if (!receipt || (await supersededLifecycle(tx, receipt))) return latest;
      const delivered = await readStoredJob(receipt);
      if (!delivered.machineCleanup || delivered.lifecycleGeneration !== generation) return latest;
      await requireCurrentMachine(tx, row, delivered.job);
      latest = { ...receipt, retain: delivered.machineRetain };
      if (operation !== "stop" || receipt.outcome !== "failed" || receipt.cancelled_at || !latest.retain) return latest;
      requestId = dockerMachineJobId(requestId, "stop");
    }
  }
  async function physicalRemovalReceipt(tx: Sql, row: Sandbox, machineId: string, machineOnly = false) {
    const { rows } = await tx.query<StoredJob>(
      `select * from public.docker_host_jobs where host_id=$1 and bound_sandbox_id=$2
       and bound_operation='deletePhysical'
       order by (outcome is not distinct from 'completed' and cancelled_at is null) desc, position desc`,
      [row.docker_host_id, row.id],
    );
    for (const receipt of rows) {
      const { job, machinePhysicalDelete } = await readStoredJob(receipt);
      if (
        (!machineOnly || machinePhysicalDelete) &&
        job.operation === "deletePhysical" &&
        job.request.generation === row.docker_generation &&
        job.machineId === machineId
      )
        return receipt;
    }
    return undefined;
  }
  async function machineJob(tx: Sql, row: Sandbox, requestId: string, operation: Job["operation"]) {
    return (
      await tx.query<StoredJob>(
        `select * from public.docker_host_jobs
         where request_id=$1 and host_id=$2 and bound_sandbox_id=$3 and bound_operation=$4`,
        [requestId, row.docker_host_id, row.id, operation],
      )
    ).rows[0];
  }

  async function runtimeEnrolled(tx: Sql, row: Sandbox) {
    const result = await tx.query(
      `select 1 from public.runtime_enrolments
       where sandbox_id=$1 and lifecycle_generation=$2 and runtime_hash is not null`,
      [row.id, row.lifecycle_generation],
    );
    return result.rows.length > 0;
  }

  async function machineBootstrapped(tx: Sql, row: Sandbox) {
    const receipt = await machineJob(tx, row, dockerMachineJobId(row.docker_generation, "bootstrap"), "bootstrap");
    if (!receipt || ((receipt.outcome !== "completed" || receipt.cancelled_at) && !(await runtimeEnrolled(tx, row))))
      return undefined;
    const job = await readJob(receipt);
    if (job.operation !== "bootstrap") deny();
    return {
      operation: "bootstrap",
      bindingRef: createHash("sha256").update(job.bootstrap.enrolmentToken).digest("hex"),
    } as const;
  }

  const observedAllocation: (
    tx: Sql,
    row: Sandbox,
    request: MachineIncarnation & { machineId?: string },
  ) => Promise<MachineObservation> = async (tx, row, request) => {
    const unknown = { kind: "unknown" } as const;
    if (!Number.isSafeInteger(request.generation) || Number(row.lifecycle_generation) !== request.generation)
      return unknown;
    try {
      await state(tx, row, "bootstrap");
    } catch (error) {
      if (error instanceof DockerHostDenied) return unknown;
      throw error;
    }
    const bindings = createDockerMachineGenerationBindings(tx, {
      hostId: row.docker_host_id,
      installationId: row.docker_installation_id,
    });
    const daemonGeneration = await bindings.lookup(request);
    if (!daemonGeneration) return unknown;
    const machineId = await allocationReceipt(tx, row, daemonGeneration);
    if (!machineId || (request.machineId !== undefined && request.machineId !== machineId)) return unknown;
    const identity = { sandboxId: row.id, generation: request.generation, machineId };
    if (daemonGeneration !== row.docker_generation) {
      const receipt = await machineJob(tx, row, daemonGeneration, "restore");
      if (!receipt) return unknown;
      const job = await readJob(receipt, row.lifecycle_generation);
      if (job.operation !== "restore") return unknown;
      await validateRestoreTarget(tx, row, job);
      return {
        kind: "present",
        machine: identity,
        phase: "starting",
        receipt: { operation: "resume", machine: identity },
      };
    }
    const bootstrap = await machineBootstrapped(tx, row);
    const operation = (await machineJob(tx, row, daemonGeneration, "restore")) ? "resume" : "create";
    return {
      kind: "present",
      machine: identity,
      phase: row.status === "starting" ? "starting" : "running",
      receipt: bootstrap ?? { operation, machine: identity },
    };
  };
  async function requireCurrentMachine(tx: Sql, logical: Sandbox, delivered: Job) {
    const frozen = await machine(tx, logical, "stop");
    if (input(delivered) !== input({ ...delivered, request: frozen })) deny();
    return logical;
  }
  async function boundMachine(tx: Sql, job: StoredJob, host: Host, installationId: string) {
    const logical = await sandbox(tx, job.bound_sandbox_id ?? deny(), host, installationId);
    const delivered = await readJob(
      job,
      job.bound_operation === "deletePhysical" ? logical.lifecycle_generation : undefined,
    );
    return requireCurrentMachine(tx, logical, delivered);
  }

  async function currentOrSupersededMachine(tx: Sql, job: StoredJob, host: Host, installationId: string) {
    const logical = await sandbox(tx, job.bound_sandbox_id ?? deny(), host, installationId);
    const delivered = await readJob(job);
    if (delivered.request.generation === logical.docker_generation)
      return requireCurrentMachine(tx, logical, delivered);

    const receipt =
      (
        await tx.query<StoredJob>(
          `select * from public.docker_host_jobs where request_id=$1 and host_id=$2 and bound_sandbox_id=$3
         and bound_operation='restore' and outcome='completed' and cancelled_at is null`,
          [logical.docker_generation, host.id, logical.id],
        )
      ).rows[0] ?? deny();
    const { job: restore, lifecycleGeneration } = await readStoredJob(receipt);
    if (restore.operation !== "restore" || restore.request.generation !== receipt.request_id || !lifecycleGeneration)
      deny();
    await requireRestoreBindings(tx, logical, restore, lifecycleGeneration);
    const predecessor = await tx.query(
      `select 1 from public.docker_machine_bindings where sandbox_id=$1 and host_id=$2 and installation_id=$3
       and daemon_generation=$4 and machine_generation<$5`,
      [logical.id, host.id, installationId, delivered.request.generation, lifecycleGeneration],
    );
    if (!predecessor.rows.length) deny();
    return undefined;
  }
  async function startupFailed(tx: Sql, row: Sandbox, job: StoredJob, reason?: DockerJobFailureReason) {
    const operation = job.bound_operation;
    const message =
      reason === "disk_full"
        ? DOCKER_LAUNCH_FAILURE_MESSAGES.disk
        : reason === "image_unavailable" && operation === "create"
          ? DOCKER_IMAGE_UNAVAILABLE_MESSAGE
          : DOCKER_LAUNCH_FAILURE_MESSAGES.startup;
    if (operation !== "create" && operation !== "bootstrap") return false;
    if (operation === "create" && !(await matchesMachineCreateGeneration(tx, row, job.request_id))) return false;
    if (await supersededLifecycle(tx, job)) return false;
    if (
      operation === "bootstrap" &&
      job.request_id === dockerMachineJobId(row.docker_generation, "bootstrap") &&
      (await runtimeEnrolled(tx, row))
    )
      return false;
    return failDockerStartup(tx, row.id, row.lifecycle_generation, "docker_startup_failed", message);
  }
  /** Retire queued work the server can no longer dispatch. This is cancellation,
   * never physical evidence: a bound startup becomes failed without stopped_at,
   * and stop/delete jobs stay dispatchable through reconcileHost. The caller
   * holds the host lock, so no concurrent enqueue or ACK can interleave. */
  async function retireUndispatchable(tx: Sql, hostId: string, reason: { sandbox: string; snapshot: string }) {
    await tx.query(
      `update public.docker_snapshots set status='failed',image_id=null,failure_reason=$2
       where host_id=$1 and status='building'`,
      [hostId, reason.snapshot],
    );
    const startups = await tx.query<
      Pick<StoredJob, "request_id" | "position" | "bound_operation"> &
        Pick<
          Sandbox,
          "id" | "docker_host_id" | "docker_installation_id" | "docker_generation" | "lifecycle_generation"
        > & {
          bound_sandbox_id: string;
        }
    >(
      `select j.request_id,j.position,j.bound_sandbox_id,j.bound_operation,s.id,s.docker_host_id,s.docker_installation_id,
         s.docker_generation,s.lifecycle_generation::text
       from public.docker_host_jobs j
       join public.sandboxes s on s.id=j.bound_sandbox_id and s.docker_host_id=j.host_id
       where j.host_id=$1 and j.outcome is null
         and j.bound_operation in ('create','bootstrap') for update of j`,
      [hostId],
    );
    for (const startup of startups.rows) {
      if (
        startup.bound_operation === "create" &&
        !(await matchesMachineCreateGeneration(tx, startup, startup.request_id))
      )
        continue;
      if (await supersededLifecycle(tx, startup)) continue;
      await failDockerStartup(
        tx,
        startup.bound_sandbox_id,
        startup.lifecycle_generation,
        "docker_host_retired",
        reason.sandbox,
      );
    }
    await tx.query(
      `update public.docker_host_jobs set outcome='failed',completed_at=now(),cancelled_at=now()
       where host_id=$1 and outcome is null
         and (bound_operation is null or bound_operation not in ('stop','delete'))`,
      [hostId],
    );
  }
  const store = {
    list(actor: Actor): Promise<DockerHostSummary[]> {
      return transaction(async (tx) => {
        exact(actor, ["userId", "orgId"]);
        id(actor.userId);
        id(actor.orgId);
        const member = await tx.query(`select 1 from public.members where org_id=$1 and user_id=$2 for share`, [
          actor.orgId,
          actor.userId,
        ]);
        if (!member.rows.length) deny();
        const hosts = await tx.query<{
          id: string;
          state: DockerHostSummary["state"];
          created_at: Date | string;
          last_seen_at: Date | string | null;
          revoked_at: Date | string | null;
          sandboxes: number;
          owner_id: string;
          resource_policy_version: number | null;
          sandbox_cpus: number | null;
          sandbox_memory_bytes: string | number | null;
          max_sandboxes: number | null;
          available_cpus: number | null;
          available_memory_bytes: number | string | null;
          machine_cpus: number | null;
          machine_memory_bytes: number | string | null;
          running: number;
          daemon_version: string | null;
          daemon_protocol: number | null;
          update_policy: DockerHostUpdatePolicy;
          pinned_version: string | null;
          update_requested: boolean;
          last_update_result: unknown;
          name: string | null;
          retention_seconds: number | null;
          reported_retention_seconds: number | null;
          next_cleanup_at: Date | string | null;
          disk_free_bytes: number | string | null;
          stopped_sandbox_bytes: number | string | null;
        }>(
          `select h.id,
            case when h.revoked_at is not null then 'revoked'
              when h.installation_id is null then 'pending'
              when ${hostDrainingSql("h")} then 'draining'
              when h.hash is not null and h.registration_hash is null
                and exists(select 1 from public.members m where m.org_id=h.org_id and m.user_id=h.owner_id)
                and h.last_seen_at>=now()-interval '60 seconds' then 'online'
              else 'offline' end as state,
            h.retention_seconds,h.reported_retention_seconds,h.next_cleanup_at,h.disk_free_bytes,h.stopped_sandbox_bytes,h.created_at,h.last_seen_at,h.revoked_at,h.daemon_version,h.daemon_protocol,h.name,h.owner_id,h.resource_policy_version,h.machine_cpus,h.machine_memory_bytes,h.available_cpus,h.available_memory_bytes,h.sandbox_cpus,h.sandbox_memory_bytes,h.max_sandboxes,
            h.update_policy,h.pinned_version,h.update_requested,h.last_update_result - 'daemonAt' as last_update_result,
            (${DOCKER_CAPACITY_USAGE_SQL})::integer as running,
            (select count(*)::integer from public.sandboxes s
              where s.org_id=h.org_id and s.docker_host_id=h.id
                and s.provider='docker' and s.status<>'deleted') as sandboxes
          from public.docker_hosts h where h.org_id=$1
            and (h.installation_id is not null or h.revoked_at is not null or h.registration_expires_at>now())
          order by h.created_at,h.id`,
          [actor.orgId],
        );
        return hosts.rows.map((host) => ({
          id: host.id,
          name: host.name,
          state: host.state,
          createdAt: new Date(host.created_at).toISOString(),
          lastSeenAt: host.last_seen_at === null ? null : new Date(host.last_seen_at).toISOString(),
          revokedAt: host.revoked_at === null ? null : new Date(host.revoked_at).toISOString(),
          running: host.running,
          resources: (() => {
            try {
              return hostResourcePolicy(host, host.running);
            } catch (error) {
              if (error instanceof DockerLimitsRefused) return null;
              throw error;
            }
          })(),
          diskFreeBytes: host.disk_free_bytes == null ? null : Number(host.disk_free_bytes),
          stoppedSandboxBytes: host.stopped_sandbox_bytes == null ? null : Number(host.stopped_sandbox_bytes),
          retentionSeconds: host.reported_retention_seconds ?? null,
          retentionOverrideSeconds: host.retention_seconds ?? null,
          nextCleanupAt: host.next_cleanup_at == null ? null : new Date(host.next_cleanup_at).toISOString(),
          canManageLimits: host.owner_id === actor.userId,
          limitsSupported: host.resource_policy_version === 1,
          sandboxes: host.sandboxes,
          version: host.daemon_version,
          versionStatus: dockerHostVersionStatus(host.daemon_version, host.pinned_version ?? undefined),
          protocol: host.daemon_protocol,
          updatePolicy: host.update_policy,
          pinnedVersion: host.pinned_version,
          updateRequested: host.update_requested,
          lastUpdateResult: isDockerHostUpdateResult(host.last_update_result) ? host.last_update_result : null,
          upgradeRequired: !supportsDockerHostProtocol(host.daemon_protocol),
        }));
      });
    },
    configureUpdate(
      actor: Actor,
      hostId: string,
      command: { policy: DockerHostUpdatePolicy; pinnedVersion: string | null } | "now",
    ) {
      return transaction(async (tx) => {
        const host = await owned(tx, actor, hostId);
        if (command === "now") {
          await tx.query("update public.docker_hosts set update_requested=true where id=$1", [host.id]);
        } else {
          await tx.query(
            "update public.docker_hosts set update_policy=$2,pinned_version=$3,update_requested=false where id=$1",
            [host.id, command.policy, command.pinnedVersion],
          );
        }
      });
    },
    updateOffer(
      hostToken: string,
      installationId: string,
      target: string,
      report: ReturnType<typeof parseDockerHostUpdateReport>,
    ) {
      return transaction(async (tx) => {
        const host = await authenticate(tx, hostToken, installationId);
        const row = (
          await tx.query<{
            update_policy: DockerHostUpdatePolicy;
            pinned_version: string | null;
            update_requested: boolean;
            draining: boolean;
          }>(
            `select update_policy,pinned_version,update_requested,(${hostDrainingSql("h")}) as draining
           from public.docker_hosts h where id=$1`,
            [host.id],
          )
        ).rows[0];
        if (!row) return deny();
        if (report) {
          const result = {
            ...report,
            at: report.at ?? new Date().toISOString(),
            daemonAt: report.at,
          } satisfies DockerHostUpdateResult & { daemonAt: string | null };
          await tx.query(
            `update public.docker_hosts set last_update_result=jsonb_set(
               $2::jsonb,'{daemonAt}',coalesce(to_jsonb($3::text),last_update_result->'daemonAt','null'::jsonb))
             where id=$1
             and (last_update_result->>'daemonAt' is null
               or (last_update_result->>'daemonAt')::timestamptz < $3::timestamptz
               or ($3::timestamptz is null and
                 string_to_array($2::jsonb->>'version','.')::integer[] >
                 string_to_array(last_update_result->>'version','.')::integer[]))
             and (last_update_result - array['at','daemonAt'] is distinct from $2::jsonb - array['at','daemonAt']
               or ($3::timestamptz is not null and last_update_result->>'daemonAt' is distinct from $2::jsonb->>'daemonAt'))`,
            [host.id, JSON.stringify(result), report.at],
          );
        }
        const offer =
          !row.draining &&
          (row.update_policy === "pinned"
            ? row.pinned_version === target
            : row.update_policy === "automatic" || row.update_requested);
        if (row.update_requested && offer)
          await tx.query("update public.docker_hosts set update_requested=false where id=$1", [host.id]);
        return { updatePolicy: row.update_policy, ...(offer ? { targetVersion: target } : {}) };
      });
    },
    setRetention(actor: Actor, hostId: string, retentionSeconds: number) {
      if (!Number.isInteger(retentionSeconds) || retentionSeconds < 0 || retentionSeconds > 31536000)
        throw new DockerLimitsRefused("invalid_request", "Retention must be 0..31536000 seconds.");
      return transaction(async (tx) => {
        id(actor.userId);
        id(actor.orgId);
        id(hostId);
        const member = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for share", [
          actor.orgId,
          actor.userId,
        ]);
        if (!member.rows.length) deny();
        const changed = await tx.query(
          "update public.docker_hosts set retention_seconds=$4,next_cleanup_at=null where id=$1 and org_id=$2 and owner_id=$3 and revoked_at is null returning id",
          [hostId, actor.orgId, actor.userId, retentionSeconds],
        );
        if (!changed.rows.length) deny();
        return { retentionSeconds };
      });
    },
    retentionForHost(
      hostToken: string,
      installationId: string,
      report?: {
        retentionSeconds: number;
        nextCleanupAt: string | null;
        /** The daemon's authoritative per-generation local cleanup deadlines. */
        deadlines?: { sandboxId: string; generation: string; deadline: string }[];
      },
    ) {
      return transaction(async (tx) => {
        const host = await reconcileHost(tx, hostToken, installationId);
        if (report) {
          await tx.query(
            "update public.docker_hosts set reported_retention_seconds=$2,next_cleanup_at=case when retention_seconds is null or retention_seconds=$2 then $3::timestamptz else null end where id=$1",
            [host.id, report.retentionSeconds, report.nextCleanupAt],
          );
          // A host that speaks this protocol reports every obligation it holds.
          // Clear deadlines it no longer holds (resumed, deleted, lost state) so a
          // stale one cannot fence a resume the daemon would never delete.
          if (report.deadlines) {
            await clearMissingDockerRetentionDeadlines(tx, host.id, report.deadlines);
          }
          // Persist the exact deadline the daemon will delete at, keyed to the
          // generation it belongs to. A stale report for a superseded generation
          // must not fence a newer one, so match on the current generation.
          for (const entry of report.deadlines ?? []) {
            id(entry.sandboxId);
            id(entry.generation);
            if (!Number.isFinite(Date.parse(entry.deadline))) deny();
            await recordDockerRetentionDeadline(tx, host.id, entry);
          }
        }
        const retention = await tx.query<{ retention_seconds: number | null }>(
          "select retention_seconds from public.docker_hosts where id=$1",
          [host.id],
        );
        return { hostId: host.id, retentionSeconds: retention.rows[0]?.retention_seconds ?? undefined };
      });
    },
    machineInventory(
      hostToken: string,
      installationId: string,
      serverUrl: string,
      report: readonly DockerInventoryContainer[],
      expectedHostId?: string,
    ) {
      return {
        async *listInventory(signal?: AbortSignal) {
          signal?.throwIfAborted();
          const entries = await transaction(async (tx) => {
            const { id: hostId } = await authenticate(tx, hostToken, installationId);
            if (expectedHostId && hostId !== expectedHostId) deny();
            const deploymentId = dockerInventoryDeploymentId(serverUrl, hostId, installationId);
            return Array.fromAsync(
              projectDockerMachineInventory(tx, { hostId, installationId, deploymentId }, report, signal),
            );
          });
          signal?.throwIfAborted();
          for (const entry of entries) {
            signal?.throwIfAborted();
            yield entry;
          }
        },
      } satisfies Required<Pick<Machine, "listInventory">>;
    },
    async inventoryOwnership(hostToken: string, installationId: string, sandboxIds: readonly string[]) {
      return transaction(async (tx) => {
        const host = await authenticate(tx, hostToken, installationId);
        const { rows } = await tx.query<{
          id: string;
          status: SandboxStatus;
          generation: string;
          provider_sandbox_id: string;
        }>(
          `select id,status,docker_generation as generation,provider_sandbox_id from public.sandboxes
           where provider='docker' and org_id=$1 and docker_host_id=$2 and docker_installation_id=$3
             and id=any($4::uuid[])
             and provider_sandbox_id=concat('armada-',docker_installation_id,'-',docker_host_id,'-',id,'-',docker_generation)`,
          [host.org_id, host.id, installationId, sandboxIds],
        );
        return { hostId: host.id, rows };
      });
    },
    /**
     * Read-only recheck for a held poll (#2561): whether polling could return work. It takes no lock and
     * writes nothing, so an idle held poll does not repeat their host
     * reconciliation and heartbeat writes every second; the caller runs the
     * full poll only when this is true. A false positive costs one full poll.
     */
    async mayHaveWork(
      hostToken: string,
      installationId: string,
      skipSnapshots: boolean,
      running: readonly string[],
      supportsPhysicalDelete = false,
      supportsRestore = false,
      supportsMachineBootstrap = false,
    ): Promise<boolean> {
      return transaction(async (tx) => {
        const result = await tx.query<{ found: boolean }>(
          `select exists(select 1 from public.docker_host_jobs j join public.docker_hosts h on h.id=j.host_id
             where h.hash=$1 and h.installation_id=$2 and h.revoked_at is null and j.outcome is null
               and (not $3::boolean or j.snapshot_id is null) and ${notRunning(4)} and ${eligibleJob(5, 6, 7)}) as found`,
          [
            hash(hostToken),
            installationId,
            skipSnapshots,
            running,
            supportsPhysicalDelete,
            supportsRestore,
            supportsMachineBootstrap,
          ],
        );
        return result.rows[0]?.found === true;
      });
    },
    restoreRecoveryForHost(hostToken: string, installationId: string, running: readonly string[]) {
      return transaction(async (tx) => {
        const host = await reconcileHost(tx, hostToken, installationId);
        const {
          rows: [row],
        } = await tx.query<StoredJob>(
          `select h.* from public.docker_host_jobs h
           join public.docker_machine_bindings b on b.daemon_generation=h.request_id and b.host_id=h.host_id
           join public.jobs j on j.sandbox_id=b.sandbox_id and j.generation=b.machine_generation and j.kind='resume'
           where h.host_id=$1 and h.bound_operation='restore' and h.cancelled_at is not null
             and b.installation_id=$2 and b.sandbox_id=h.bound_sandbox_id and not(h.request_id=any($3::uuid[]))
             and coalesce(j.outcome->'evidence',j.outcome)->>'restoreDelivered'='true'
           order by h.position limit 1`,
          [host.id, installationId, running],
        );
        if (!row) return undefined;
        const job = await readJob(row);
        if (job.operation !== "restore") deny();
        return job;
      });
    },
    /** Every generation with a queued resume/bootstrap, so the daemon fences all of them, not only the head job. */
    pendingStartsForHost(hostToken: string, installationId: string, supportsRestore = false) {
      return transaction(async (tx) => {
        const host = await reconcileHost(tx, hostToken, installationId);
        const rows = (
          await tx.query<{ bound_sandbox_id: string; docker_generation: string }>(
            `select distinct s.id as bound_sandbox_id,s.docker_generation
             from public.docker_host_jobs j join public.sandboxes s on s.id=j.bound_sandbox_id
             where j.host_id=$1 and j.outcome is null and j.bound_operation ='bootstrap'
               and s.provider='docker' and s.docker_host_id=$1 and s.docker_installation_id=$2
             order by s.id`,
            [host.id, installationId],
          )
        ).rows;
        const pending = new Map(
          rows.map(({ bound_sandbox_id: sandboxId, docker_generation: generation }) => [
            `${sandboxId}/${generation}`,
            { sandboxId, generation },
          ]),
        );
        if (supportsRestore) {
          const restores = await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j
             where j.host_id=$1 and j.bound_operation='restore' and j.outcome is null order by j.position`,
            [host.id],
          );
          for (const row of restores.rows) {
            try {
              const job = await admitRestore(tx, row, host, installationId);
              for (const { sandboxId, generation } of [job.request, job.predecessor.request]) {
                pending.set(`${sandboxId}/${generation}`, { sandboxId, generation });
              }
            } catch (error) {
              if (!(error instanceof DockerHostDenied)) throw error;
            }
          }
        }
        return [...pending.values()];
      });
    },
    limitsForHost(hostToken: string, installationId: string) {
      return transaction(async (tx) => {
        const host = await reconcileHost(tx, hostToken, installationId);
        const row = (
          await tx.query<DockerPolicyRow>(
            "select machine_cpus,machine_memory_bytes,sandbox_cpus,sandbox_memory_bytes,max_sandboxes,available_cpus,available_memory_bytes from public.docker_hosts where id=$1",
            [host.id],
          )
        ).rows[0]!;
        try {
          return hostResourcePolicy(row)?.perSandbox;
        } catch (error) {
          if (error instanceof DockerLimitsRefused) return undefined;
          throw error;
        }
      });
    },
    setLimits(actor: Actor, hostId: string, patch: DockerResourceOverrides & { auto?: true }) {
      return transaction(async (tx) => {
        exact(actor, ["userId", "orgId"]);
        id(actor.userId);
        id(actor.orgId);
        id(hostId);
        if (
          !patch ||
          typeof patch !== "object" ||
          Array.isArray(patch) ||
          Object.keys(patch).some((k) => !["cpus", "memoryBytes", "maxSandboxes", "auto"].includes(k)) ||
          Object.keys(patch).length === 0 ||
          (patch.auto !== undefined && (patch.auto !== true || Object.keys(patch).length !== 1))
        )
          throw new DockerLimitsRefused("invalid_request", "Provide CPU, memory or max sandboxes, or auto alone.");
        if (Object.entries(patch).some(([key, value]) => key !== "auto" && typeof value !== "number"))
          throw new DockerLimitsRefused("invalid_request", "Resource overrides must be numbers.");
        const member = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for update", [
          actor.orgId,
          actor.userId,
        ]);
        if (!member.rows.length) deny();
        const host =
          (
            await tx.query<DockerPolicyRow & { resource_policy_version: number | null }>(
              "select machine_cpus,machine_memory_bytes,sandbox_cpus,sandbox_memory_bytes,max_sandboxes,resource_policy_version,available_cpus,available_memory_bytes from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3 and revoked_at is null for update",
              [hostId, actor.orgId, actor.userId],
            )
          ).rows[0] ?? deny();
        if (host.resource_policy_version !== 1 || host.machine_cpus == null || host.machine_memory_bytes == null)
          throw new DockerLimitsRefused(
            "conflict",
            "Unknown resource policy support — upgrade the host and wait for its heartbeat.",
          );
        const busy = (
          await tx.query<{ running: string; pending: boolean }>(
            `select (${DOCKER_CAPACITY_USAGE_SQL}) as running, exists(select 1 from public.docker_host_jobs j
            where j.host_id=h.id and j.outcome is null) as pending from public.docker_hosts h where h.id=$1`,
            [hostId],
          )
        ).rows[0]!;
        const next = patch.auto
          ? {}
          : {
              ...(host.sandbox_cpus == null ? {} : { cpus: Number(host.sandbox_cpus) }),
              ...(host.sandbox_memory_bytes == null ? {} : { memoryBytes: Number(host.sandbox_memory_bytes) }),
              ...(host.max_sandboxes == null ? {} : { maxSandboxes: host.max_sandboxes }),
              ...patch,
            };
        let resources: ReturnType<typeof dockerResourcePolicy>;
        try {
          resources = dockerResourcePolicy(
            { cpus: Number(host.machine_cpus), memoryBytes: Number(host.machine_memory_bytes) },
            next,
          );
        } catch (error) {
          throw new DockerLimitsRefused(
            "invalid_request",
            error instanceof Error ? error.message : "Invalid resource limits.",
          );
        }
        const current = (() => {
          try {
            return hostResourcePolicy(host);
          } catch {
            return null;
          }
        })();
        const resourceChange =
          !current ||
          current.perSandbox.cpus !== resources.perSandbox.cpus ||
          current.perSandbox.memoryBytes !== resources.perSandbox.memoryBytes;
        if (resourceChange && (Number(busy.running) > 0 || busy.pending))
          throw new DockerLimitsRefused(
            "conflict",
            "Stop all host sandboxes and finish pending jobs/builds before changing CPU or memory limits.",
          );
        if (Number(busy.running) > resources.capacity)
          throw new DockerLimitsRefused(
            "conflict",
            "Stop sandboxes before lowering capacity below current running reservations.",
          );
        await tx.query(
          "update public.docker_hosts set sandbox_cpus=$2,sandbox_memory_bytes=$3,max_sandboxes=$4 where id=$1",
          [hostId, next.cpus ?? null, next.memoryBytes ?? null, next.maxSandboxes ?? null],
        );
        return {
          resources: hostResourcePolicy(
            {
              ...host,
              sandbox_cpus: next.cpus ?? null,
              sandbox_memory_bytes: next.memoryBytes ?? null,
              max_sandboxes: next.maxSandboxes ?? null,
            },
            Number(busy.running),
          )!,
        };
      });
    },
    issueRegistration(actor: Actor, name?: string) {
      if (
        name !== undefined &&
        (typeof name !== "string" || name !== name.trim() || !name || name.length > 64 || /[\p{C}]/u.test(name))
      )
        deny();
      return transaction(async (tx) => {
        await admin(tx, actor);
        const hostId = randomUUID(),
          registrationToken = randomBytes(32).toString("hex");
        const issued = await tx.query<{ registration_expires_at: Date | string }>(
          `insert into public.docker_hosts(id,org_id,owner_id,registration_hash,registration_expires_at,name)
          values($1,$2,$3,$4,now()+interval '5 minutes',$5) returning registration_expires_at`,
          [hostId, actor.orgId, actor.userId, hash(registrationToken), name ?? null],
        );
        return {
          hostId,
          registrationToken,
          expiresAt: new Date(issued.rows[0]!.registration_expires_at).toISOString(),
        };
      });
    },
    exchangeRegistration(registrationToken: string, installationId: string) {
      return transaction(async (tx) => {
        id(installationId);
        const result = await tx.query<Host>(
          `select id,org_id,owner_id from public.docker_hosts
          where registration_hash=$1 and registration_expires_at>now() and revoked_at is null`,
          [hash(registrationToken)],
        );
        const host = result.rows[0] ?? deny();
        await admin(tx, { userId: host.owner_id, orgId: host.org_id });
        const locked = await tx.query<Host>(
          `select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
           and registration_hash=$4 and registration_expires_at>now() and revoked_at is null for update`,
          [host.id, host.org_id, host.owner_id, hash(registrationToken)],
        );
        if (!locked.rows.length) deny();
        const hostToken = randomBytes(32).toString("hex");
        await tx.query(`update public.docker_hosts set registration_hash=null,installation_id=$2,hash=$3 where id=$1`, [
          host.id,
          installationId,
          hash(hostToken),
        ]);
        return { hostId: host.id, hostToken };
      });
    },
    reuseRegistration(registrationToken: string, existingHostId: string) {
      return transaction(async (tx) => {
        id(existingHostId);
        const tokenHash = hash(registrationToken);
        const pending = await tx.query<Host>(
          `select id,org_id,owner_id from public.docker_hosts
           where registration_hash=$1 and registration_expires_at>now() and revoked_at is null
             and installation_id is null and hash is null`,
          [tokenHash],
        );
        const ticket = pending.rows[0] ?? deny();
        // Match exchangeRegistration's membership -> host lock order and recheck
        // after locking: concurrent token exchange/revocation cannot reuse authority.
        await admin(tx, { userId: ticket.owner_id, orgId: ticket.org_id });
        const locked = await tx.query<Host>(
          `select id,org_id,owner_id from public.docker_hosts
           where id=$1 and org_id=$2 and owner_id=$3 and registration_hash=$4
             and registration_expires_at>now() and revoked_at is null
             and installation_id is null and hash is null for update`,
          [ticket.id, ticket.org_id, ticket.owner_id, tokenHash],
        );
        if (!locked.rows.length) deny();
        const target = await tx.query<{ id: string; name: string | null }>(
          `select id,name from public.docker_hosts
           where id=$1 and org_id=$2 and owner_id=$3 and installation_id is not null
             and hash is not null and registration_hash is null and revoked_at is null for update`,
          [existingHostId, ticket.org_id, ticket.owner_id],
        );
        const host = target.rows[0] ?? deny();
        // Cancel only the unused ticket. Existing machine authority is immutable.
        await tx.query(
          `update public.docker_hosts set registration_hash=null,registration_expires_at=now() where id=$1`,
          [ticket.id],
        );
        return { hostId: host.id, name: host.name };
      });
    },
    revoke(actor: Actor, hostId: string) {
      return transaction(async (tx) => {
        await owned(tx, actor, hostId);
        // Revocation fences authentication, so queued startup and snapshot work can
        // never be dispatched. Retire it now instead of leaving sandboxes starting
        // and capacity reserved forever; physical cleanup remains an admin action.
        await retireUndispatchable(tx, hostId, {
          sandbox: DOCKER_LAUNCH_FAILURE_MESSAGES.hostUnavailable,
          snapshot: DOCKER_SNAPSHOT_FAILURE_MESSAGES.retired,
        });
        await tx.query(`update public.docker_hosts set revoked_at=now(),registration_hash=null where id=$1`, [hostId]);
      });
    },
    enqueueSnapshot(actor: Actor, hostId: string, job: Extract<Job, { operation: "buildSnapshot" }>) {
      return transaction(async (tx) => {
        exact(actor, ["userId", "orgId"]);
        id(actor.userId);
        id(actor.orgId);
        id(hostId);
        input(job);
        const hint =
          (
            await tx.query<Host>("select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2", [
              hostId,
              actor.orgId,
            ])
          ).rows[0] ?? deny();
        await tx.query(
          "select user_id from public.members where org_id=$1 and user_id in ($2,$3) order by user_id for update",
          [actor.orgId, actor.userId, hint.owner_id],
        );
        const host =
          (
            await tx.query<Host & { installation_id: string }>(
              `select id,org_id,owner_id,installation_id from public.docker_hosts where id=$1 and org_id=$2 and hash is not null and revoked_at is null and not ${hostDrainingSql("docker_hosts")} for update`,
              [hostId, actor.orgId],
            )
          ).rows[0] ?? deny();
        const snapshot = await authorizeSnapshotBuild(tx, host.id, host.installation_id, job);
        if (snapshot.owner_id !== actor.userId) deny();
        return insert(tx, host.id, job, {
          snapshot_id: snapshot.id,
          bound_sandbox_id: null,
          bound_actor_id: actor.userId,
          bound_actor_epoch: String(snapshot.actor_epoch),
          bound_operation: "buildSnapshot",
        });
      });
    },
    enqueueStop(
      actor: Actor,
      sandboxId: string,
      requestId: string | undefined,
      options: { checkpoint?: string; idleSequence?: string } = {},
    ) {
      if (requestId !== undefined) id(requestId);
      return transaction(async (tx) => {
        const { host, row } = await lockSandboxAdmission(tx, actor, sandboxId, "stop");
        const actorEpoch = await permission(tx, actor, row, "stop");
        if (row.deleted_at !== null || row.status === "stopped" || row.stopped_at != null) return null;
        const request =
          requestId && !options.checkpoint
            ? { ownerId: actor.userId, digest: `${sandboxId}:${options.idleSequence !== undefined}` }
            : undefined;
        const {
          rows: [prior],
        } = await tx.query<{ id: string; state: string; idem_key: string; request_digest: string | null }>(
          `select id,state,idem_key,request_digest from public.jobs where sandbox_id=$1 and generation=$2 and kind='stop'
           and state in ('queued','leased','failed') order by (state='failed'),created_at desc,id desc limit 1`,
          [row.id, row.lifecycle_generation],
        );
        if (prior && prior.state !== "failed") {
          if (
            request &&
            requestId &&
            (prior.idem_key !== jobRequestKey(actor.orgId, "stop", actor.userId, requestId) ||
              prior.request_digest !== request.digest)
          )
            deny();
          return prior.id;
        }
        if (host.draining) throw new DockerHostDraining();
        const inFlight = await tx.query(
          `select 1 from public.docker_host_jobs where bound_sandbox_id=$1 and host_id=$2
           and bound_operation='stop' and outcome is null limit 1`,
          [row.id, host.id],
        );
        if (inFlight.rows.length) deny();
        const proof = options.checkpoint ? await checkpointedStop(tx, row, options.checkpoint) : undefined;
        if (options.idleSequence !== undefined) await assertIdleStop(tx, row, host.id, options.idleSequence);
        const machineId = await allocationReceipt(tx, row);
        const bound = machineId && (await currentMachineCleanup(tx, row));
        const resume = await tx.query(
          "select 1 from public.jobs where kind='resume' and sandbox_id=$1 and generation between $2::bigint-case when $3::boolean then 1 else 0 end and $2::bigint",
          [row.id, row.lifecycle_generation, row.status === "failed"],
        );
        if (!bound && row.status !== "starting" && !resume.rows.length) deny();
        const previous = bound ? await machineCleanupReceipt(tx, row, "stop") : undefined;
        const retryAfter =
          previous?.outcome === "failed" && !previous.cancelled_at && previous.retain ? previous.request_id : undefined;
        const deadline = new Date(Date.now() + 120_000);
        const exitPending = ["failed", "stopping"].includes(row.status);
        const payload: DockerStopIntent = {
          actor,
          actorEpoch,
          ...(bound && machineId && !resume.rows.length ? { machineId, daemonGeneration: row.docker_generation } : {}),
          generation: requireGenerationHeadroom(row.lifecycle_generation, exitPending ? 0 : 2),
          ...(exitPending ? { exitPending: true } : {}),
          ...(retryAfter ? { retryAfter } : {}),
          hostId: host.id,
          installationId: row.docker_installation_id,
          captureUntil: deadline.getTime() - 98_000,
          ...(proof && options.checkpoint
            ? {
                checkpoint: options.checkpoint,
                workMerged: proof.work_merged,
                runtimeEpoch: proof.epoch,
              }
            : options),
        };
        return createJobsStore(sql, key).enqueue(
          "stop",
          sandboxId,
          payload.generation,
          options.checkpoint && prior ? `${options.checkpoint}:${prior.id}` : (requestId ?? randomUUID()),
          payload,
          {
            orgId: actor.orgId,
            maxAttempts: 8,
            deadline,
            ...(request ? { request } : {}),
          },
          tx,
        );
      });
    },
    async pendingLaunchPrompt(sandboxId: string, intent: DockerStopIntent, tx: Sql = sql) {
      const { rows } = await tx.query(
        `select 1 from public.jobs launch
         join public.runtime_enrolments e on e.sandbox_id=launch.sandbox_id and e.lifecycle_generation=launch.generation
         join public.runtime_commands c on c.sandbox_id=e.sandbox_id and c.epoch=e.epoch
         where launch.sandbox_id=$1 and launch.generation=$2 and launch.kind='launch'
           and launch.state in ('queued','leased') and launch.outcome ? 'docker_actor_epoch'
           and launch.outcome->>'docker_receipt' is null and e.runtime_hash is not null
           and starts_with(c.request_id,'docker_prompt_')
           and clock_timestamp()<to_timestamp($3::double precision/1000) limit 1`,
        [sandboxId, intent.generation, intent.captureUntil],
      );
      return rows.length > 0;
    },
    async lockStop(tx: Sql, sandboxId: string, intent: DockerStopIntent) {
      const { host, row } = await lockSandboxAdmission(tx, intent.actor, sandboxId, "stop", intent);
      await permission(tx, intent.actor, row, "stop", intent.actorEpoch);
      if (
        String(row.lifecycle_generation) !== String(intent.generation) ||
        (intent.daemonGeneration !== undefined && row.docker_generation !== intent.daemonGeneration)
      )
        deny();
      if (intent.checkpoint) {
        const proof = await checkpointedStop(tx, row, intent.checkpoint);
        if (proof.work_merged !== intent.workMerged || proof.epoch !== intent.runtimeEpoch) deny();
      }
      if (intent.idleSequence !== undefined) await assertIdleStop(tx, row, host.id, intent.idleSequence);
      if (await store.pendingLaunchPrompt(sandboxId, intent, tx)) throw new DockerMachinePending("pending");
      const restored = await reconcileRestoreStop(tx, row);
      if (restored !== undefined) return restored;
      const machineGeneration = Number(await currentMachineCleanup(tx, row));
      const machineId = await allocationReceipt(tx, row);
      if (!machineId || !Number.isSafeInteger(machineGeneration)) {
        if (
          row.status === "starting" &&
          !(
            await tx.query(
              "select 1 from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation in ('create','restore') limit 1",
              [sandboxId],
            )
          ).rows.length
        )
          return null;
        throw new DockerMachinePending("unknown");
      }
      if (intent.machineId && intent.machineId !== machineId) deny();
      return { machineId, generation: machineGeneration };
    },
    stopOutcome(sandboxId: string, generation: string, intent: DockerStopIntent) {
      return transaction(async (tx) => {
        const row = (
          await tx.query<Sandbox>(
            `select * from public.sandboxes where id=$1 and provider='docker' and lifecycle_generation=$2
            and status in ('stopping','stopped','failed') and docker_host_id=$3 and docker_installation_id=$4 and docker_generation=coalesce($5,docker_generation) for update`,
            [sandboxId, generation, intent.hostId, intent.installationId, intent.daemonGeneration ?? null],
          )
        ).rows[0];
        if (!row) return "unknown";
        if (row.stopped_at != null) return "stopped";
        const machineId = await allocationReceipt(tx, row);
        if (!machineId || (intent.machineId && machineId !== intent.machineId)) return "unknown";
        const receipt = await machineCleanupReceipt(tx, row, "stop");
        if (!receipt || receipt.request_id === intent.retryAfter) return "unknown";
        if (receipt.outcome === "failed" || receipt.cancelled_at) return "refused";
        if (receipt.outcome !== "completed") return "unknown";
        if (!receipt.retain) return "refused";
        if (receipt.absent_machine_id === machineId) return "retention_lost";
        if (receipt.absent_machine_id || (await physicalRemovalReceipt(tx, row, machineId))) return "refused";
        if (!receipt.result_machine_id) return "retention_unknown";
        return receipt.result_machine_id === machineId ? "stopped" : "refused";
      });
    },
    machineCleanup(actor: Actor, scope?: MachineHost & { retryAfter?: string }) {
      const unknown = { kind: "unknown" } as const;
      return {
        async observe(request) {
          request.signal?.throwIfAborted();
          return transaction<MachineObservation>(async (tx) => {
            const { host, row } = await lockSandboxAdmission(tx, actor, request.sandboxId, "stop", scope);
            await permission(tx, actor, row, "stop", scope?.actorEpoch);
            if (host.revoked) return unknown;
            if (
              scope &&
              !(
                await tx.query(
                  `select 1 from public.docker_hosts where id=$1 and last_seen_at>=now()-interval '60 seconds'`,
                  [host.id],
                )
              ).rows.length
            )
              return unknown;
            const machineId = await allocationReceipt(tx, row);
            if (!machineId || (await currentMachineCleanup(tx, row)) !== String(request.generation))
              return scope ? observedAllocation(tx, row, request) : unknown;
            if (request.machineId !== undefined && request.machineId !== machineId) return unknown;
            const removal = await machineCleanupReceipt(tx, row, "delete");
            if (removal) {
              return removal.outcome === "completed" && !removal.cancelled_at
                ? { kind: "absent", receipt: { operation: "delete" } }
                : unknown;
            }
            const physical = await physicalRemovalReceipt(tx, row, machineId);
            if (physical)
              return scope && physical.outcome === "completed" && !physical.cancelled_at
                ? { kind: "absent", receipt: { operation: "delete" } }
                : unknown;
            if (row.status === "deleted") return unknown;
            const stopped = await machineCleanupReceipt(tx, row, "stop");
            if (!stopped) return scope ? observedAllocation(tx, row, request) : unknown;
            if (
              stopped.outcome !== "completed" ||
              stopped.retain !== true ||
              stopped.cancelled_at ||
              stopped.result_machine_id !== machineId
            )
              return unknown;
            const machine = { sandboxId: request.sandboxId, generation: request.generation, machineId };
            return {
              kind: "present",
              machine,
              phase: "stopped",
              receipt: {
                operation: "stop",
                retained: {
                  sandboxId: machine.sandboxId,
                  generation: machine.generation,
                  kind: "container",
                  ref: machineId,
                },
              },
            };
          }).catch((error: unknown) => {
            if (scope && (error instanceof DockerHostDenied || error instanceof DockerHostUnavailable)) return unknown;
            throw error;
          });
        },
        async stop(request) {
          request.signal?.throwIfAborted();
          const result = await transaction(async (tx) => {
            const { sandboxId, generation, machineId, retain } = request;
            const { host, row } = await lockSandboxAdmission(tx, actor, sandboxId, "stop", scope);
            const epoch = await permission(tx, actor, row, "stop", scope?.actorEpoch);
            if (
              !/^[a-f0-9]{64}$/.test(machineId) ||
              (await allocationReceipt(tx, row)) !== machineId ||
              (await currentMachineCleanup(tx, row)) !== String(generation)
            )
              deny();
            const stopped = await machineCleanupReceipt(tx, row, "stop");
            if (stopped && stopped.retain !== retain) deny();
            const removal = await machineCleanupReceipt(tx, row, "delete");
            if (removal) return !retain && removal.outcome === "completed" && !removal.cancelled_at ? null : undefined;
            if (row.status === "deleted") deny();
            if (stopped?.outcome === "completed" && !stopped.cancelled_at && retain) {
              if (
                host.revoked ||
                stopped.result_machine_id !== machineId ||
                (await physicalRemovalReceipt(tx, row, machineId))
              )
                return undefined;
              return { sandboxId, generation, kind: "container" as const, ref: machineId };
            }
            const retryAfter =
              stopped?.outcome === "failed" &&
              !stopped.cancelled_at &&
              stopped.retain &&
              scope?.retryAfter === stopped.request_id
                ? stopped.request_id
                : undefined;
            if (stopped && !retryAfter && (stopped.outcome !== "completed" || stopped.cancelled_at)) return undefined;
            const operation = stopped && !retryAfter ? "delete" : "stop";
            const allocation = await machine(tx, row, operation);
            request.signal?.throwIfAborted();
            await insert(
              tx,
              host.id,
              {
                requestId: dockerMachineJobId(retryAfter ?? row.docker_generation, operation),
                operation,
                request: allocation,
              },
              {
                bound_sandbox_id: sandboxId,
                bound_actor_id: actor.userId,
                bound_actor_epoch: epoch,
                bound_operation: operation,
              },
              String(generation),
              undefined,
              operation === "stop" ? retain : undefined,
              undefined,
              retryAfter,
            );
            return undefined;
          });
          if (result === undefined) {
            if (scope) throw new DockerMachinePending("unknown");
            throw new Error("Docker Machine stop outcome is unknown.");
          }
          return result;
        },
      } satisfies Pick<Machine, "stop" | "observe">;
    },
    async submitMachineCreate(actor: Actor, request: Parameters<Machine["create"]>[0], scope?: MachineHost) {
      const { sandboxId, generation, source, computeTtlSeconds, signal } = request;
      signal?.throwIfAborted();
      return transaction<MachineCreateResult>(async (tx) => {
        if (!Number.isSafeInteger(generation) || generation < 1 || request.size !== null) deny();
        const { host, row } = await lockSandboxAdmission(tx, actor, sandboxId, "create", scope);
        if (
          String(row.lifecycle_generation) !== String(generation) ||
          !(await matchesMachineCreateGeneration(tx, row, row.docker_generation))
        )
          deny();
        const epoch = await permission(tx, actor, row, "create");
        const requestId = row.docker_generation;
        const existing = (
          await tx.query<StoredJob>(
            `select * from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='create'`,
            [sandboxId],
          )
        ).rows[0];
        if (existing && existing.request_id !== requestId) deny();
        if (!existing) {
          await fenceFreshStartup(tx, row);
          await refuseDraining(tx, host.id);
          await state(tx, row, "create");
          if (scope?.canDispatch && !(await scope.canDispatch(tx, epoch))) deny();
        }
        const allocation = await machine(tx, row, "create");
        if (
          allocation.ttlSeconds !== computeTtlSeconds ||
          (allocation.snapshot
            ? source.kind !== "snapshot" || source.ref !== allocation.snapshot.id
            : source.kind !== "image" || source.ref !== allocation.image)
        )
          deny();
        signal?.throwIfAborted();
        await insert(
          tx,
          host.id,
          { operation: "create", requestId, request: allocation },
          {
            bound_sandbox_id: sandboxId,
            bound_actor_id: actor.userId,
            bound_actor_epoch: epoch,
            bound_operation: "create",
          },
        );
        if (!existing || existing.outcome === null) return { kind: "pending" };
        if (existing.cancelled_at !== null || existing.outcome !== "completed" || !existing.result_machine_id)
          return { kind: "unknown" };
        return { kind: "completed", machine: { sandboxId, generation, machineId: existing.result_machine_id } };
      });
    },
    async resumeMachineTarget(actor: Actor, claim: RestoreClaim) {
      return transaction(async (tx) => {
        const { host, row } = await lockSandboxAdmission(tx, actor, claim.sandbox_id ?? deny(), "restore");
        if (String(row.lifecycle_generation) !== claim.generation) deny();
        await requireRestoreRunner(tx, claim.id, row, claim.lease_epoch);
        const receipt = await machineJob(tx, row, row.docker_generation, "restore");
        const saved = receipt && (await readStoredJob(receipt));
        const prior =
          saved?.runnerJobId === claim.id && saved.job.operation === "restore" ? saved.job.predecessor : undefined;
        const source = prior?.request.generation ?? row.docker_generation;
        const machineId = prior?.machineId ?? (await allocationReceipt(tx, row));
        const binding = (
          await tx.query<{ generation: string }>(
            `select machine_generation::text as generation from public.docker_machine_bindings
             where sandbox_id=$1 and host_id=$2 and installation_id=$3 and daemon_generation=$4`,
            [row.id, host.id, row.docker_installation_id, source],
          )
        ).rows[0];
        if (!binding || !machineId || BigInt(binding.generation) >= BigInt(row.lifecycle_generation)) deny();
        return {
          hostId: host.id,
          installationId: row.docker_installation_id,
          ttl: row.effective_ttl_seconds,
          expiresAt: new Date(row.expires_at).getTime(),
          predecessor: {
            kind: "container" as const,
            sandboxId: row.id,
            generation: Number(binding.generation),
            ref: machineId,
          },
        };
      });
    },
    async attachMachineRestore(
      actor: Actor,
      claim: RestoreClaim,
      intent?: { scope: MachineHost; request: Parameters<Machine["resume"]>[0] },
    ) {
      const result = await transaction(async (tx) => {
        const { host, row } = await lockSandboxAdmission(
          tx,
          actor,
          claim.sandbox_id ?? deny(),
          "restore",
          intent?.scope,
        );
        const generation = Number(claim.generation);
        if (
          !Number.isSafeInteger(generation) ||
          generation < 1 ||
          String(row.lifecycle_generation) !== claim.generation
        )
          deny();
        const bindings = createDockerMachineGenerationBindings(tx, {
          hostId: host.id,
          installationId: row.docker_installation_id,
        });
        await requireRestoreRunner(tx, claim.id, row, claim.lease_epoch);
        const incarnation = { sandboxId: row.id, generation };
        const requestId = intent ? await bindings.bind(incarnation) : ((await bindings.lookup(incarnation)) ?? deny());
        const receipt = (
          await tx.query<StoredJob>(
            `select * from public.docker_host_jobs
             where request_id=$1 and host_id=$2 and bound_sandbox_id=$3 and bound_operation='restore'`,
            [requestId, host.id, row.id],
          )
        ).rows[0];
        if (!receipt && intent) {
          const { request, scope } = intent;
          const predecessor = request.predecessor;
          if (
            request.sandboxId !== row.id ||
            request.generation !== generation ||
            request.size !== null ||
            request.computeTtlSeconds !== row.effective_ttl_seconds ||
            predecessor.sandboxId !== row.id ||
            predecessor.generation >= generation ||
            predecessor.kind !== "container" ||
            (await bindings.lookup(predecessor)) !== row.docker_generation ||
            (await allocationReceipt(tx, row)) !== predecessor.ref
          )
            deny();
          const epoch = await permission(tx, actor, row, "restore");
          await fenceFreshStartup(tx, row);
          await requireRestoreRunner(tx, claim.id, row);
          await refuseDraining(tx, host.id);
          await admitDockerCapacity(tx, host.id);
          if (scope.canDispatch && !(await scope.canDispatch(tx, epoch))) deny();
          const source = await machine(tx, row, "restore");
          request.signal?.throwIfAborted();
          await enqueueRestore(
            tx,
            row,
            {
              operation: "restore",
              requestId,
              request: {
                ...source,
                generation: requestId,
                ttlSeconds: request.computeTtlSeconds,
                expiresAt: new Date(row.expires_at).getTime(),
              },
              predecessor: { request: source, machineId: predecessor.ref },
            },
            {
              bound_sandbox_id: row.id,
              bound_actor_id: actor.userId,
              bound_actor_epoch: epoch,
              bound_operation: "restore",
            },
            claim.id,
          );
          return "pending" as const;
        }
        if (!receipt || receipt.cancelled_at !== null) deny();
        const { job, runnerJobId } = await readStoredJob(receipt, row.lifecycle_generation);
        if (
          job.operation !== "restore" ||
          job.request.generation !== requestId ||
          runnerJobId !== claim.id ||
          receipt.bound_actor_id !== actor.userId ||
          receipt.bound_actor_epoch == null
        )
          deny();
        await permission(tx, actor, row, "restore", receipt.bound_actor_epoch);
        await refuseDraining(tx, host.id);
        await requireRestoreBindings(tx, row, job);
        if (intent) {
          const { request } = intent;
          const source = await bindings.lookup(request.predecessor);
          if (
            request.sandboxId !== row.id ||
            request.generation !== generation ||
            request.size !== null ||
            request.computeTtlSeconds !== job.request.ttlSeconds ||
            request.predecessor.sandboxId !== row.id ||
            request.predecessor.kind !== "container" ||
            request.predecessor.ref !== job.predecessor.machineId ||
            source !== job.predecessor.request.generation
          )
            deny();
          if (intent.scope.canDispatch && !(await intent.scope.canDispatch(tx, String(receipt.bound_actor_epoch))))
            deny();
          request.signal?.throwIfAborted();
        }
        if (intent && receipt.outcome === null) return "pending" as const;
        if (intent && receipt.outcome === "completed" && !receipt.result_machine_id)
          throw new DockerMachinePending("unknown");
        if (receipt.outcome !== "completed" || !receipt.result_machine_id) deny();
        const placement = await attachDockerRestorePlacement(tx, claim, {
          hostId: host.id,
          installationId: row.docker_installation_id,
          predecessor: job.predecessor.request.generation,
          replacement: requestId,
        });
        if (!placement) deny();
        return {
          sandboxId: row.id,
          generation,
          machineId: receipt.result_machine_id,
        } satisfies MachineIdentity;
      });
      if (result === "pending") throw new DockerMachinePending("pending");
      return result;
    },
    enqueueCleanup(
      actor: Actor,
      sandboxId: string,
      selection: { operation: MachineCleanupOperation; requestId?: string | undefined },
      authorizeDelete?: (tx: Sql) => Promise<void>,
    ) {
      return transaction(async (tx) => {
        const { operation } = selection;
        if (!isCleanupOperation(operation)) deny();
        if (operation === "delete")
          await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
            `docker-cleanup:${sandboxId}:delete`,
          ]);
        const admission = await lockSandboxAdmission(tx, actor, sandboxId, operation);
        const { host } = admission;
        let { row } = admission;
        if (operation === "delete") {
          await authorizeDelete?.(tx);
          if (await reconcileRestoreStop(tx, row)) row = await sandbox(tx, sandboxId, host, row.docker_installation_id);
        }
        const epoch = await permission(tx, actor, row, operation);
        let requestId = selection.requestId;
        if (operation === "delete") {
          const {
            rows: [pending],
          } = await tx.query<{ request_id: string; bound_actor_id: string }>(
            `select request_id,bound_actor_id from public.docker_host_jobs where bound_sandbox_id=$1
             and bound_operation='delete' and outcome is null order by position limit 1`,
            [sandboxId],
          );
          if (pending) {
            if (!authorizeDelete) return { requestId: pending.request_id };
            if (pending.bound_actor_id !== actor.userId || (requestId && requestId !== pending.request_id))
              throw new VaultError("conflict", "Docker sandbox cleanup is pending. Retry the same request.");
            requestId = pending.request_id;
          }
        }
        requestId ??= randomUUID();
        id(requestId);
        const known =
          (await tx.query("select 1 from public.docker_host_jobs where request_id=$1", [requestId])).rows.length > 0;
        if (!known) await state(tx, row, operation);
        if (!known && host.draining && operation === "stop" && ["starting", "ready", "running"].includes(row.status)) {
          requireGenerationHeadroom(row.lifecycle_generation, 2);
          const result = await transitionSandbox(tx, {
            sandboxId,
            expectedGeneration: row.lifecycle_generation,
            fromStates: ["starting", "ready", "running"],
            toState: "stopping",
            actor: "owner",
            code: "docker_stop_admitted",
            effects: [],
          });
          if (result.kind === "conflict") deny();
        }
        return writeBoundCleanup(tx, row, operation, requestId, actor.userId, epoch);
      });
    },
    async unregister(hostToken: string, installationId: string): Promise<boolean> {
      const drain = await transaction(async (tx) => {
        id(installationId);
        const host = await reconcileHost(tx, hostToken, installationId);
        const members = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2", [
          host.org_id,
          host.owner_id,
        ]);
        // A retried uninstall continues the same drain; the flag fences admission until the
        // uninstall completes, with no deadline that could re-admit work while cleanup is queued.
        await tx.query(`update public.docker_hosts set draining_at=now() where id=$1`, [host.id]);
        await tx.query(
          `update public.docker_host_jobs set outcome='failed',completed_at=now(),cancelled_at=now()
           where host_id=$1 and outcome is null and bound_operation in ('deletePhysical','restore')`,
          [host.id],
        );
        const retained = await tx.query<{ id: string; status: string }>(
          `select id,status from public.sandboxes where docker_host_id=$1 and status<>'deleted' order by id`,
          [host.id],
        );
        // Retirement must not wait forever on launch work that can no longer be
        // dispatched. This is cancellation, never evidence of physical cleanup.
        const active = await tx.query("select 1 from public.docker_hosts where id=$1 and revoked_at is null", [
          host.id,
        ]);
        if (!members.rows.length || !active.rows.length) {
          await retireUndispatchable(tx, host.id, {
            sandbox: DOCKER_LAUNCH_FAILURE_MESSAGES.hostUnavailable,
            snapshot: DOCKER_SNAPSHOT_FAILURE_MESSAGES.retired,
          });
        }
        const pending = await tx.query(
          `select 1 from public.docker_host_jobs where host_id=$1 and outcome is null
           union all
           select 1 from public.jobs j join public.sandboxes s on s.id=j.sandbox_id and s.lifecycle_generation=j.generation
            where s.docker_host_id=$1 and j.kind='stop' and j.state in ('queued','leased') limit 1`,
          [host.id],
        );
        if (!retained.rows.length && !pending.rows.length) {
          // The uninstall completed: retire the host and end the drain in the same transaction, so its snapshots
          // report the revoked state instead of asking the user to retry an uninstall that already finished.
          await tx.query(
            `update public.docker_hosts set revoked_at=now(),registration_hash=null,draining_at=null where id=$1`,
            [host.id],
          );
          return null;
        }
        return { host, rows: pending.rows.length || !members.rows.length ? [] : retained.rows };
      });
      if (drain === null) return true;
      // Reuse normal bound cleanup admission and physical ACK reconciliation, never
      // fabricate a deleted state from server intent or delete unlabelled resources.
      for (const row of drain.rows) {
        const operation = ["stopped", "failed"].includes(row.status) ? "delete" : "stop";
        const hex = createHash("sha256").update(`uninstall:${installationId}:${row.id}:${operation}`).digest("hex");
        const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        await store.enqueueCleanup({ userId: drain.host.owner_id, orgId: drain.host.org_id }, row.id, {
          operation,
          requestId,
        });
      }
      return false;
    },
    async poll(
      hostToken: string,
      installationId: string,
      version?: string,
      skipSnapshots = false,
      resources?: DockerHostResources,
      resourcePolicyVersion?: 1,
      diskFreeBytes?: number | null,
      stoppedSandboxBytes?: number | null,
      /** Request IDs the daemon reports as still executing (#2561). */
      running: readonly string[] = [],
      protocol?: number | null,
      supportsPhysicalDelete = false,
      supportsRestore = false,
      preferStartup = false,
      supportsMachineBootstrap = false,
      supportsRestoreRecovery?: boolean,
    ): Promise<Job | null> {
      const priority = preferStartup
        ? `case when j.bound_operation in ('create','bootstrap') then 0 else 1 end,${dispatchPriority}`
        : dispatchPriority;
      // A revoked host or a removed owner can never authenticate again. Retire its
      // undispatchable work in its own committed transaction before the normal
      // admission path denies, so a queued startup cannot stay starting forever.
      await transaction(async (tx) => {
        const hint = (
          await tx.query<{ id: string; org_id: string; owner_id: string; revoked_at: unknown; member: boolean }>(
            `select h.id,h.org_id,h.owner_id,h.revoked_at,
               exists(select 1 from public.members m where m.org_id=h.org_id and m.user_id=h.owner_id) as member
             from public.docker_hosts h where h.hash=$1 and h.installation_id=$2`,
            [hash(hostToken), installationId],
          )
        ).rows[0];
        if (!hint || (hint.revoked_at === null && hint.member)) return;
        // Membership -> host is the shared lock order; the host lock fences enqueue/ACK.
        await tx.query(`select user_id from public.members where org_id=$1 and user_id=$2 for update`, [
          hint.org_id,
          hint.owner_id,
        ]);
        const host = (
          await tx.query<Host>(`select id,org_id,owner_id from public.docker_hosts where id=$1 for update`, [hint.id])
        ).rows[0];
        if (host)
          await retireUndispatchable(tx, host.id, {
            sandbox: DOCKER_LAUNCH_FAILURE_MESSAGES.hostUnavailable,
            snapshot: DOCKER_SNAPSHOT_FAILURE_MESSAGES.retired,
          });
      });
      return transaction(async (tx) => {
        // Cleanup bypasses queued startup/snapshot work. Work the daemon reports as
        // still executing stays serial per sandbox (and snapshot builds stay serial):
        // neither it nor any later job of its sandbox is handed out, while other
        // sandboxes' jobs are, so one slow launch does not delay the next (#2561).
        // Stop intent fences every later startup, so an absent-resource ACK cannot admit a queued create.
        // Peek before member/host locks: never acquire a late actor lock behind the host.
        const hint = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j join public.docker_hosts h on h.id=j.host_id
           where h.hash=$1 and h.installation_id=$2 and j.outcome is null and (not $3::boolean or j.snapshot_id is null) and ${notRunning(4)} and ${eligibleJob(5, 6, 7)} order by ${priority} limit 1`,
            [
              hash(hostToken),
              installationId,
              skipSnapshots,
              running,
              supportsPhysicalDelete,
              supportsRestore,
              supportsMachineBootstrap,
            ],
          )
        ).rows[0];
        const host =
          hint?.bound_sandbox_id && ["stop", "delete"].includes(hint.bound_operation ?? "")
            ? await reconcileHost(tx, hostToken, installationId, hint.bound_actor_id ?? undefined)
            : await authenticate(tx, hostToken, installationId, hint?.bound_actor_id ?? undefined);
        await tx.query(
          `update public.docker_hosts set last_seen_at=now(),daemon_version=$2,resource_policy_version=$3,available_cpus=null,available_memory_bytes=null,disk_free_bytes=$4,stopped_sandbox_bytes=$5,daemon_protocol=coalesce($6::integer,daemon_protocol),
             restore_recovery_supported=coalesce($7::boolean,restore_recovery_supported) where id=$1`,
          [
            host.id,
            version ?? null,
            resourcePolicyVersion ?? null,
            diskFreeBytes ?? null,
            stoppedSandboxBytes ?? null,
            protocol ?? null,
            supportsRestoreRecovery ?? null,
          ],
        );
        if (resources) {
          await tx.query(
            "update public.docker_hosts set machine_cpus=$2,machine_memory_bytes=$3,available_cpus=$4,available_memory_bytes=$5 where id=$1",
            [
              host.id,
              resources.cpus,
              resources.memoryBytes,
              resources.availableCpus ?? null,
              resources.availableMemoryBytes ?? null,
            ],
          );
        }
        await tx.query(
          "update public.docker_snapshots set status='failed',image_id=null,failure_reason=$2 where host_id=$1 and status='building' and build_expires_at<=now()",
          [host.id, DOCKER_SNAPSHOT_FAILURE_MESSAGES.expired],
        );
        await tx.query(
          "update public.docker_host_jobs j set outcome='failed',completed_at=now() from public.docker_snapshots s where j.snapshot_id=s.id and j.host_id=$1 and j.outcome is null and s.status='failed'",
          [host.id],
        );
        // Older servers acknowledged failed startup without terminalizing the
        // logical row. Reconcile that saved fact without replaying the machine.
        const histories = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j join public.sandboxes s on s.id=j.bound_sandbox_id
             where j.host_id=$1 and j.outcome='failed' and j.bound_operation in ('create','bootstrap')
             and s.provider='docker' and s.docker_host_id=$1 and s.docker_installation_id=$2
             and s.status in ('starting','ready','running') order by j.position`,
            [host.id, installationId],
          )
        ).rows;
        for (const historical of histories) {
          let verified: Sandbox | undefined;
          try {
            verified = await boundMachine(tx, historical, host, installationId);
          } catch {
            // Corrupt history is not authority and must not starve later
            // valid facts or ordinary pending work.
          }
          if (verified && (await startupFailed(tx, verified, historical))) break;
        }
        const row = (
          await tx.query<StoredJob>(
            `select j.*
            from public.docker_host_jobs j where j.host_id=$1 and j.outcome is null and (not $2::boolean or j.snapshot_id is null) and ${notRunning(3)} and ${eligibleJob(4, 5, 6)} order by ${priority} limit 1`,
            [host.id, skipSnapshots, running, supportsPhysicalDelete, supportsRestore, supportsMachineBootstrap],
          )
        ).rows[0];
        if (!row || row.request_id !== hint?.request_id) return null;
        if (!["stop", "delete"].includes(row.bound_operation ?? "")) {
          const policyRow = (
            await tx.query<DockerPolicyRow>(
              "select machine_cpus,machine_memory_bytes,sandbox_cpus,sandbox_memory_bytes,max_sandboxes,available_cpus,available_memory_bytes from public.docker_hosts where id=$1",
              [host.id],
            )
          ).rows[0]!;
          try {
            const policy = hostResourcePolicy(policyRow);
            if (policy?.mode === "manual" && resourcePolicyVersion !== 1) return null;
          } catch (error) {
            if (error instanceof DockerLimitsRefused) return null;
            throw error;
          }
        }
        if (row.snapshot_id) {
          try {
            const job = await readJob(row);
            if (job.operation !== "buildSnapshot") deny();
            await authorizeSnapshotBuild(tx, host.id, installationId, job);
          } catch (error) {
            // A drain is a state refusal, not lost authorization: persist the uninstall reason the user can act on.
            const draining = error instanceof DockerHostDraining;
            if (
              !draining &&
              !(error instanceof DockerHostDenied) &&
              !(error instanceof VaultError && error.code === "forbidden")
            )
              throw error;
            await tx.query(
              "update public.docker_snapshots set status='failed',image_id=null,failure_reason=$2 where id=$1 and status='building'",
              [
                row.snapshot_id,
                draining ? DOCKER_SNAPSHOT_FAILURE_MESSAGES.draining : DOCKER_SNAPSHOT_FAILURE_MESSAGES.authorization,
              ],
            );
            await tx.query(
              "update public.docker_host_jobs set outcome='failed',completed_at=now() where request_id=$1 and outcome is null",
              [row.request_id],
            );
            return null;
          }
        }
        if (row.bound_sandbox_id) {
          let verified: Sandbox | undefined;
          let supersededPlacement = false;
          try {
            if (row.bound_operation === "restore") {
              if (!supportsRestore) return null;
              return await admitRestore(tx, row, host, installationId, true);
            }
            const logical = generationFenced(row.bound_operation)
              ? await boundMachine(tx, row, host, installationId)
              : await currentOrSupersededMachine(tx, row, host, installationId);
            if (
              !logical ||
              (row.bound_operation === "create" && !(await matchesMachineCreateGeneration(tx, logical, row.request_id)))
            ) {
              supersededPlacement = true;
              deny();
            }
            verified = logical;
            await permission(
              tx,
              { userId: row.bound_actor_id ?? deny(), orgId: host.org_id },
              logical,
              row.bound_operation ?? deny(),
              row.bound_actor_epoch,
            );
            const delivered = isCleanupOperation(row.bound_operation) ? await readStoredJob(row) : undefined;
            if (delivered?.machineCleanup) {
              if (
                delivered.lifecycleGeneration !== (await currentMachineCleanup(tx, logical)) ||
                (await supersededLifecycle(tx, row))
              ) {
                supersededPlacement = true;
                deny();
              }
            } else if (row.bound_operation !== "deletePhysical" || !(await readStoredJob(row)).machinePhysicalDelete)
              await state(tx, logical, row.bound_operation ?? deny());
            if (row.bound_operation !== "deletePhysical") await machine(tx, logical, row.bound_operation ?? deny());
            // Create pickup belongs to activation 1. Resume timing comes from its durable host claim.
            if (row.bound_operation === "create")
              await recordLaunchStageForActivation(tx, logical.id, 1, "provider_claimed");
          } catch (error) {
            if (!(error instanceof DockerHostDenied)) throw error;
            if (verified) await startupFailed(tx, verified, row);
            await tx.query(
              `update public.docker_host_jobs set outcome='failed',completed_at=now(),
               cancelled_at=case when $2 or bound_operation in ('stop','deletePhysical','restore') then now() else cancelled_at end
               where request_id=$1 and outcome is null`,
              [row.request_id, supersededPlacement],
            );
            return null;
          }
        }
        const job = await readJob(row);
        if ((job.operation === "deletePhysical" && !supportsPhysicalDelete) || job.operation === "restore") return null;
        if (job.operation === "create" || job.operation === "bootstrap") {
          const eligible = await tx.query(
            `select 1 from public.docker_host_jobs j where j.request_id=$1 and ${eligibleMachineLaunch(2)}`,
            [job.requestId, supportsMachineBootstrap],
          );
          if (!eligible.rows.length) return null;
        }
        return job;
      });
    },
    cleaned(
      hostToken: string,
      installationId: string,
      result: { requestId: string; cleanupReason?: "retention_elapsed" | "disk_pressure" },
    ) {
      return transaction(async (tx) => {
        exact(result, ["requestId", ...(result.cleanupReason === undefined ? [] : ["cleanupReason"])]);
        if (
          result.cleanupReason !== undefined &&
          !["retention_elapsed", "disk_pressure"].includes(result.cleanupReason)
        )
          deny();
        id(result.requestId);
        const host = await reconcileHost(tx, hostToken, installationId);
        const job =
          (
            await tx.query<StoredJob>("select * from public.docker_host_jobs where host_id=$1 and request_id=$2", [
              host.id,
              result.requestId,
            ])
          ).rows[0] ?? deny();
        if (
          !job.bound_sandbox_id ||
          job.bound_operation === "buildSnapshot" ||
          job.bound_operation === "deletePhysical"
        )
          deny();
        let logical: Sandbox | undefined;
        if (job.bound_operation === "restore") {
          logical = await sandbox(tx, job.bound_sandbox_id, host, installationId);
          const { job: restore, lifecycleGeneration } = await readStoredJob(job);
          if (restore.operation !== "restore" || restore.request.generation !== job.request_id || !lifecycleGeneration)
            deny();
          if (!restoreCleanupGeneration(logical, lifecycleGeneration)) return;
          if (job.outcome !== "completed" || job.cancelled_at) deny();
          await requireRestoreBindings(tx, logical, restore, lifecycleGeneration);
          if (logical.docker_generation !== restore.request.generation) {
            if (logical.docker_generation !== restore.predecessor.request.generation) return;
            if (logical.status === "starting") deny();
            if (
              !job.result_machine_id ||
              !(await adoptDockerRestoreForCleanup(
                tx,
                logical.id,
                logical.lifecycle_generation,
                logical.docker_generation,
                restore.request.generation,
              ))
            )
              deny();
          }
        } else {
          logical = await currentOrSupersededMachine(tx, job, host, installationId);
          if (
            !logical ||
            (job.bound_operation === "create" &&
              ["starting", "ready", "running"].includes(logical.status) &&
              !(await matchesMachineCreateGeneration(tx, logical, job.request_id)))
          )
            return;
        }
        // Status repeats across lifecycles; mailbox ordering identifies which
        // lifecycle owns this fact even after a later resume has stopped again.
        if (await supersededLifecycle(tx, job)) return;
        // Physical cleanup is an authenticated machine fact, not owner delete intent.
        const transition = await transitionSandbox(tx, {
          sandboxId: logical.id,
          expectedGeneration: logical.lifecycle_generation,
          fromStates: ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"],
          toState: "deleted",
          actor: "docker_host",
          code: result.cleanupReason ?? "retention_elapsed",
          effects: [],
        });
        if (transition.kind === "conflict") deny();
      });
    },
    async retainedOutputs(
      hostToken: string,
      installationId: string,
      requestId: string,
      body: ReadableStream<Uint8Array> | null,
      signal: AbortSignal,
    ): Promise<202 | 204> {
      function authorize(expectedGeneration?: string) {
        return transaction(async (tx) => {
          id(requestId);
          const restoreReceipt = (
            await tx.query<StoredJob & { placed_generation: string | null }>(
              `select j.*,s.docker_generation as placed_generation from public.docker_host_jobs j
               join public.docker_hosts h on h.id=j.host_id
               left join public.sandboxes s on s.id=j.bound_sandbox_id and s.docker_host_id=h.id
                 and s.docker_installation_id=h.installation_id and s.org_id=h.org_id
               where j.request_id=$1 and j.bound_operation='restore' and h.hash=$2 and h.installation_id=$3`,
              [requestId, hash(hostToken), installationId],
            )
          ).rows[0];
          if (restoreReceipt) {
            const restore = await readJob(restoreReceipt);
            if (restore.operation !== "restore" || restore.request.generation !== requestId) deny();
            if (restoreReceipt.placed_generation !== restore.request.generation) return;
          }
          const host = await authenticate(tx, hostToken, installationId);
          const job =
            (
              await tx.query<StoredJob>(
                `select * from public.docker_host_jobs where host_id=$1 and request_id=$2
               and bound_operation in ('create','bootstrap','restore') and bound_sandbox_id is not null`,
                [host.id, requestId],
              )
            ).rows[0] ?? deny();
          let logical: Sandbox | undefined;
          if (job.bound_operation === "restore") {
            logical = await sandbox(tx, job.bound_sandbox_id ?? deny(), host, installationId);
            const { job: restore, lifecycleGeneration } = await readStoredJob(job);
            if (restore.operation !== "restore" || restore.request.generation !== requestId || !lifecycleGeneration)
              deny();
            if (logical.docker_generation !== requestId) return;
            if (job.outcome !== "completed" || job.cancelled_at) deny();
            await requireRestoreBindings(tx, logical, restore, lifecycleGeneration);
          } else {
            logical = await currentOrSupersededMachine(tx, job, host, installationId);
            if (!logical) return;
          }
          if (await supersededLifecycle(tx, job, true)) return;
          const predicate = `id=$1 and not application_secret_tainted and ${DOCKER_RETAINED_OUTPUT_STOP}`;
          const row = (
            await tx.query<{ id: string; generation: string; provider_sandbox_id: string }>(
              `select id,lifecycle_generation::text as generation,provider_sandbox_id from public.sandboxes
               where ${predicate} and ($2::bigint is null or lifecycle_generation=$2::bigint)`,
              [logical.id, expectedGeneration ?? null],
            )
          ).rows[0];
          if (!row) return;
          const scan = expectedGeneration === undefined ? null : await recordDockerOutputUpload(tx, row.id);
          return { ...row, scan };
        });
      }
      const admitted = await authorize();
      if (!admitted) return 204;
      if (!body) return 202;
      const root = OUTPUT_DIRECTORY.slice(OUTPUT_DIRECTORY.lastIndexOf("/") + 1);
      const snapshot = await readOutputArchive(body, signal, { root });
      signal.throwIfAborted();
      // Claim after the entire copy is validated. A failed or truncated copy cannot supersede
      // an in-progress publication or modify the prior downloadable snapshot.
      const row = await authorize(admitted.generation);
      if (!row?.scan) return 204;
      await collectOutputTransfers(
        sql,
        {
          outputReadBytes: OUTPUT_MAX_READ_BYTES,
          listOutputEntries: async () => snapshot.entries,
          readOutputChunk: async ({ chunk: { entry, offset, length } }) =>
            snapshot.files.get(entry.name)?.subarray(offset, offset + (length ?? OUTPUT_MAX_READ_BYTES)) ?? null,
        },
        row.id,
        { sandboxId: row.provider_sandbox_id, signal },
        row.scan,
        key,
        { generation: row.generation, mode: "docker-retained" },
      );
      return 204;
    },
    expired(hostToken: string, installationId: string, result: { requestId: string }) {
      return transaction(async (tx) => {
        exact(result, ["requestId"]);
        id(result.requestId);
        const host = await reconcileHost(tx, hostToken, installationId);
        const job =
          (
            await tx.query<StoredJob>(`select * from public.docker_host_jobs where host_id=$1 and request_id=$2`, [
              host.id,
              result.requestId,
            ])
          ).rows[0] ?? deny();
        let logical: Sandbox | undefined;
        if (job.bound_operation === "restore") {
          logical = await sandbox(tx, job.bound_sandbox_id ?? deny(), host, installationId);
          const { job: restore, lifecycleGeneration } = await readStoredJob(job);
          if (restore.operation !== "restore" || restore.request.generation !== job.request_id || !lifecycleGeneration)
            deny();
          if (logical.status === "deleted") return;
          const attached = logical.docker_generation === restore.request.generation;
          if (!restoreCleanupGeneration(logical, lifecycleGeneration)) return;
          await requireRestoreBindings(tx, logical, restore, lifecycleGeneration);
          if (attached) {
            if (job.outcome !== "completed" || job.cancelled_at) deny();
          } else {
            if (logical.docker_generation !== restore.predecessor.request.generation) deny();
            if (job.outcome === "failed" && !job.cancelled_at) return;
            if (job.outcome !== "completed" || !job.result_machine_id || job.cancelled_at) return false;
            if (
              !(await adoptDockerRestoreForCleanup(
                tx,
                logical.id,
                logical.lifecycle_generation,
                logical.docker_generation,
                restore.request.generation,
              ))
            )
              deny();
          }
        } else {
          if (job.bound_operation !== "create" && job.bound_operation !== "bootstrap") deny();
          logical = await currentOrSupersededMachine(tx, job, host, installationId);
          if (!logical) return;
          if (
            job.bound_operation === "create" &&
            ["starting", "ready", "running"].includes(logical.status) &&
            !(await matchesMachineCreateGeneration(tx, logical, job.request_id))
          )
            return;
          if (logical.status === "deleted" || (await supersededLifecycle(tx, job, true))) return;
        }
        if (
          logical.stopped_at != null &&
          logical.stop_requested_at != null &&
          (logical.status === "failed" ||
            ["expired", "agent_finished", "work_merged"].includes(logical.status_reason ?? ""))
        )
          return true;
        // A report is physical evidence. ACK only after the worker commits, so the daemon
        // keeps its expiry report and retained-output upload pending across server crashes.
        const jobs = createJobsStore(sql, key);
        const expiryAdvances = ["stopped", "failed"].includes(logical.status) ? 0 : 1;
        const jobId = await jobs.enqueue(
          "stop",
          logical.id,
          requireGenerationHeadroom(logical.lifecycle_generation, expiryAdvances),
          `expiry:${result.requestId}`,
          { expired: true, orgId: logical.org_id },
          { orgId: logical.org_id, maxAttempts: 8, deadline: new Date(Date.now() + 120_000) },
          tx,
        );
        const {
          rows: [expiry],
        } = await tx.query<{ state: string }>("select state::text from public.jobs where id=$1", [jobId]);
        return expiry?.state === "done";
      });
    },
    complete(
      hostToken: string,
      installationId: string,
      result: {
        requestId: string;
        outcome: "completed" | "failed";
        reason?: DockerJobFailureReason;
        imageId?: string;
        machineId?: string;
        absentMachineId?: string;
        baselineVersion?: number;
        baselineTool?: SnapshotBaselineTool;
        missingRefIndex?: number;
        retained?: true;
      },
    ) {
      return transaction(async (tx) => {
        exact(result, [
          "requestId",
          "outcome",
          ...(result.reason !== undefined ? ["reason"] : []),
          ...(result.imageId !== undefined ? ["imageId"] : []),
          ...(result.machineId !== undefined ? ["machineId"] : []),
          ...(result.absentMachineId !== undefined ? ["absentMachineId"] : []),
          ...(result.baselineVersion !== undefined ? ["baselineVersion"] : []),
          ...(result.baselineTool !== undefined ? ["baselineTool"] : []),
          ...(result.missingRefIndex !== undefined ? ["missingRefIndex"] : []),
          ...(result.retained !== undefined ? ["retained"] : []),
        ]);
        if (
          result.reason !== undefined &&
          (result.outcome !== "failed" || !DOCKER_JOB_FAILURE_REASONS.includes(result.reason))
        )
          deny();
        id(result.requestId);
        if (result.outcome !== "completed" && result.outcome !== "failed") deny();
        if (result.retained !== undefined && (result.retained !== true || result.outcome !== "failed")) deny();
        const peek = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j join public.docker_hosts h on h.id=j.host_id where j.request_id=$1 and h.hash=$2 and h.installation_id=$3`,
            [result.requestId, hash(hostToken), installationId],
          )
        ).rows[0];
        const host = peek?.bound_sandbox_id
          ? await reconcileHost(
              tx,
              hostToken,
              installationId,
              peek.bound_operation === "stop" && result.retained ? (peek.bound_actor_id ?? undefined) : undefined,
            )
          : await authenticate(
              tx,
              hostToken,
              installationId,
              peek?.snapshot_id ? (peek.bound_actor_id ?? undefined) : undefined,
            );
        const hint =
          (
            await tx.query<StoredJob>(`select * from public.docker_host_jobs where host_id=$1 and request_id=$2`, [
              host.id,
              result.requestId,
            ])
          ).rows[0] ?? deny();
        let logical: Sandbox | undefined;
        let supersededPlacement = false;
        if (hint.bound_sandbox_id) {
          if (generationFenced(hint.bound_operation)) await readJob(hint);
          else {
            logical = await currentOrSupersededMachine(tx, hint, host, installationId);
            supersededPlacement = logical === undefined;
          }
        }
        const jobs = await tx.query<StoredJob>(
          `select * from public.docker_host_jobs where host_id=$1 and request_id=$2 for update`,
          [host.id, result.requestId],
        );
        const job = jobs.rows[0] ?? deny();
        const cleanup = isCleanupOperation(job.bound_operation);
        const machineCleanup = cleanup && (await readStoredJob(job)).machineCleanup;
        if (
          result.machineId !== undefined &&
          (result.outcome !== "completed" ||
            typeof result.machineId !== "string" ||
            !/^[a-f0-9]{64}$/.test(result.machineId) ||
            !job.bound_sandbox_id ||
            (job.bound_operation !== "create" && job.bound_operation !== "restore" && job.bound_operation !== "stop"))
        )
          deny();
        if (result.absentMachineId !== undefined) {
          if (
            result.outcome !== "completed" ||
            result.machineId !== undefined ||
            !/^[a-f0-9]{64}$/.test(result.absentMachineId) ||
            job.bound_operation !== "stop" ||
            !job.bound_sandbox_id
          )
            deny();
          const { request } = await readJob(job);
          const allocatedId = await allocationReceipt(tx, {
            id: job.bound_sandbox_id,
            docker_host_id: host.id,
            docker_generation: request.generation,
          });
          if (allocatedId !== result.absentMachineId) deny();
        }
        if (job.bound_operation === "stop" && result.machineId !== undefined && logical) {
          const allocatedId = await allocationReceipt(tx, logical);
          if (allocatedId && allocatedId !== result.machineId) deny();
        }
        // A cancelled job's server outcome is not a machine fact. The first host
        // receipt replaces it; after that, terminal facts are immutable.
        if (
          job.outcome !== null &&
          job.cancelled_at === null &&
          (job.outcome !== result.outcome ||
            (job.result_image_id ?? null) !== (result.imageId ?? null) ||
            (result.machineId !== undefined && job.result_machine_id !== result.machineId) ||
            (result.absentMachineId !== undefined && job.absent_machine_id !== result.absentMachineId))
        )
          deny();
        // A retired snapshot build is already failed and its build authorization is
        // gone. A matching failure is a harmless no-op; a completed receipt would
        // claim a publication that can never happen, so reject it.
        if (
          job.snapshot_id &&
          job.cancelled_at !== null &&
          (result.outcome !== "failed" || result.imageId !== undefined)
        )
          deny();
        if (result.reason === "snapshot_build_failed" && !job.snapshot_id) deny();
        if (
          result.baselineTool !== undefined &&
          (result.reason !== "snapshot_build_failed" || !isSnapshotBaselineTool(result.baselineTool))
        )
          deny();
        if (
          result.baselineVersion !== undefined &&
          (!job.snapshot_id ||
            result.outcome !== "completed" ||
            !Number.isSafeInteger(result.baselineVersion) ||
            result.baselineVersion < 1 ||
            result.baselineVersion > 2147483647)
        )
          deny();
        if (
          result.missingRefIndex !== undefined &&
          (!job.snapshot_id ||
            result.reason !== "snapshot_build_failed" ||
            result.baselineTool !== undefined ||
            !Number.isInteger(result.missingRefIndex) ||
            result.missingRefIndex < 1)
        )
          deny();
        if (job.snapshot_id) {
          const parsed = await readJob(job);
          if (
            parsed.operation !== "buildSnapshot" ||
            (result.outcome === "completed"
              ? !/^sha256:[0-9a-f]{64}$/.test(result.imageId ?? "")
              : result.imageId !== undefined)
          )
            deny();
          if (result.missingRefIndex !== undefined && result.missingRefIndex > parsed.build.config.repos.length) deny();
          if (job.outcome === null) {
            let eligible = false,
              draining = false,
              baselineMissing = false;
            if (result.outcome === "completed") {
              try {
                const snapshot = await authorizeSnapshotBuild(tx, host.id, installationId, parsed);
                baselineMissing = (result.baselineVersion ?? 0) < (snapshot.required_baseline_version ?? 0);
                eligible = !baselineMissing;
              } catch (error) {
                if (error instanceof DockerHostDraining) draining = true;
                else if (!(error instanceof VaultError && error.code === "forbidden")) throw error;
              }
            }
            await tx.query(
              "update public.docker_snapshots set status=$2,image_id=$3,failure_reason=$4,baseline_version=$5,baseline_failure_tool=$6,missing_ref_index=$7 where id=$1 and status='building'",
              [
                job.snapshot_id,
                eligible ? "ready" : "failed",
                eligible ? result.imageId : null,
                eligible
                  ? null
                  : draining
                    ? DOCKER_SNAPSHOT_FAILURE_MESSAGES.draining
                    : baselineMissing
                      ? DOCKER_SNAPSHOT_FAILURE_MESSAGES.baseline
                      : result.outcome === "completed"
                        ? DOCKER_SNAPSHOT_FAILURE_MESSAGES.authorization
                        : result.reason === "disk_full"
                          ? DOCKER_SNAPSHOT_FAILURE_MESSAGES.disk
                          : DOCKER_SNAPSHOT_FAILURE_MESSAGES.build,
                eligible ? (result.baselineVersion ?? null) : null,
                result.baselineTool ?? null,
                result.missingRefIndex ?? null,
              ],
            );
          }
        } else if (result.imageId !== undefined) deny();
        if (job.bound_operation === "restore" && result.outcome === "failed") {
          const { runnerJobId } = await readStoredJob(job);
          if (runnerJobId)
            await recordDockerRestoreEvidence(tx, runnerJobId, { restoreFailure: result.reason ?? "restore_failed" });
        }
        const staleRestorePredecessor =
          supersededPlacement || (logical !== undefined && (await supersededLifecycle(tx, job, true)));
        if (logical && !staleRestorePredecessor && result.outcome === "failed")
          await startupFailed(tx, logical, job, result.reason);
        // Persist terminal receipts below, but never replay old stop/delete
        // effects onto a lifecycle admitted after that job.
        const staleCleanup =
          staleRestorePredecessor ||
          ((job.bound_operation === "stop" || job.bound_operation === "delete") &&
            (await supersededLifecycle(tx, job)));
        if (result.outcome === "completed" && job.bound_sandbox_id && !staleCleanup) {
          // #2560: the host created and started the container. A create job only exists for the inserted row, so it
          // belongs to the launch (activation 1): a replayed or late create ACK must never date a later resume. A
          // resume restores inside its bootstrap job, so its machine start is the bootstrap's first report instead
          // (see runtime-progress).
          if (job.bound_operation === "create")
            await recordLaunchStageForActivation(tx, job.bound_sandbox_id, 1, "machine_started");
          if (logical && isCleanupOperation(job.bound_operation) && !machineCleanup)
            await recordDockerCleanupReceipt(tx, logical.id, Number(logical.lifecycle_generation), job.bound_operation);
          // A self-finish stop is a durable cleanup intent, not retained idle compute.
          // Enqueue removal in this same ACK transaction; a lost ACK can safely repair it.
          if (!machineCleanup && job.bound_operation === "stop" && logical?.status_reason === "agent_finished") {
            const current = await sandbox(tx, logical.id, host, installationId);
            const known = await tx.query(
              `select 1 from public.docker_host_jobs where bound_sandbox_id=$1
               and bound_operation='delete' and outcome is distinct from 'failed' limit 1`,
              [logical.id],
            );
            const member = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2", [
              logical.org_id,
              logical.owner_id,
            ]);
            if (current.status === "stopped" && !known.rows.length && member.rows.length) {
              const epoch = await permission(
                tx,
                { userId: logical.owner_id, orgId: logical.org_id },
                current,
                "delete",
              );
              await writeBoundCleanup(tx, current, "delete", randomUUID(), current.owner_id, epoch);
            }
          }
        }
        if (job.outcome === null || job.cancelled_at !== null) {
          await tx.query(
            `update public.docker_host_jobs set outcome=$2,completed_at=now(),result_image_id=$3,result_machine_id=$4,
             absent_machine_id=$5,cancelled_at=null where request_id=$1`,
            [
              result.requestId,
              result.outcome,
              result.imageId ?? null,
              result.machineId ?? null,
              result.absentMachineId ?? null,
            ],
          );
          if (job.bound_sandbox_id) {
            await wakeSandboxJobs(tx, job.bound_sandbox_id, ["launch", "resume", "stop"]);
          }
        }
      });
    },
  };

  return {
    ...store,
    machine(options: DockerMachineOptions) {
      const { actor, hostId, installationId, inventory, bootstrapDescriptor, restoreClaim } = options;
      const scope = { hostId, installationId, ...(options.canDispatch && { canDispatch: options.canDispatch }) };
      const descriptor = bootstrapDescriptor && structuredClone(bootstrapDescriptor);
      const claim = restoreClaim && { ...restoreClaim };
      return createDockerMachineAdapter({
        ...store.machineCleanup(actor, scope),
        ...(inventory &&
          store.machineInventory(inventory.hostToken, installationId, inventory.serverUrl, inventory.report, hostId)),
        async create(request) {
          const result = await store.submitMachineCreate(actor, request, scope);
          return result.kind === "completed" ? { kind: "completed", value: result.machine } : result;
        },
        async bootstrap(request) {
          const { sandboxId, generation, machineId, bindingRef, signal } = request;
          signal?.throwIfAborted();
          if (!tokenPattern.test(machineId)) deny();
          return transaction(async (tx) => {
            const { row } = await lockSandboxAdmission(tx, actor, sandboxId, "bootstrap", scope);
            if (
              String(row.lifecycle_generation) !== String(generation) ||
              (await currentMachineCleanup(tx, row)) !== String(generation) ||
              (await allocationReceipt(tx, row)) !== machineId
            )
              deny();
            const epoch = await permission(tx, actor, row, "bootstrap");
            if (scope.canDispatch && !(await scope.canDispatch(tx, epoch))) deny();
            const requestId = dockerMachineJobId(row.docker_generation, "bootstrap");
            const existing = await machineJob(tx, row, requestId, "bootstrap");
            const allocation = await machine(tx, row, "bootstrap");
            if (existing) {
              const saved = await readJob(existing);
              if (
                saved.operation !== "bootstrap" ||
                existing.bound_actor_id !== actor.userId ||
                String(existing.bound_actor_epoch) !== epoch ||
                createHash("sha256").update(saved.bootstrap.enrolmentToken).digest("hex") !== bindingRef ||
                (descriptor && input(saved) !== input({ ...saved, bootstrap: descriptor })) ||
                input(saved) !== input({ ...saved, request: allocation })
              )
                deny();
              if (await runtimeEnrolled(tx, row)) return { kind: "completed", value: undefined };
              return mailboxOutcome(existing);
            }
            if (!descriptor || createHash("sha256").update(descriptor.enrolmentToken).digest("hex") !== bindingRef)
              deny();
            await fenceFreshStartup(tx, row);
            await refuseDraining(tx, hostId);
            await state(tx, row, "bootstrap");
            const prior = await tx.query<StoredJob>(
              `select * from public.docker_host_jobs where host_id=$1 and bound_sandbox_id=$2 and bound_operation='bootstrap'`,
              [hostId, sandboxId],
            );
            for (const job of prior.rows) {
              if ((await readJob(job)).request.generation === row.docker_generation) deny();
            }
            const ticket = await tx.query<{ sandbox_id: string }>(
              `select sandbox_id from public.runtime_enrolments where enrolment_hash=$1`,
              [bindingRef],
            );
            if (ticket.rows[0]?.sandbox_id !== sandboxId) deny();
            return createRuntimeEnrolments(scopedRuntimeSql(tx), key).withBootstrap(
              descriptor.enrolmentToken,
              async (_tx, session, ticketGeneration) => {
                if (session.sandboxId !== sandboxId || ticketGeneration !== String(generation)) deny();
                signal?.throwIfAborted();
                await insert(
                  tx,
                  hostId,
                  { operation: "bootstrap", requestId, request: allocation, bootstrap: descriptor },
                  {
                    bound_sandbox_id: sandboxId,
                    bound_actor_id: actor.userId,
                    bound_actor_epoch: epoch,
                    bound_operation: "bootstrap",
                  },
                );
                return { kind: "pending" };
              },
            );
          });
        },
        async resume(request) {
          request.signal?.throwIfAborted();
          if (!claim) deny();
          return { kind: "completed", value: await store.attachMachineRestore(actor, claim, { scope, request }) };
        },
        async delete(request) {
          const { sandboxId, generation, machineId, signal } = request;
          signal?.throwIfAborted();
          if (
            !tokenPattern.test(machineId) ||
            (request.scope !== "physical-only" && request.scope !== "physical-and-retained")
          )
            deny();
          return transaction(async (tx) => {
            const physical = request.scope === "physical-only";
            const operation = physical ? "deletePhysical" : "delete";
            const { row } = await lockSandboxAdmission(tx, actor, sandboxId, operation, scope);
            const epoch = await permission(tx, actor, row, operation);
            if (
              (await currentMachineCleanup(tx, row)) !== String(generation) ||
              (await allocationReceipt(tx, row)) !== machineId
            )
              deny();
            const requestId = physical ? randomUUID() : dockerMachineJobId(row.docker_generation, "delete");
            const existing = physical
              ? await physicalRemovalReceipt(tx, row, machineId, true)
              : await machineJob(tx, row, requestId, operation);
            if (existing) {
              const outcome = mailboxOutcome(existing);
              if (!physical || outcome.kind !== "unknown") return outcome;
            }
            if (physical) await refuseDraining(tx, hostId);
            const allocation = await machine(tx, row, operation);
            signal?.throwIfAborted();
            await insert(
              tx,
              hostId,
              physical
                ? { operation: "deletePhysical", requestId, request: allocation, machineId }
                : { operation: "delete", requestId, request: allocation },
              {
                bound_sandbox_id: sandboxId,
                bound_actor_id: actor.userId,
                bound_actor_epoch: epoch,
                bound_operation: operation,
              },
              physical ? String(row.lifecycle_generation) : String(generation),
              undefined,
              undefined,
              physical ? true : undefined,
            );
            return { kind: "pending" };
          });
        },
      } satisfies DockerMachineMailbox);
    },
  };
}
