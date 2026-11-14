import { createHash } from "node:crypto";
import { type DockerSnapshotRecord, parseGoldenConfig } from "@armada/core";
import { type Sql, VaultError } from "@armada/core/server";
import type { DockerHostJob } from "../../core/src/docker-host-job.ts";
export const SNAPSHOT_COLUMNS = `s.*,h.name as host_name,(h.revoked_at is null and h.installation_id=s.installation_id and h.hash is not null and h.draining_at is null and (h.last_seen_at>now()-interval '90 seconds') is true) as host_available`;
export type SnapshotRow = {
  id: string;
  org_id: string;
  owner_id: string;
  host_id: string;
  installation_id: string;
  name: string;
  visibility: "private" | "org";
  config: DockerSnapshotRecord["config"];
  request_hash: string;
  actor_epoch: string;
  issuer_epoch: string;
  generation: string;
  base_image: string;
  built_on_version: string | null;
  build_expires_at: Date | string;
  status: DockerSnapshotRecord["status"];
  image_id: string | null;
  failure_reason?: string | null;
  created_at: Date | string;
  host_name: string | null;
  host_available: boolean;
};
export function snapshotRecord(row: SnapshotRow): DockerSnapshotRecord {
  return {
    builtOnVersion: row.built_on_version,
    id: row.id,
    orgId: row.org_id,
    ownerId: row.owner_id,
    hostId: row.host_id,
    installationId: row.installation_id,
    name: row.name,
    visibility: row.visibility,
    provider: "docker",
    config: parseGoldenConfig(row.config),
    definitionHash: createHash("sha256")
      .update(
        JSON.stringify({
          image: row.base_image,
          config: parseGoldenConfig(row.config),
          ...(row.built_on_version === null ? {} : { armadaVersion: row.built_on_version }),
        }),
      )
      .digest("hex"),
    status: row.status === "building" && new Date(row.build_expires_at).getTime() <= Date.now() ? "failed" : row.status,
    image: row.image_id,
    failureReason:
      row.status === "building" && new Date(row.build_expires_at).getTime() <= Date.now()
        ? "Snapshot build expired before an image was published."
        : row.status === "failed"
          ? (row.failure_reason ??
            "Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.")
          : null,
    createdAt: new Date(row.created_at).toISOString(),
    hostName: row.host_name,
    hostAvailable: row.host_available,
  };
}
export async function resolveDockerSnapshot(sql: Sql, actor: { userId: string; orgId: string }, id: string) {
  const row = (
    await sql.query<SnapshotRow>(
      `select ${SNAPSHOT_COLUMNS} from public.docker_snapshots s join public.docker_hosts h on h.id=s.host_id and h.org_id=s.org_id
    join public.members m on m.org_id=s.org_id and m.user_id=$2 where s.id=$1 and s.org_id=$3
    and (s.visibility='org' or s.owner_id=$2)`,
      [id, actor.userId, actor.orgId],
    )
  ).rows[0];
  if (!row || row.status !== "ready" || !row.host_available || !row.image_id)
    throw new VaultError("not_found", "Snapshot is unavailable.");
  return row;
}
/** Host and both source actors are already locked by mailbox admission. */
export async function authorizeSnapshotBuild(
  sql: Sql,
  hostId: string,
  installationId: string,
  job: Extract<DockerHostJob, { operation: "buildSnapshot" }>,
) {
  const row = (
    await sql.query<SnapshotRow>(
      `select s.* from public.docker_snapshots s
    join public.docker_hosts h on h.id=s.host_id and h.org_id=s.org_id
    join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
    join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=s.actor_epoch
    join public.mcp_actor_epochs i on i.org_id=s.org_id and i.user_id=h.owner_id and i.epoch=s.issuer_epoch
    where s.id=$1 and s.host_id=$2 and s.installation_id=$3 and h.installation_id=$3 and h.revoked_at is null and h.draining_at is null
    and s.status='building' and s.build_expires_at>now() and (s.visibility='private' or m.role='admin') for update of s`,
      [job.build.id, hostId, installationId],
    )
  ).rows[0];
  if (
    !row ||
    row.id !== job.request.sandboxId ||
    row.generation !== job.request.generation ||
    row.base_image !== job.request.image ||
    row.built_on_version !== job.build.armadaVersion ||
    new Date(row.build_expires_at).getTime() !== job.request.expiresAt ||
    job.request.ttlSeconds !== 3600 ||
    row.owner_id !== job.build.ownerId ||
    row.visibility !== job.build.visibility ||
    JSON.stringify(parseGoldenConfig(row.config)) !== JSON.stringify(job.build.config)
  )
    throw new VaultError("forbidden", "Snapshot build denied.");
  return row;
}
