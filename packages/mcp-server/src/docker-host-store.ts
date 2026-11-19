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
  type SandboxStatus,
  type Sql,
} from "@armada/core";
import {
  decryptSecret,
  encryptSecret,
  isSnapshotBaselineTool,
  readOutputArchive,
  type SnapshotBaselineTool,
  VaultError,
} from "@armada/core/server";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";
import type { DockerHostResources } from "../../core/src/docker-resources.ts";
import { type DockerResourceOverrides, dockerResourcePolicy } from "../../core/src/docker-resources.ts";
import {
  DOCKER_CAPACITY_USAGE_SQL,
  DockerHostDraining,
  DockerHostFull,
  DockerLimitsRefused,
  type DockerPolicyRow,
  hostResourcePolicy,
} from "./docker-capacity.ts";
import { hostDrainingSql } from "./docker-host-drain.ts";
import { dockerHostSupportsSnapshotBaseline } from "./docker-host-version.ts";
import { authorizeSnapshotBuild, resolveDockerSnapshot } from "./docker-snapshot-data.ts";
import { recordLaunchStageForActivation } from "./launch-stage-record.ts";
import { collectOutputTransfers, DOCKER_RETAINED_OUTPUT_STOP } from "./output-transfers.ts";
import { noteAdmission } from "./request-observability.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import { unsettledRuntimeCommands } from "./runtime-idle-evidence.ts";
import { failDockerResumeActivation, requestRefusedDockerResumeStop } from "./sandbox-lifecycle.ts";
import { deferTransactionWake } from "./wake-bus.ts";

type Actor = { userId: string; orgId: string };
type Job = DockerHostJob;
export const DOCKER_JOB_REQUEST_OUTCOME_SQL =
  "case when j.refused_resume_generation is not null then 'failed' else j.outcome end";
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
  cancelled_at?: string | null;
  refused_resume_generation?: string | null;
};
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
  deleted_at: unknown;
};
type Selection = { requestId: string } & (
  | { operation: "create" | "delete" }
  | { operation: "stop"; idleCheckpointRequest?: string; onlyIfIdle?: boolean }
  | { operation: "bootstrap" | "resume"; bootstrapDescriptor: BootstrapDescriptor }
);
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
    and (r.bound_sandbox_id=j.bound_sandbox_id or (r.snapshot_id is not null and j.snapshot_id is not null)))`;
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
        error instanceof DockerHostDraining ||
        error instanceof DockerHostFull ||
        error instanceof DockerLimitsRefused ||
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
  async function authenticate(tx: Sql, hostToken: string, installationId: string, actorId?: string) {
    id(installationId);
    const result = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts
      where hash=$1 and installation_id=$2 and revoked_at is null`,
      [hash(hostToken), installationId],
    );
    const host = result.rows[0] ?? deny();
    const member = await tx.query<{ user_id: string }>(
      `select user_id from public.members where org_id=$1 and user_id in ($2,$3) order by user_id for update`,
      [host.org_id, host.owner_id, actorId ?? host.owner_id],
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
  async function reconcileHost(tx: Sql, hostToken: string, installationId: string, actorId?: string) {
    id(installationId);
    if (actorId) {
      // Preserve membership -> host lock order for cleanup dispatch authorization.
      await tx.query(
        `select m.user_id from public.members m join public.docker_hosts h on h.org_id=m.org_id
         where h.hash=$1 and h.installation_id=$2 and m.user_id=$3 for update of m`,
        [hash(hostToken), installationId, actorId],
      );
    }
    const result = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts where hash=$1 and installation_id=$2 for update`,
      [hash(hostToken), installationId],
    );
    return result.rows[0] ?? deny();
  }
  async function insert(tx: Sql, hostId: string, job: Job, bound?: Bound) {
    const canonical = input(job);
    // Deliberately incompatible with old strict mailbox readers: a mixed-version
    // server must fail closed, never deliver bound work without actor admission.
    const serialized = bound ? JSON.stringify({ bound: 1, job: JSON.parse(canonical) }) : canonical;
    const metadata: Bound = {
      snapshot_id: null,
      ...(bound ?? {
        bound_sandbox_id: null,
        bound_actor_id: null,
        bound_actor_epoch: null,
        bound_operation: null,
      }),
    };
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
  async function readJob(row: StoredJob): Promise<Job> {
    let stored: unknown = JSON.parse(await decryptSecret(row.input_enc, key));
    if (row.bound_sandbox_id !== null || row.snapshot_id) {
      exact(stored, ["bound", "job"]);
      if (stored.bound !== 1) deny();
      stored = stored.job;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) deny();
    const job = parseDockerHostJob({ ...stored, requestId: row.request_id });
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
    return job;
  }
  async function sandbox(tx: Sql, sandboxId: string, host: Host, installationId: string) {
    const row = (await tx.query<Sandbox>(`select * from public.sandboxes where id=$1 for update`, [sandboxId])).rows[0];
    if (
      row?.provider !== "docker" ||
      row.org_id !== host.org_id ||
      row.docker_host_id !== host.id ||
      row.docker_installation_id !== installationId ||
      row.provider_sandbox_id !== `armada-${installationId}-${host.id}-${row.id}-${row.docker_generation}`
    )
      deny();
    return row;
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
  async function state(tx: Sql, row: Sandbox, operation: string) {
    if (operation === "stop") return;
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
  async function machine(tx: Sql, row: Sandbox, operation: string) {
    const original = (
      await tx.query<StoredJob>(
        `select * from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='create'`,
        [row.id],
      )
    ).rows[0];
    if (!original) {
      if (operation !== "create") deny();
      // Cleanup and replay validate an existing sandbox's identity; a drain must not hide its source.
      const source = row.docker_snapshot_id
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
      saved.operation !== "create" ||
      saved.request.sandboxId !== row.id ||
      saved.request.generation !== row.docker_generation ||
      saved.request.image !== row.docker_image ||
      (saved.request.snapshot?.id ?? null) !== (row.docker_snapshot_id ?? null) ||
      saved.request.expiresAt === undefined
    )
      deny();
    if ((operation === "bootstrap" || operation === "resume") && original.outcome !== "completed") deny();
    return saved.request;
  }
  async function supersededLifecycle(tx: Sql, job: StoredJob) {
    const later = await tx.query(
      `select 1 from public.docker_host_jobs where bound_sandbox_id=$1
       and bound_operation in ('resume','bootstrap') and request_id<>$2 and position>$3
       and (bound_operation='resume' or outcome is distinct from 'failed') limit 1`,
      [job.bound_sandbox_id, job.request_id, job.position],
    );
    return later.rows.length > 0;
  }

  async function boundMachine(tx: Sql, job: StoredJob, host: Host, installationId: string) {
    const logical = await sandbox(tx, job.bound_sandbox_id ?? deny(), host, installationId);
    const delivered = await readJob(job);
    const frozen = await machine(tx, logical, "stop");
    if (input(delivered) !== input({ ...delivered, request: frozen })) deny();
    return logical;
  }
  async function settleRefusedResume(tx: Sql, row: Sandbox, job: StoredJob) {
    const generation = job.refused_resume_generation;
    if (!generation || job.cancelled_at || (await supersededLifecycle(tx, job))) return false;
    const actorId = job.bound_actor_id ?? deny();
    let epoch: string;
    try {
      epoch = await permission(tx, { userId: actorId, orgId: row.org_id }, row, "resume", job.bound_actor_epoch);
    } catch (error) {
      if (error instanceof DockerHostDenied) return false;
      throw error;
    }
    if (!(await requestRefusedDockerResumeStop(tx, row.id, generation))) return false;
    await insert(
      tx,
      row.docker_host_id,
      { requestId: randomUUID(), operation: "stop", request: await machine(tx, row, "stop") },
      { bound_sandbox_id: row.id, bound_actor_id: actorId, bound_actor_epoch: epoch, bound_operation: "stop" },
    );
    return true;
  }

  async function startupFailed(tx: Sql, row: Sandbox, job: StoredJob, reason?: DockerJobFailureReason) {
    const operation = job.bound_operation;
    const message =
      reason === "disk_full"
        ? DOCKER_LAUNCH_FAILURE_MESSAGES.disk
        : reason === "image_unavailable" && operation === "create"
          ? DOCKER_IMAGE_UNAVAILABLE_MESSAGE
          : DOCKER_LAUNCH_FAILURE_MESSAGES.startup;
    if (operation === "resume")
      return failDockerResumeActivation(tx, row.id, row.lifecycle_generation, job.request_id, message);
    if (operation !== "create" && operation !== "bootstrap") return;
    await tx.query(
      `update public.sandboxes set status='failed',status_reason=$2,
       lifecycle_generation=lifecycle_generation+1 where id=$1 and status in ('starting','ready','running') and stop_requested_at is null`,
      [row.id, message],
    );
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
    const startups = await tx.query<{ bound_sandbox_id: string }>(
      `select bound_sandbox_id from public.docker_host_jobs
       where host_id=$1 and outcome is null and bound_sandbox_id is not null
         and bound_operation in ('create','bootstrap','resume') for update`,
      [hostId],
    );
    for (const job of startups.rows)
      await tx.query(
        `update public.sandboxes set status='failed',status_reason=$2,
         lifecycle_generation=lifecycle_generation+1
         where id=$1 and status in ('starting','ready','running') and stop_requested_at is null`,
        [job.bound_sandbox_id, reason.sandbox],
      );
    await tx.query(
      `update public.docker_host_jobs set outcome='failed',completed_at=now(),cancelled_at=now()
       where host_id=$1 and outcome is null
         and (bound_operation is null or bound_operation not in ('stop','delete'))`,
      [hostId],
    );
  }
  return {
    async refuseResume(tx: Sql, sandboxId: string, generation: string) {
      const refused = (
        await tx.query<StoredJob>(
          `update public.docker_host_jobs j set refused_resume_generation=$2
           from public.sandboxes s join public.docker_resume_claims c on c.sandbox_id=s.id
           where s.id=$1 and s.status='starting' and s.lifecycle_generation=$2::bigint
             and j.request_id=c.request_id and j.bound_sandbox_id=s.id and j.bound_operation='resume'
             and j.host_id=s.docker_host_id and c.host_id=j.host_id and c.installation_id=s.docker_installation_id
             and c.generation=s.docker_generation and c.accepted and c.lifecycle_generation+1=$2::bigint
             and c.actor_id=s.owner_id and j.bound_actor_id=c.actor_id and j.cancelled_at is null
             and not exists(select 1 from public.docker_host_jobs later
               where later.bound_sandbox_id=s.id and later.bound_operation='resume' and later.position>j.position)
           returning j.*`,
          [sandboxId, generation],
        )
      ).rows[0];
      if (!refused) return false;
      if (refused.outcome === "completed") {
        const row =
          (await tx.query<Sandbox>("select * from public.sandboxes where id=$1", [sandboxId])).rows[0] ?? deny();
        await settleRefusedResume(tx, row, refused);
      }
      return true;
    },
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
          snapshot_baseline_version: number | null;
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
            h.retention_seconds,h.reported_retention_seconds,h.next_cleanup_at,h.disk_free_bytes,h.stopped_sandbox_bytes,h.created_at,h.last_seen_at,h.revoked_at,h.daemon_version,h.snapshot_baseline_version,h.name,h.owner_id,h.resource_policy_version,h.machine_cpus,h.machine_memory_bytes,h.available_cpus,h.available_memory_bytes,h.sandbox_cpus,h.sandbox_memory_bytes,h.max_sandboxes,
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
          ...(host.daemon_version === null && host.snapshot_baseline_version === null
            ? {}
            : {
                snapshotBuildSupported: dockerHostSupportsSnapshotBaseline(
                  host.daemon_version,
                  host.snapshot_baseline_version,
                ),
              }),
        }));
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
            await tx.query(
              `update public.sandboxes set docker_retention_deadline=null
               where docker_host_id=$1 and docker_retention_deadline is not null
                 and not exists (
                   select 1 from unnest($2::uuid[],$3::uuid[]) as held(sandbox_id,generation)
                   where held.sandbox_id=sandboxes.id and held.generation=sandboxes.docker_generation
                 )`,
              [
                host.id,
                report.deadlines.map((entry) => entry.sandboxId),
                report.deadlines.map((entry) => entry.generation),
              ],
            );
          }
          // Persist the exact deadline the daemon will delete at, keyed to the
          // generation it belongs to. A stale report for a superseded generation
          // must not fence a newer one, so match on the current generation.
          for (const entry of report.deadlines ?? []) {
            id(entry.sandboxId);
            id(entry.generation);
            if (!Number.isFinite(Date.parse(entry.deadline))) deny();
            await tx.query(
              `update public.sandboxes set docker_retention_deadline=$3::timestamptz
               where id=$1 and docker_host_id=$2 and docker_generation=$4 and provider='docker'`,
              [entry.sandboxId, host.id, entry.deadline, entry.generation],
            );
          }
        }
        const retention = await tx.query<{ retention_seconds: number | null }>(
          "select retention_seconds from public.docker_hosts where id=$1",
          [host.id],
        );
        return { hostId: host.id, retentionSeconds: retention.rows[0]?.retention_seconds ?? undefined };
      });
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
     * Read-only recheck for a held poll (#2561): whether `poll` or
     * `resumeClaimsForHost` could now return something. It takes no lock and
     * writes nothing, so an idle held poll does not repeat their host
     * reconciliation and heartbeat writes every second; the caller runs the
     * full poll only when this is true. A false positive costs one full poll.
     */
    async mayHaveWork(
      hostToken: string,
      installationId: string,
      skipSnapshots: boolean,
      running: readonly string[],
      resumeClaims: boolean,
    ): Promise<boolean> {
      return transaction(async (tx) => {
        const result = await tx.query<{ found: boolean }>(
          `select exists(select 1 from public.docker_host_jobs j join public.docker_hosts h on h.id=j.host_id
             where h.hash=$1 and h.installation_id=$2 and h.revoked_at is null and j.outcome is null
               and (not $3::boolean or j.snapshot_id is null) and ${notRunning(4)})
           or ($5::boolean and exists(select 1 from public.docker_resume_claims c
             join public.docker_hosts h on h.id=c.host_id join public.sandboxes s on s.id=c.sandbox_id
             where h.hash=$1 and h.installation_id=$2 and h.revoked_at is null
               and c.installation_id=$2 and c.accepted is null
               and s.docker_generation=c.generation and s.lifecycle_generation=c.lifecycle_generation
               and s.status='stopped' and s.deleted_at is null and s.expires_at>now())) as found`,
          [hash(hostToken), installationId, skipSnapshots, running, resumeClaims],
        );
        return result.rows[0]?.found === true;
      });
    },
    resumeClaimsForHost(hostToken: string, installationId: string) {
      return transaction(async (tx) => {
        const host = await reconcileHost(tx, hostToken, installationId);
        const result = await tx.query<{ request_id: string; sandbox_id: string; generation: string }>(
          `select c.request_id,c.sandbox_id,c.generation from public.docker_resume_claims c
           join public.sandboxes s on s.id=c.sandbox_id
           where c.host_id=$1 and c.installation_id=$2 and c.accepted is null
             and s.docker_generation=c.generation and s.lifecycle_generation=c.lifecycle_generation
             and s.status='stopped' and s.deleted_at is null and s.expires_at>now()`,
          [host.id, installationId],
        );
        return result.rows.map((row) => ({
          requestId: row.request_id,
          sandboxId: row.sandbox_id,
          generation: row.generation,
        }));
      });
    },
    claimResume(hostToken: string, installationId: string, requestId: string, accepted: boolean) {
      return transaction(async (tx) => {
        id(requestId);
        const host = await reconcileHost(tx, hostToken, installationId);
        const result = await tx.query(
          `update public.docker_resume_claims set accepted=$4,
             claimed_at=case when $4 and accepted is null then clock_timestamp() else claimed_at end
           where request_id=$3 and host_id=$1 and installation_id=$2
           and (accepted is null or accepted=$4) returning request_id`,
          [host.id, installationId, requestId, accepted],
        );
        if (!result.rows.length) deny();
      });
    },
    /** Every generation with a queued resume/bootstrap, so the daemon fences all of them, not only the head job. */
    pendingStartsForHost(hostToken: string, installationId: string) {
      return transaction(async (tx) => {
        const host = await reconcileHost(tx, hostToken, installationId);
        const rows = (
          await tx.query<{ bound_sandbox_id: string; docker_generation: string }>(
            `select distinct s.id as bound_sandbox_id,s.docker_generation
             from public.docker_host_jobs j join public.sandboxes s on s.id=j.bound_sandbox_id
             where j.host_id=$1 and j.outcome is null and j.bound_operation in ('resume','bootstrap')
               and s.provider='docker' and s.docker_host_id=$1 and s.docker_installation_id=$2
             order by s.id`,
            [host.id, installationId],
          )
        ).rows;
        return rows.map((row) => ({ sandboxId: row.bound_sandbox_id, generation: row.docker_generation }));
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
    enqueue(actor: Actor, hostId: string, job: Job) {
      return transaction(async (tx) => {
        input(job);
        await owned(tx, actor, hostId);
        return insert(tx, hostId, job);
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
    enqueueSandbox(actor: Actor, sandboxId: string, selection: Selection) {
      return transaction(async (tx) => {
        exact(actor, ["userId", "orgId"]);
        id(actor.userId);
        id(actor.orgId);
        id(sandboxId);
        exact(selection, [
          "requestId",
          "operation",
          ...(selection.operation === "stop" && selection.onlyIfIdle !== undefined ? ["onlyIfIdle"] : []),
          ...(selection.operation === "stop" && selection.idleCheckpointRequest !== undefined
            ? ["idleCheckpointRequest"]
            : []),
          ...(selection.operation === "bootstrap" || selection.operation === "resume" ? ["bootstrapDescriptor"] : []),
        ]);
        id(selection.requestId);
        if (!["create", "bootstrap", "resume", "stop", "delete"].includes(selection.operation)) deny();
        const hint =
          (
            await tx.query<Sandbox & { issuer_id: string }>(
              `select s.*,h.owner_id as issuer_id from public.sandboxes s join public.docker_hosts h on h.id=s.docker_host_id
           where s.id=$1 and s.org_id=$2`,
              [sandboxId, actor.orgId],
            )
          ).rows[0] ?? deny();
        const members = await tx.query<{ user_id: string }>(
          `select user_id from public.members where org_id=$1 and user_id in ($2,$3,$4) order by user_id for update`,
          [actor.orgId, actor.userId, hint.issuer_id, hint.owner_id],
        );
        const locked = new Set(members.rows.map((m) => m.user_id));
        const cleanup = selection.operation === "stop" || selection.operation === "delete";
        if (!locked.has(actor.userId) || (!cleanup && !locked.has(hint.issuer_id))) deny();
        const host =
          (
            await tx.query<Host>(
              `select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
           and installation_id=$4 and hash is not null and registration_hash is null and ($5::boolean or revoked_at is null) for update`,
              [hint.docker_host_id, actor.orgId, hint.issuer_id, hint.docker_installation_id, cleanup],
            )
          ).rows[0] ?? deny();
        const row = await sandbox(tx, sandboxId, host, hint.docker_installation_id);
        if (row.owner_id !== hint.owner_id) deny();
        if (selection.operation === "stop" && selection.onlyIfIdle && !["ready", "stopped"].includes(row.status))
          deny();
        const epoch = await permission(tx, actor, row, selection.operation);
        // The host lock serializes admission: observe an existing request only
        // after waiting, so concurrent lost-response retries reconcile too.
        const known =
          (await tx.query(`select 1 from public.docker_host_jobs where request_id=$1`, [selection.requestId])).rows
            .length > 0;
        if (!known && selection.operation === "stop" && selection.onlyIfIdle && row.status === "ready") {
          const pendingTurns = await tx.query(
            `select 1 from public.account_turn_queue where sandbox_id=$1 and state in ('queued','dispatching')
             union all
             select 1 from public.docker_queued_prompts where sandbox_id=$1 and status in ('queued','dispatching')
             union all
             ${unsettledRuntimeCommands("$1", "$2", "$3")}
             limit 1`,
            [sandboxId, row.lifecycle_generation, host.id],
          );
          if (pendingTurns.rows.length) deny();
        }
        // A drain refuses new bootstrap/resume work with its own reason, but an already-admitted
        // request replays: admission is historical and a lost response must not become a refusal.
        if (!known && (selection.operation === "bootstrap" || selection.operation === "resume")) {
          const draining = await tx.query(
            `select 1 from public.docker_hosts where id=$1 and ${hostDrainingSql("docker_hosts")}`,
            [host.id],
          );
          if (draining.rows.length) throw new DockerHostDraining();
        }
        if (!known) await state(tx, row, selection.operation);
        let workMerged = false;
        if (!known && selection.operation === "stop" && selection.idleCheckpointRequest !== undefined) {
          id(selection.idleCheckpointRequest);
          const proof = await tx.query<{ work_merged: boolean }>(
            `select p.merge_stop as work_merged from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id
             join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
             where s.id=$1 and p.request_id=$2 and p.watermark is not null
             and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)
             and s.status in ('ready','running') and s.stop_requested_at is null and s.expires_at>now()
             and s.activity_lease_id is null and not s.application_secret_tainted`,
            [sandboxId, selection.idleCheckpointRequest],
          );
          if (!proof.rows.length) deny();
          workMerged = proof.rows[0]?.work_merged === true;
        }
        const request = await machine(tx, row, selection.operation);
        const job: Job =
          selection.operation === "bootstrap" || selection.operation === "resume"
            ? {
                requestId: selection.requestId,
                operation: selection.operation,
                request,
                bootstrap: selection.bootstrapDescriptor,
              }
            : { requestId: selection.requestId, operation: selection.operation, request };
        input(job);
        const enqueue = async () =>
          insert(tx, host.id, job, {
            bound_sandbox_id: sandboxId,
            bound_actor_id: actor.userId,
            bound_actor_epoch: epoch,
            bound_operation: selection.operation,
          });
        if (known) return enqueue();
        if (selection.operation === "bootstrap" || selection.operation === "resume") {
          // This lookup takes no source locks. Reject a foreign capability before
          // the validator can acquire any of that sandbox's membership locks.
          const ticket = (
            await tx.query<{ sandbox_id: string }>(
              `select sandbox_id from public.runtime_enrolments where enrolment_hash=$1`,
              [createHash("sha256").update(selection.bootstrapDescriptor.enrolmentToken).digest("hex")],
            )
          ).rows[0];
          if (ticket?.sandbox_id !== sandboxId) deny();
          // All source members, host and sandbox are exclusively prelocked. Reuse the
          // existing capability validator in this very transaction, never a nested one.
          return createRuntimeEnrolments(scopedRuntimeSql(tx), key).withBootstrap(
            selection.bootstrapDescriptor.enrolmentToken,
            async (_tx, scope) => {
              if (scope.sandboxId !== sandboxId) deny();
              return enqueue();
            },
          );
        }
        if (selection.operation === "stop")
          await tx.query(
            `update public.sandboxes set status='stopping',status_reason=coalesce($2::text,status_reason),stop_requested_at=coalesce(stop_requested_at,now()),
           lifecycle_generation=lifecycle_generation+1 where id=$1 and status in ('starting','ready','running')`,
            [
              sandboxId,
              selection.idleCheckpointRequest === undefined ? null : workMerged ? "work_merged" : "idle_paused",
            ],
          );
        return enqueue();
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
          `select 1 from public.docker_host_jobs where host_id=$1 and outcome is null limit 1`,
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
        await this.enqueueSandbox({ userId: drain.host.owner_id, orgId: drain.host.org_id }, row.id, {
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
      snapshotBaselineVersion?: number,
    ): Promise<Job | null> {
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
           where h.hash=$1 and h.installation_id=$2 and j.outcome is null and (not $3::boolean or j.snapshot_id is null) and ${notRunning(4)} order by case when j.bound_operation in ('stop','delete') then 0 else 1 end,(j.snapshot_id is not null),j.position limit 1`,
            [hash(hostToken), installationId, skipSnapshots, running],
          )
        ).rows[0];
        const host =
          hint?.bound_sandbox_id && ["stop", "delete"].includes(hint.bound_operation ?? "")
            ? await reconcileHost(tx, hostToken, installationId, hint.bound_actor_id ?? undefined)
            : await authenticate(tx, hostToken, installationId, hint?.bound_actor_id ?? undefined);
        await tx.query(
          `update public.docker_hosts set last_seen_at=now(),daemon_version=$2,resource_policy_version=$3,available_cpus=null,available_memory_bytes=null,disk_free_bytes=$4,stopped_sandbox_bytes=$5,snapshot_baseline_version=$6 where id=$1`,
          [
            host.id,
            version ?? null,
            resourcePolicyVersion ?? null,
            diskFreeBytes ?? null,
            stoppedSandboxBytes ?? null,
            snapshotBaselineVersion ?? null,
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
        const refusals = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j join public.sandboxes s on s.id=j.bound_sandbox_id
             where j.host_id=$1 and j.refused_resume_generation is not null
             and j.outcome='completed' and j.cancelled_at is null
             and s.docker_host_id=$1 and s.docker_installation_id=$2
             and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
             and s.status='starting' and s.lifecycle_generation=j.refused_resume_generation
             order by j.position`,
            [host.id, installationId],
          )
        ).rows;
        for (const refusal of refusals) {
          const logical = await boundMachine(tx, refusal, host, installationId);
          await settleRefusedResume(tx, logical, refusal);
        }
        // Older servers acknowledged failed startup without terminalizing the
        // logical row. Reconcile that saved fact without replaying the machine.
        const histories = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j join public.sandboxes s on s.id=j.bound_sandbox_id
             where j.host_id=$1 and j.outcome='failed' and j.bound_operation in ('create','bootstrap')
             and s.provider='docker' and s.docker_host_id=$1 and s.docker_installation_id=$2
             and s.status in ('starting','ready','running','stopping') order by j.position`,
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
          if (verified) {
            await startupFailed(tx, verified, historical);
            break;
          }
        }
        const row = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j where j.host_id=$1 and j.outcome is null and (not $2::boolean or j.snapshot_id is null) and ${notRunning(3)} order by case when j.bound_operation in ('stop','delete') then 0 else 1 end,(j.snapshot_id is not null),j.position limit 1`,
            [host.id, skipSnapshots, running],
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
          try {
            const logical = await boundMachine(tx, row, host, installationId);
            verified = logical;
            await permission(
              tx,
              { userId: row.bound_actor_id ?? deny(), orgId: host.org_id },
              logical,
              row.bound_operation ?? deny(),
              row.bound_actor_epoch,
            );
            await state(tx, logical, row.bound_operation ?? deny());
            await machine(tx, logical, row.bound_operation ?? deny());
            // Create pickup belongs to activation 1. Resume timing comes from its durable host claim.
            if (row.bound_operation === "create")
              await recordLaunchStageForActivation(tx, logical.id, 1, "provider_claimed");
          } catch (error) {
            if (!(error instanceof DockerHostDenied)) throw error;
            if (verified) await startupFailed(tx, verified, row);
            await tx.query(
              `update public.docker_host_jobs set outcome='failed',completed_at=now() where request_id=$1 and outcome is null`,
              [row.request_id],
            );
            return null;
          }
        }
        return readJob(row);
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
        if (!job.bound_sandbox_id || job.bound_operation === "buildSnapshot") deny();
        const logical = await boundMachine(tx, job, host, installationId);
        // Status repeats across lifecycles; mailbox ordering identifies which
        // lifecycle owns this fact even after a later resume has stopped again.
        if (await supersededLifecycle(tx, job)) return;
        // Physical cleanup is an authenticated machine fact, not owner delete intent.
        await tx.query(
          `update public.sandboxes set status='deleted',status_reason=case when status='deleted' and status_reason in ('retention_elapsed','disk_pressure') then status_reason else $2 end,deleted_at=coalesce(deleted_at,now()),
           stopped_at=coalesce(stopped_at,now()),lifecycle_generation=lifecycle_generation+case when status='deleted' then 0 else 1 end
           where id=$1`,
          [logical.id, result.cleanupReason ?? "retention_elapsed"],
        );
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
          const host = await authenticate(tx, hostToken, installationId);
          const job =
            (
              await tx.query<StoredJob>(
                `select * from public.docker_host_jobs where host_id=$1 and request_id=$2
               and bound_operation in ('create','bootstrap','resume') and bound_sandbox_id is not null`,
                [host.id, requestId],
              )
            ).rows[0] ?? deny();
          const logical = await boundMachine(tx, job, host, installationId);
          const predicate = `id=$1 and not application_secret_tainted and ${DOCKER_RETAINED_OUTPUT_STOP}`;
          return (
            await tx.query<{ id: string; generation: string; scan: string; provider_sandbox_id: string }>(
              expectedGeneration !== undefined
                ? `update public.sandboxes set outputs_checked_at=clock_timestamp() where ${predicate}
                   and lifecycle_generation=$2::bigint
                   returning id,lifecycle_generation::text as generation,outputs_checked_at::text as scan,provider_sandbox_id`
                : `select id,lifecycle_generation::text as generation,outputs_checked_at::text as scan,provider_sandbox_id
                   from public.sandboxes where ${predicate}`,
              expectedGeneration === undefined ? [logical.id] : [logical.id, expectedGeneration],
            )
          ).rows[0];
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
      if (!row) return 204;
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
        undefined,
        row.generation,
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
        if (job.bound_operation !== "create" && job.bound_operation !== "bootstrap" && job.bound_operation !== "resume")
          deny();
        const logical = await boundMachine(tx, job, host, installationId);
        // Only the authenticated host's observed physical stop is evidence. SQL's
        // clock may differ from the frozen host deadline and cannot prove exit.
        await tx.query(
          `update public.sandboxes set
           status=case when status='failed' then status else 'stopped' end,
           status_reason=case when status='failed' or status_reason in ('agent_finished','work_merged') then status_reason else 'expired' end,
           stopped_at=coalesce(stopped_at,now()),stop_requested_at=coalesce(stop_requested_at,now()),
           lifecycle_generation=lifecycle_generation+case when status in ('starting','ready','running','stopping') then 1 else 0 end
           where id=$1 and status in ('starting','ready','running','stopping','stopped','failed')`,
          [logical.id],
        );
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
        baselineVersion?: number;
        baselineTool?: SnapshotBaselineTool;
        missingRefIndex?: number;
      },
    ) {
      return transaction(async (tx) => {
        exact(result, [
          "requestId",
          "outcome",
          ...(result.reason !== undefined ? ["reason"] : []),
          ...(result.imageId !== undefined ? ["imageId"] : []),
          ...(result.baselineVersion !== undefined ? ["baselineVersion"] : []),
          ...(result.baselineTool !== undefined ? ["baselineTool"] : []),
          ...(result.missingRefIndex !== undefined ? ["missingRefIndex"] : []),
        ]);
        if (
          result.reason !== undefined &&
          (result.outcome !== "failed" || !DOCKER_JOB_FAILURE_REASONS.includes(result.reason))
        )
          deny();
        id(result.requestId);
        if (result.outcome !== "completed" && result.outcome !== "failed") deny();
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
              peek.bound_operation === "resume" ? (peek.bound_actor_id ?? undefined) : undefined,
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
        const logical = hint.bound_sandbox_id ? await boundMachine(tx, hint, host, installationId) : undefined;
        const jobs = await tx.query<StoredJob>(
          `select * from public.docker_host_jobs where host_id=$1 and request_id=$2 for update`,
          [host.id, result.requestId],
        );
        const job = jobs.rows[0] ?? deny();
        // A cancelled job's server outcome is not a machine fact. The first host
        // receipt replaces it; after that, terminal facts are immutable.
        if (
          job.outcome !== null &&
          job.cancelled_at === null &&
          (job.outcome !== result.outcome || (job.result_image_id ?? null) !== (result.imageId ?? null))
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
        // A repeated same-outcome machine fact also repairs a logical transition
        // missed by an earlier server; conflicting facts still fail above.
        if (logical) {
          if (result.outcome === "completed") {
            await settleRefusedResume(tx, logical, job);
          } else if (job.outcome !== null || !(await settleRefusedResume(tx, logical, job))) {
            await startupFailed(tx, logical, job, result.reason);
          }
        }
        // Persist terminal receipts below, but never replay old stop/delete
        // effects onto a lifecycle admitted after that job.
        const staleCleanup =
          (job.bound_operation === "stop" || job.bound_operation === "delete") && (await supersededLifecycle(tx, job));
        if (result.outcome === "completed" && job.bound_sandbox_id && !staleCleanup) {
          // #2560: the host created and started the container. A create job only exists for the inserted row, so it
          // belongs to the launch (activation 1): a replayed or late create ACK must never date a later resume. A
          // resume restores inside its bootstrap job, so its machine start is the bootstrap's first report instead
          // (see runtime-progress).
          if (job.bound_operation === "create")
            await recordLaunchStageForActivation(tx, job.bound_sandbox_id, 1, "machine_started");
          if (job.bound_operation === "stop")
            await tx.query(
              `update public.sandboxes set status=case when status='failed' then status else 'stopped' end,
               stopped_at=coalesce(stopped_at,now()) where id=$1 and status in ('stopping','failed','stopped')`,
              [job.bound_sandbox_id],
            );
          // A self-finish stop is a durable cleanup intent, not retained idle compute.
          // Enqueue removal in this same ACK transaction; a lost ACK can safely repair it.
          if (job.bound_operation === "stop" && logical?.status_reason === "agent_finished") {
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
              await insert(
                tx,
                host.id,
                {
                  requestId: randomUUID(),
                  operation: "delete",
                  request: await machine(tx, current, "delete"),
                },
                {
                  bound_sandbox_id: current.id,
                  bound_actor_id: current.owner_id,
                  bound_actor_epoch: epoch,
                  bound_operation: "delete",
                },
              );
            }
          }
          if (job.bound_operation === "delete")
            await tx.query(
              `update public.sandboxes set status='deleted',status_reason=null,deleted_at=coalesce(deleted_at,now())
               where id=$1 and status in ('stopped','failed','deleted')`,
              [job.bound_sandbox_id],
            );
        }
        // The first host receipt is the terminal machine fact. Clearing
        // cancelled_at in the same write makes later conflicting receipts fail
        // the immutability check above, and lets capacity follow the normal rule:
        // a completed create/resume reserves, a failed one stays reserved until a
        // physical stop/delete/expiry proves the machine is gone.
        if (job.outcome === null || job.cancelled_at !== null) {
          await tx.query(
            `update public.docker_host_jobs set outcome=$2,completed_at=now(),result_image_id=$3,cancelled_at=null where request_id=$1`,
            [result.requestId, result.outcome, result.imageId ?? null],
          );
        }
      });
    },
  };
}
