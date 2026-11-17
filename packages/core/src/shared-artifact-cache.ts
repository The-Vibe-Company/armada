/**
 * Read-only, digest-named public artifact cache a Docker host mounts into its sandboxes (#2562).
 * Only a content address: the runtime still verifies size and SHA256 before use, so neither the
 * host mount nor anything an image places at this path is trusted. Absent elsewhere (Modal, Boat).
 */
export const SHARED_ARTIFACT_CACHE_PATH = "/opt/armada/artifact-cache";
