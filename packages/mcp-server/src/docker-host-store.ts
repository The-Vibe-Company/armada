import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";

import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

type Actor = { userId: string; orgId: string };
type Job = DockerHostJob;
type Host = { id: string; org_id: string; owner_id: string };
type Bound = {
  bound_sandbox_id: string | null;
  bound_actor_id: string | null;
  bound_actor_epoch: string | null;
  bound_operation: string | null;
};
type StoredJob = Bound & {
  request_id: string;
  host_id: string;
  input_enc: Uint8Array<ArrayBuffer>;
  outcome: string | null;
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
  effective_ttl_seconds: number;
  expires_at: Date | string;
  status: string;
  stop_requested_at: unknown;
  deleted_at: unknown;
};
type Selection = { requestId: string } & (
  | { operation: "create" | "stop" | "delete" }
  | { operation: "bootstrap"; bootstrapDescriptor: BootstrapDescriptor }
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{64}$/;

export class DockerHostDenied extends Error {
  constructor() {
    super("Docker host denied");
    this.name = "DockerHostDenied";
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
function input(job: Job): string {
  try {
    return canonicalDockerHostJob(job);
  } catch {
    return deny();
  }
}

/** Internal service-role store, deliberately not mounted as a route or wired into placement.
 * Poll is at-least-once; a host must serialize execution and deduplicate request IDs durably.
 * Only trusted internal bootstrap tickets enter this mailbox; no model credentials or arbitrary execution payloads.
 */
export function createDockerHostStore(sql: Sql, key: string) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      if (!sql.transaction) deny();
      return await sql.transaction(work);
    } catch {
      return deny();
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
  async function insert(tx: Sql, hostId: string, job: Job, bound?: Bound) {
    const canonical = input(job);
    // Deliberately incompatible with old strict mailbox readers: a mixed-version
    // server must fail closed, never deliver bound work without actor admission.
    const serialized = bound ? JSON.stringify({ bound: 1, job: JSON.parse(canonical) }) : canonical;
    const metadata = bound ?? {
      bound_sandbox_id: null,
      bound_actor_id: null,
      bound_actor_epoch: null,
      bound_operation: null,
    };
    await tx.query(
      `insert into public.docker_host_jobs(request_id,host_id,input_enc,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation)
       values($1,$2,$3,$4,$5,$6,$7) on conflict(request_id) do nothing`,
      [
        job.requestId,
        hostId,
        await encryptSecret(serialized, key),
        metadata.bound_sandbox_id,
        metadata.bound_actor_id,
        metadata.bound_actor_epoch,
        metadata.bound_operation,
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
    return { requestId: job.requestId };
  }
  async function readJob(row: StoredJob): Promise<Job> {
    let stored: unknown = JSON.parse(await decryptSecret(row.input_enc, key));
    if (row.bound_sandbox_id !== null) {
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
      return {
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
      saved.request.expiresAt === undefined
    )
      deny();
    if (operation === "bootstrap" && original.outcome !== "completed") deny();
    return saved.request;
  }
  return {
    issueRegistration(actor: Actor) {
      return transaction(async (tx) => {
        await admin(tx, actor);
        const hostId = randomUUID(),
          registrationToken = randomBytes(32).toString("hex");
        await tx.query(
          `insert into public.docker_hosts(id,org_id,owner_id,registration_hash,registration_expires_at)
          values($1,$2,$3,$4,now()+interval '5 minutes')`,
          [hostId, actor.orgId, actor.userId, hash(registrationToken)],
        );
        return { hostId, registrationToken };
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
    revoke(actor: Actor, hostId: string) {
      return transaction(async (tx) => {
        await owned(tx, actor, hostId);
        await tx.query(
          `update public.docker_hosts set revoked_at=now(),registration_hash=null,hash=null,installation_id=null where id=$1`,
          [hostId],
        );
      });
    },
    enqueue(actor: Actor, hostId: string, job: Job) {
      return transaction(async (tx) => {
        input(job);
        await owned(tx, actor, hostId);
        return insert(tx, hostId, job);
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
          ...(selection.operation === "bootstrap" ? ["bootstrapDescriptor"] : []),
        ]);
        id(selection.requestId);
        if (!["create", "bootstrap", "stop", "delete"].includes(selection.operation)) deny();
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
        if (!locked.has(actor.userId) || !locked.has(hint.issuer_id)) deny();
        const host =
          (
            await tx.query<Host>(
              `select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
           and installation_id=$4 and hash is not null and registration_hash is null and revoked_at is null for update`,
              [hint.docker_host_id, actor.orgId, hint.issuer_id, hint.docker_installation_id],
            )
          ).rows[0] ?? deny();
        const row = await sandbox(tx, sandboxId, host, hint.docker_installation_id);
        if (row.owner_id !== hint.owner_id) deny();
        const epoch = await permission(tx, actor, row, selection.operation);
        // The host lock serializes admission: observe an existing request only
        // after waiting, so concurrent lost-response retries reconcile too.
        const known =
          (await tx.query(`select 1 from public.docker_host_jobs where request_id=$1`, [selection.requestId])).rows
            .length > 0;
        if (!known) await state(tx, row, selection.operation);
        const request = await machine(tx, row, selection.operation);
        const job: Job =
          selection.operation === "bootstrap"
            ? {
                requestId: selection.requestId,
                operation: "bootstrap",
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
        if (selection.operation === "bootstrap") {
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
          const scoped: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
          return createRuntimeEnrolments(scoped, key).withBootstrap(
            selection.bootstrapDescriptor.enrolmentToken,
            async (_tx, scope) => {
              if (scope.sandboxId !== sandboxId) deny();
              return enqueue();
            },
          );
        }
        if (selection.operation === "stop")
          await tx.query(
            `update public.sandboxes set status='stopping',stop_requested_at=coalesce(stop_requested_at,now()),
           lifecycle_generation=lifecycle_generation+1 where id=$1 and status in ('starting','ready','running')`,
            [sandboxId],
          );
        return enqueue();
      });
    },
    poll(hostToken: string, installationId: string): Promise<Job | null> {
      return transaction(async (tx) => {
        // Peek before member/host locks: never acquire a late actor lock behind the host.
        const hint = (
          await tx.query<StoredJob>(
            `select j.* from public.docker_host_jobs j join public.docker_hosts h on h.id=j.host_id
           where h.hash=$1 and h.installation_id=$2 and h.revoked_at is null and j.outcome is null order by j.position limit 1`,
            [hash(hostToken), installationId],
          )
        ).rows[0];
        const host = await authenticate(tx, hostToken, installationId, hint?.bound_actor_id ?? undefined);
        await tx.query(`update public.docker_hosts set last_seen_at=now() where id=$1`, [host.id]);
        const row = (
          await tx.query<StoredJob>(
            `select * from public.docker_host_jobs where host_id=$1 and outcome is null order by position limit 1`,
            [host.id],
          )
        ).rows[0];
        if (!row || row.request_id !== hint?.request_id) return null;
        if (row.bound_sandbox_id) {
          try {
            const logical = await sandbox(tx, row.bound_sandbox_id, host, installationId);
            await permission(
              tx,
              { userId: row.bound_actor_id ?? deny(), orgId: host.org_id },
              logical,
              row.bound_operation ?? deny(),
              row.bound_actor_epoch,
            );
            await state(tx, logical, row.bound_operation ?? deny());
            await machine(tx, logical, row.bound_operation ?? deny());
          } catch (error) {
            if (!(error instanceof DockerHostDenied)) throw error;
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
    complete(
      hostToken: string,
      installationId: string,
      result: { requestId: string; outcome: "completed" | "failed" },
    ) {
      return transaction(async (tx) => {
        exact(result, ["requestId", "outcome"]);
        id(result.requestId);
        if (result.outcome !== "completed" && result.outcome !== "failed") deny();
        const host = await authenticate(tx, hostToken, installationId);
        const hint =
          (
            await tx.query<StoredJob>(`select * from public.docker_host_jobs where host_id=$1 and request_id=$2`, [
              host.id,
              result.requestId,
            ])
          ).rows[0] ?? deny();
        if (hint.bound_sandbox_id) await sandbox(tx, hint.bound_sandbox_id, host, installationId);
        const jobs = await tx.query<StoredJob>(
          `select * from public.docker_host_jobs where host_id=$1 and request_id=$2 for update`,
          [host.id, result.requestId],
        );
        const job = jobs.rows[0] ?? deny();
        if (job.outcome !== null && job.outcome !== result.outcome) deny();
        // A repeated same-outcome machine fact also repairs a logical transition
        // missed by an earlier server; conflicting facts still fail above.
        if (result.outcome === "completed" && job.bound_sandbox_id) {
          if (job.bound_operation === "stop")
            await tx.query(
              `update public.sandboxes set status='stopped',stopped_at=now() where id=$1 and status='stopping'`,
              [job.bound_sandbox_id],
            );
          if (job.bound_operation === "delete")
            await tx.query(
              `update public.sandboxes set status='deleted',deleted_at=coalesce(deleted_at,now())
               where id=$1 and status in ('stopped','failed','deleted')`,
              [job.bound_sandbox_id],
            );
        }
        if (job.outcome === null) {
          await tx.query(`update public.docker_host_jobs set outcome=$2,completed_at=now() where request_id=$1`, [
            result.requestId,
            result.outcome,
          ]);
        }
      });
    },
  };
}
