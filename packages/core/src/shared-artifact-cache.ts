/**
 * Read-only, digest-named public artifact cache mounted by Docker hosts and enrolled Modal sandboxes.
 * Only a content address: the runtime still verifies size and SHA256 before use, so neither the
 * host mount nor anything an image places at this path is trusted.
 */
export const SHARED_ARTIFACT_CACHE_PATH = "/opt/armada/artifact-cache";
