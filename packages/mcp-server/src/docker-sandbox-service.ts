import {
  DEFAULT_LAUNCH_TTL_SECONDS,
  HARNESS_KINDS,
  HARNESSES,
  type Harness,
  isDockerImageReference,
  resolveModelChoice,
  type Sql,
  VaultError,
} from "@armada/core";
import { admitLaunchPlan, isLaunchTtlSeconds } from "@armada/core/server";
import { admitLaunchAccount } from "./account-capacity.ts";
import {
  admitDockerCapacity,
  admitDockerDisk,
  DockerHostDraining,
  DockerHostFull,
  DockerLimitsRefused,
} from "./docker-capacity.ts";
import { hostDrainingSql } from "./docker-host-drain.ts";
import { createDockerMachineGenerationBindings } from "./docker-machine-bindings.ts";
import { resolveDockerSnapshot } from "./docker-snapshot-data.ts";
import { type DockerSandboxRow, insertStartingDockerSandbox } from "./sandbox-lifecycle.ts";

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
  stopWhenWorkMerged?: boolean;
  externalRef?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class DockerSandboxDenied extends Error {
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
          "stopWhenWorkMerged",
          "externalRef",
        ].includes(key),
    )
  )
    deny();
  id(input.requestId);
  id(input.hostId);
  id(input.credentialId);
  if (
    !isDockerImageReference(input.image) ||
    !Number.isSafeInteger(input.credentialVersion) ||
    input.credentialVersion < 1 ||
    (input.externalRef !== undefined && typeof input.externalRef !== "string") ||
    (input.model !== undefined && typeof input.model !== "string") ||
    (input.reasoningEffort !== undefined && typeof input.reasoningEffort !== "string")
  )
    deny();
  const harness = input.harness ?? "codex";
  if (!HARNESSES.includes(harness)) deny();
  if (input.stopWhenWorkMerged !== undefined && typeof input.stopWhenWorkMerged !== "boolean") deny();
  const ttlSeconds = input.ttlSeconds === undefined ? DEFAULT_LAUNCH_TTL_SECONDS : input.ttlSeconds;
  if (!isLaunchTtlSeconds("docker", ttlSeconds)) deny();
  return { ...input, ...resolveModelChoice(harness, input), harness, ttlSeconds };
}
function record(row: DockerSandboxRow) {
  return {
    id: row.id,
    provider: "docker" as const,
    providerSandboxId: row.provider_sandbox_id,
    lifecycleGeneration: Number(row.lifecycle_generation),
    conversationIds: row.conversation_ids,
    taskPromptId: row.task_prompt_id,
    hostId: row.docker_host_id,
    installationId: row.docker_installation_id,
    generation: row.docker_generation,
    image: row.docker_image,
    snapshotId: row.docker_snapshot_id ?? null,
    ownerId: row.owner_id,
    orgId: row.org_id,
    harness: row.harness,
    visibility: "private" as const,
    status: row.status,
    statusReason: row.status_reason ?? null,
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

/** Reserve a Docker sandbox inside the normal launch transaction. */
export function createDockerSandboxService(sql: Sql) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      if (!sql.transaction) deny();
      return await sql.transaction(work);
    } catch (error) {
      // Only trusted transaction-local placement policy raises public VaultError refusals.
      if (
        error instanceof VaultError ||
        error instanceof DockerHostFull ||
        error instanceof DockerHostDraining ||
        error instanceof DockerLimitsRefused
      )
        throw error;
      return deny();
    }
  }
  async function visible(tx: Sql, actor: Actor, sandboxId: string) {
    actorInput(actor);
    id(sandboxId);
    const row = (
      await tx.query<DockerSandboxRow>(
        `select s.* from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
       where s.id=$1 and s.org_id=$3 and s.provider='docker' and (s.owner_id=$2 or m.role='admin')`,
        [sandboxId, actor.userId, actor.orgId],
      )
    ).rows[0];
    return row ?? deny();
  }
  return {
    reserve(
      actor: Actor,
      input: Reservation,
      authorize?: (tx: Sql) => Promise<void>,
      snapshotId?: string,
      selectAccount?: (
        tx: Sql,
      ) => Promise<Pick<Reservation, "credentialId" | "credentialVersion" | "model" | "reasoningEffort">>,
    ) {
      return transaction(async (tx) => {
        actorInput(actor);
        let request = normalize(input);
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
        const existing = (await tx.query(`select 1 from public.sandboxes where id=$1`, [request.requestId])).rows[0];
        if (existing) deny();
        if (selectAccount) request = normalize({ ...input, ...(await selectAccount(tx)) });
        const credential = await tx.query(
          `select id from public.credentials where id=$1 and version=$2 and kind = any($5::public.credential_kind[])
           and status='active' and (expires_at is null or expires_at>now())
           and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
          [request.credentialId, request.credentialVersion, actor.userId, actor.orgId, HARNESS_KINDS[request.harness]],
        );
        if (!credential.rows.length) deny();
        await authorize?.(tx);
        const snapshot = snapshotId ? await resolveDockerSnapshot(tx, actor, snapshotId) : undefined;
        if (
          snapshot &&
          (snapshot.host_id !== request.hostId ||
            snapshot.image_id !== request.image ||
            snapshot.installation_id !== hint.installation_id)
        )
          deny();
        const host =
          (
            await tx.query<{ installation_id: string; draining: boolean }>(
              `select installation_id,${hostDrainingSql("docker_hosts")} as draining from public.docker_hosts
           where id=$1 and org_id=$2 and owner_id=$3 and installation_id=$4 and hash is not null
             and registration_hash is null and revoked_at is null for update`,
              [request.hostId, actor.orgId, hint.owner_id, hint.installation_id],
            )
          ).rows[0] ?? deny();
        if (host.draining) throw new DockerHostDraining();
        await admitLaunchPlan(
          () => admitLaunchAccount(tx, request, request.requestId, request.model),
          async () => {
            await admitDockerDisk(tx, request.hostId);
            await admitDockerCapacity(tx, request.hostId);
          },
        );
        const generation = await createDockerMachineGenerationBindings(tx, {
          hostId: request.hostId,
          installationId: host.installation_id,
        }).bind({ sandboxId: request.requestId, generation: 1 });
        const physical = `armada-${host.installation_id}-${request.hostId}-${request.requestId}-${generation}`;
        const row =
          (await insertStartingDockerSandbox(tx, {
            ...request,
            orgId: actor.orgId,
            ownerId: actor.userId,
            physical,
            installationId: host.installation_id,
            generation,
            requestedTtlSeconds: input.ttlSeconds ?? null,
            snapshotId: snapshotId ?? null,
          })) ?? deny();
        return record(row);
      });
    },
    get(actor: Actor, sandboxId: string) {
      return transaction(async (tx) => record(await visible(tx, actor, sandboxId)));
    },
  };
}
