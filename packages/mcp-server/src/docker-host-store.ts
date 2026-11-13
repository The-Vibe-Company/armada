import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { DockerMachineRequest } from "../../core/src/docker-machine.ts";

type Actor = { userId: string; orgId: string };
type Job = { requestId: string; request: DockerMachineRequest; operation: "create" | "stop" | "delete" };
type Host = { id: string; org_id: string; owner_id: string };
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
  exact(job, ["requestId", "operation", "request"]);
  id(job.requestId);
  if (!["create", "stop", "delete"].includes(job.operation)) deny();
  const request = job.request;
  exact(request, ["sandboxId", "generation", "image", "ttlSeconds"]);
  id(request.sandboxId);
  id(request.generation);
  if (
    typeof request.image !== "string" ||
    request.image.length > 512 ||
    !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(request.image) ||
    !Number.isInteger(request.ttlSeconds) ||
    request.ttlSeconds < 1 ||
    request.ttlSeconds > 86_400
  )
    deny();
  return JSON.stringify({
    operation: job.operation,
    request: {
      sandboxId: request.sandboxId,
      generation: request.generation,
      image: request.image,
      ttlSeconds: request.ttlSeconds,
    },
  });
}

/** Internal service-role store, deliberately not mounted as a route or wired into placement.
 * Poll is at-least-once; a host must serialize execution and deduplicate request IDs durably.
 * No bootstrap, model credentials, stdout or arbitrary error payloads enter this mailbox.
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
  async function authenticate(tx: Sql, hostToken: string, installationId: string) {
    id(installationId);
    const result = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts
      where hash=$1 and installation_id=$2 and revoked_at is null`,
      [hash(hostToken), installationId],
    );
    const host = result.rows[0] ?? deny();
    const member = await tx.query(`select 1 from public.members where org_id=$1 and user_id=$2 for share`, [
      host.org_id,
      host.owner_id,
    ]);
    if (!member.rows.length) deny();
    // Membership -> host -> job is the lock order for every operation. Recheck the
    // credential after taking the host lock so a concurrent revoke cannot slip through.
    const locked = await tx.query<Host>(
      `select id,org_id,owner_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
       and hash=$4 and installation_id=$5 and revoked_at is null for update`,
      [host.id, host.org_id, host.owner_id, hash(hostToken), installationId],
    );
    return locked.rows[0] ?? deny();
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
        const serialized = input(job);
        await owned(tx, actor, hostId);
        const sealed = await encryptSecret(serialized, key);
        await tx.query(
          `insert into public.docker_host_jobs(request_id,host_id,input_enc) values($1,$2,$3) on conflict(request_id) do nothing`,
          [job.requestId, hostId, sealed],
        );
        const result = await tx.query<{ host_id: string; input_enc: Uint8Array<ArrayBuffer> }>(
          `select host_id,input_enc from public.docker_host_jobs where request_id=$1`,
          [job.requestId],
        );
        const existing = result.rows[0] ?? deny();
        if (existing.host_id !== hostId || (await decryptSecret(existing.input_enc, key)) !== serialized) deny();
        return { requestId: job.requestId };
      });
    },
    poll(hostToken: string, installationId: string): Promise<Job | null> {
      return transaction(async (tx) => {
        const host = await authenticate(tx, hostToken, installationId);
        await tx.query(`update public.docker_hosts set last_seen_at=now() where id=$1`, [host.id]);
        const result = await tx.query<{ request_id: string; input_enc: Uint8Array<ArrayBuffer> }>(
          `select request_id,input_enc from public.docker_host_jobs where host_id=$1 and outcome is null order by position limit 1`,
          [host.id],
        );
        const row = result.rows[0];
        if (!row) return null;
        const job: Job = { ...JSON.parse(await decryptSecret(row.input_enc, key)), requestId: row.request_id };
        input(job);
        return job;
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
        const jobs = await tx.query<{ outcome: string | null }>(
          `select outcome from public.docker_host_jobs where host_id=$1 and request_id=$2 for update`,
          [host.id, result.requestId],
        );
        const job = jobs.rows[0] ?? deny();
        if (job.outcome !== null && job.outcome !== result.outcome) deny();
        if (job.outcome === null)
          await tx.query(`update public.docker_host_jobs set outcome=$2,completed_at=now() where request_id=$1`, [
            result.requestId,
            result.outcome,
          ]);
      });
    },
  };
}
