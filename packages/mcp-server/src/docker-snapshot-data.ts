import { createHash } from "node:crypto";
import {
  DOCKER_SNAPSHOT_FAILURE_MESSAGES,
  type DockerSnapshotRecord,
  dockerHostUpgradeMessage,
  parseGoldenConfig,
  VERSION,
} from "@armada/core";
import {
  isSnapshotBaselineTool,
  SNAPSHOT_BASELINE_VERSION,
  type Sql,
  snapshotBaselineFailureMessage,
  VaultError,
} from "@armada/core/server";
import type { DockerHostJob } from "../../core/src/docker-host-job.ts";
import { DockerHostDraining } from "./docker-capacity.ts";
import { hostDrainingSql } from "./docker-host-drain.ts";
export const SNAPSHOT_COLUMNS = `s.*,h.name as host_name,h.daemon_version as host_daemon_version,${hostDrainingSql("h")} as host_draining,(h.revoked_at is null and h.installation_id=s.installation_id and h.hash is not null and (h.last_seen_at>now()-interval '90 seconds') is true) as host_online,(h.revoked_at is null and h.installation_id=s.installation_id and h.hash is not null and not ${hostDrainingSql("h")} and (h.last_seen_at>now()-interval '90 seconds') is true) as host_available`;
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
  baseline_version: number | null;
  baseline_failure_tool: string | null;
  build_expires_at: Date | string;
  status: DockerSnapshotRecord["status"];
  image_id: string | null;
  failure_reason?: string | null;
  created_at: Date | string;
  host_name: string | null;
  host_daemon_version: string | null;
  host_draining: boolean;
  host_online: boolean;
  host_available: boolean;
};
export function snapshotRecord(row: SnapshotRow): DockerSnapshotRecord {
  const baselineOutdated = row.status === "ready" && (row.baseline_version ?? 0) < SNAPSHOT_BASELINE_VERSION;
  const upgrade = baselineOutdated ? dockerHostUpgradeMessage(row.host_daemon_version, VERSION) : null;
  const baselineWarning = baselineOutdated
    ? [
        row.baseline_version == null
          ? "This snapshot was built without a reported developer baseline."
          : "This snapshot has an older developer baseline.",
        upgrade,
        "Rebuild the snapshot to get the current baseline.",
      ]
        .filter(Boolean)
        .join(" ")
    : undefined;
  return {
    builtOnVersion: row.built_on_version,
    baselineVersion: row.baseline_version ?? null,
    baselineOutdated,
    ...(baselineWarning ? { baselineWarning } : {}),
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
        ? DOCKER_SNAPSHOT_FAILURE_MESSAGES.expired
        : row.status === "failed"
          ? isSnapshotBaselineTool(row.baseline_failure_tool)
            ? snapshotBaselineFailureMessage(row.baseline_failure_tool)
            : (row.failure_reason ?? DOCKER_SNAPSHOT_FAILURE_MESSAGES.build)
          : null,
    createdAt: new Date(row.created_at).toISOString(),
    hostName: row.host_name,
    hostAvailable: row.host_available,
  };
}
/**
 * Resolve a snapshot for a new launch. Existence and readiness are separate from host availability: a draining
 * host is a state refusal with its own reason, never "Snapshot is unavailable". `allowDraining` is for callers
 * that only validate an existing sandbox's identity (cleanup and replay), not new admission.
 */
export async function resolveDockerSnapshot(
  sql: Sql,
  actor: { userId: string; orgId: string },
  id: string,
  options: { allowDraining?: boolean } = {},
) {
  const row = (
    await sql.query<SnapshotRow>(
      `select ${SNAPSHOT_COLUMNS} from public.docker_snapshots s join public.docker_hosts h on h.id=s.host_id and h.org_id=s.org_id
    join public.members m on m.org_id=s.org_id and m.user_id=$2 where s.id=$1 and s.org_id=$3
    and (s.visibility='org' or s.owner_id=$2)`,
      [id, actor.userId, actor.orgId],
    )
  ).rows[0];
  if (!row || row.status !== "ready" || !row.image_id) throw new VaultError("not_found", "Snapshot is unavailable.");
  if (row.host_draining && options.allowDraining !== true) throw new DockerHostDraining();
  if (!row.host_online) throw new VaultError("not_found", "Snapshot is unavailable.");
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
      `select s.*,${hostDrainingSql("h")} as host_draining from public.docker_snapshots s
    join public.docker_hosts h on h.id=s.host_id and h.org_id=s.org_id
    join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
    join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=s.actor_epoch
    join public.mcp_actor_epochs i on i.org_id=s.org_id and i.user_id=h.owner_id and i.epoch=s.issuer_epoch
    where s.id=$1 and s.host_id=$2 and s.installation_id=$3 and h.installation_id=$3 and h.revoked_at is null
    and s.status='building' and s.build_expires_at>now() and (s.visibility='private' or m.role='admin') for update of s`,
      [job.build.id, hostId, installationId],
    )
  ).rows[0];
  if (!row) throw new VaultError("forbidden", "Snapshot build denied.");
  // A drain is a state refusal, not lost authorization: the poll path persists its own reason.
  if (row.host_draining) throw new DockerHostDraining();
  if (
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
