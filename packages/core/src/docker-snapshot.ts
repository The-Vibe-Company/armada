import { DOCKER_SNAPSHOT_STATUSES, type DockerSnapshotRecord } from "./docker-api.ts";
import { parseGoldenConfig } from "./golden-config.ts";
export function parseDockerSnapshotRecord(input: unknown): DockerSnapshotRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid snapshot response.");
  const r = input as Record<string, unknown>,
    uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (
    ["id", "orgId", "ownerId", "hostId", "installationId"].some(
      (key) => typeof r[key] !== "string" || !uuid.test(r[key] as string),
    ) ||
    r.provider !== "docker" ||
    !(
      r.builtOnVersion === null ||
      (typeof r.builtOnVersion === "string" &&
        /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(r.builtOnVersion))
    ) ||
    (r.failureReason !== undefined &&
      r.failureReason !== null &&
      (typeof r.failureReason !== "string" || r.failureReason.length > 512)) ||
    typeof r.name !== "string" ||
    !r.name ||
    (r.visibility !== "private" && r.visibility !== "org") ||
    !DOCKER_SNAPSHOT_STATUSES.some((value) => value === r.status) ||
    typeof r.hostAvailable !== "boolean" ||
    typeof r.definitionHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(r.definitionHash) ||
    (r.hostName !== null && typeof r.hostName !== "string") ||
    typeof r.createdAt !== "string" ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    (r.status === "ready" ? typeof r.image !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r.image) : r.image !== null)
  )
    throw Error("Invalid snapshot response.");
  return {
    builtOnVersion: r.builtOnVersion as string | null,
    id: r.id as string,
    orgId: r.orgId as string,
    ownerId: r.ownerId as string,
    hostId: r.hostId as string,
    installationId: r.installationId as string,
    provider: "docker",
    name: r.name,
    visibility: r.visibility,
    hostName: r.hostName as string | null,
    hostAvailable: r.hostAvailable,
    createdAt: r.createdAt,
    definitionHash: r.definitionHash as string,
    status: r.status as DockerSnapshotRecord["status"],
    image: r.image as string | null,
    failureReason: (r.failureReason as string | null | undefined) ?? null,
    config: parseGoldenConfig(r.config),
  };
}
