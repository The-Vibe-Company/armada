/** Immutable image references shared by API clients, admission and host jobs.
 * A local image ID is a host-local artifact, never a registry manifest digest or golden alias.
 */
export function isDockerImageReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64})$/.test(value)
  );
}

/** Immutable product-owned host snapshot provenance; private images additionally require a server-authorized binding. */
export const DOCKER_LOCAL_IMAGE_LABELS = {
  installation: "dev.armada.environment.installation",
  host: "dev.armada.environment.host",
  scope: "dev.armada.environment.scope",
  owner: "dev.armada.environment.owner",
  snapshot: "dev.armada.environment.snapshot",
  generation: "dev.armada.environment.generation",
  definition: "dev.armada.environment.definition",
} as const;

export interface DockerSnapshotBinding {
  id: string;
  ownerId: string;
  visibility: "private" | "org";
}
export function parseDockerSnapshotBinding(input: unknown): DockerSnapshotBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid snapshot binding.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join() !== "id,ownerId,visibility" ||
    typeof value.id !== "string" ||
    typeof value.ownerId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.id) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.ownerId) ||
    (value.visibility !== "org" && value.visibility !== "private")
  )
    throw Error("Invalid snapshot binding.");
  return { id: value.id, ownerId: value.ownerId, visibility: value.visibility };
}
