import { randomUUID } from "node:crypto";
import {
  DEFAULT_LAUNCH_TTL_SECONDS,
  HARNESS_KINDS,
  HARNESSES,
  type Harness,
  resolveModelChoice,
  type SandboxRecord,
  type Sql,
} from "@armada/core";
import { createDockerHostStore } from "./docker-host-store.ts";

type Actor = { userId: string; orgId: string };
type Reservation = {
  requestId: string;
  hostId: string;
  image: string;
  harness?: Harness;
  credentialId: string;
  credentialVersion: number;
  model?: string;
  reasoningEffort?: string;
  ttlSeconds?: number;
};
type Row = {
  id: string;
  org_id: string;
  owner_id: string;
  provider: string;
  provider_sandbox_id: string;
  docker_host_id: string;
  docker_installation_id: string;
  docker_generation: string;
  docker_image: string;
  harness: Harness;
  visibility: string;
  status: SandboxRecord["status"];
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class DockerSandboxDenied extends Error {
  constructor() {
    super("Docker sandbox denied");
    this.name = "DockerSandboxDenied";
  }
}
function deny(): never {
  throw new DockerSandboxDenied();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) deny();
}
function actorInput(actor: Actor) {
  if (!actor || Object.keys(actor).sort().join() !== "orgId,userId") deny();
  id(actor.userId);
  id(actor.orgId);
}
function normalize(input: Reservation) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "requestId",
          "hostId",
          "image",
          "harness",
          "credentialId",
          "credentialVersion",
          "model",
          "reasoningEffort",
          "ttlSeconds",
        ].includes(key),
    )
  )
    deny();
  id(input.requestId);
  id(input.hostId);
  id(input.credentialId);
  if (
    typeof input.image !== "string" ||
    input.image.length > 512 ||
    !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(input.image) ||
    !Number.isSafeInteger(input.credentialVersion) ||
    input.credentialVersion < 1 ||
    (input.model !== undefined && typeof input.model !== "string") ||
    (input.reasoningEffort !== undefined && typeof input.reasoningEffort !== "string")
  )
    deny();
  const harness = input.harness ?? "codex";
  if (!HARNESSES.includes(harness)) deny();
  const ttlSeconds = input.ttlSeconds === undefined ? DEFAULT_LAUNCH_TTL_SECONDS : input.ttlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) deny();
  return { ...input, ...resolveModelChoice(harness, input), harness, ttlSeconds };
}
function record(row: Row) {
  return {
    id: row.id,
    provider: "docker" as const,
    providerSandboxId: row.provider_sandbox_id,
    hostId: row.docker_host_id,
    installationId: row.docker_installation_id,
    generation: row.docker_generation,
    image: row.docker_image,
    ownerId: row.owner_id,
    orgId: row.org_id,
    harness: row.harness,
    visibility: "private" as const,
    status: row.status,
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
    stopRequestedAt: row.stop_requested_at === null ? null : new Date(row.stop_requested_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    ttlSeconds: row.effective_ttl_seconds,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    credentialId: row.credential_id,
    credentialVersion: row.credential_version,
    repositoryDir: null,
  };
}

/** Private, dark reservation boundary. Callers still own model-account policy and resolution.
 * Retained retries require current host/actor authority but not a still-active account:
 * admission is historical, and reconciliation must never allocate a replacement.
 */
export function createDockerSandboxService(sql: Sql, key: string, options: { enabled?: boolean } = {}) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      if (!sql.transaction) deny();
      return await sql.transaction(work);
    } catch {
      return deny();
    }
  }
  async function visible(tx: Sql, actor: Actor, sandboxId: string) {
    actorInput(actor);
    id(sandboxId);
    const row = (
      await tx.query<Row>(
        `select s.* from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
       where s.id=$1 and s.org_id=$3 and s.provider='docker' and (s.owner_id=$2 or m.role='admin')`,
        [sandboxId, actor.userId, actor.orgId],
      )
    ).rows[0];
    return row ?? deny();
  }
  function cleanup(actor: Actor, sandboxId: string, requestId: string, operation: "stop" | "delete") {
    return transaction(async (tx) => {
      await visible(tx, actor, sandboxId);
      id(requestId);
      const scoped: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
      return createDockerHostStore(scoped, key).enqueueSandbox(actor, sandboxId, { requestId, operation });
    });
  }
  return {
    reserve(actor: Actor, input: Reservation) {
      return transaction(async (tx) => {
        if (options.enabled !== true) deny();
        actorInput(actor);
        const request = normalize(input);
        const hint =
          (
            await tx.query<{ owner_id: string; installation_id: string }>(
              `select owner_id,installation_id from public.docker_hosts where id=$1 and org_id=$2`,
              [request.hostId, actor.orgId],
            )
          ).rows[0] ?? deny();
        // Exclusive prelocks precede the INSERT trigger's SHARE locks and the bound store.
        const members = await tx.query<{ user_id: string }>(
          `select user_id from public.members where org_id=$1 and user_id in ($2,$3) order by user_id for update`,
          [actor.orgId, actor.userId, hint.owner_id],
        );
        const present = new Set(members.rows.map((member) => member.user_id));
        if (!present.has(actor.userId) || !present.has(hint.owner_id)) deny();
        await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`docker-reserve:${request.requestId}`]);
        const existing = (await tx.query<Row>(`select * from public.sandboxes where id=$1`, [request.requestId]))
          .rows[0];
        // Revalidate before host/sandbox locks, without consulting account values.
        if (!existing) {
          const credential = await tx.query(
            `select id from public.credentials where id=$1 and version=$2 and kind = any($5::public.credential_kind[])
             and status='active' and (expires_at is null or expires_at>now())
             and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
            [
              request.credentialId,
              request.credentialVersion,
              actor.userId,
              actor.orgId,
              HARNESS_KINDS[request.harness],
            ],
          );
          if (!credential.rows.length) deny();
        }
        const host =
          (
            await tx.query<{ installation_id: string }>(
              `select installation_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
           and installation_id=$4 and hash is not null and registration_hash is null and revoked_at is null for update`,
              [request.hostId, actor.orgId, hint.owner_id, hint.installation_id],
            )
          ).rows[0] ?? deny();
        if (existing) {
          const row =
            (await tx.query<Row>(`select * from public.sandboxes where id=$1 for update`, [request.requestId]))
              .rows[0] ?? deny();
          if (
            row.provider !== "docker" ||
            row.owner_id !== actor.userId ||
            row.org_id !== actor.orgId ||
            row.docker_host_id !== request.hostId ||
            row.docker_installation_id !== host.installation_id ||
            row.docker_image !== request.image ||
            row.credential_id !== request.credentialId ||
            row.credential_version !== request.credentialVersion ||
            row.harness !== request.harness ||
            row.model !== request.model ||
            row.reasoning_effort !== request.reasoningEffort ||
            row.effective_ttl_seconds !== request.ttlSeconds
          )
            deny();
          const managed = await tx.query(
            `select 1 from public.docker_host_jobs j join public.mcp_actor_epochs e
             on e.org_id=$3 and e.user_id=$2 and e.epoch=j.bound_actor_epoch
             where j.request_id=$1 and j.bound_sandbox_id=$1 and j.bound_actor_id=$2
             and j.host_id=$4 and j.bound_operation='create'`,
            [row.id, actor.userId, actor.orgId, request.hostId],
          );
          if (!managed.rows.length) deny();
          return record(row);
        }
        const generation = randomUUID();
        const physical = `armada-${host.installation_id}-${request.hostId}-${request.requestId}-${generation}`;
        const row =
          (
            await tx.query<Row>(
              `insert into public.sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,visibility,access_owner_id,
           docker_host_id,docker_installation_id,docker_generation,docker_image,model,reasoning_effort,
           credential_id,credential_version,effective_ttl_seconds,expires_at,requested_ttl_seconds)
           values($1,$2,$3,'docker',$4,$15,'starting','private',$3,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           now()+$13::integer*interval '1 second',$14) returning *`,
              [
                request.requestId,
                actor.orgId,
                actor.userId,
                physical,
                request.hostId,
                host.installation_id,
                generation,
                request.image,
                request.model,
                request.reasoningEffort,
                request.credentialId,
                request.credentialVersion,
                request.ttlSeconds,
                input.ttlSeconds ?? null,
                request.harness,
              ],
            )
          ).rows[0] ?? deny();
        const scoped: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
        await createDockerHostStore(scoped, key).enqueueSandbox(actor, row.id, {
          requestId: row.id,
          operation: "create",
        });
        return record(row);
      });
    },
    get(actor: Actor, sandboxId: string) {
      return transaction(async (tx) => record(await visible(tx, actor, sandboxId)));
    },
    stop(actor: Actor, sandboxId: string, requestId: string) {
      return cleanup(actor, sandboxId, requestId, "stop");
    },
    delete(actor: Actor, sandboxId: string, requestId: string) {
      return cleanup(actor, sandboxId, requestId, "delete");
    },
    job(actor: Actor, sandboxId: string, requestId: string) {
      return transaction(async (tx) => {
        await visible(tx, actor, sandboxId);
        id(requestId);
        const job = (
          await tx.query<{ request_id: string; bound_operation: string; outcome: "completed" | "failed" | null }>(
            `select request_id,bound_operation,outcome from public.docker_host_jobs where request_id=$1 and bound_sandbox_id=$2`,
            [requestId, sandboxId],
          )
        ).rows[0];
        return job
          ? { requestId: job.request_id, operation: job.bound_operation, state: job.outcome ?? "pending" }
          : null;
      });
    },
  };
}
