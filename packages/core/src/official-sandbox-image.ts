import pin from "./official-sandbox-image.json" with { type: "json" };
import { VERSION } from "./version.ts";

/** Release builds replace the null source-build pin with the published GHCR digest. */
export const OFFICIAL_SANDBOX_IMAGE = pin as { version: string; image: string } | null;

/** Published 2.29.0 toolchain baseline: git, gh and python3 are required by runtime GitHub setup.
 * Source deployments must not fall back to the dependency-free operator preview fixture.
 * Harness/runtime selection still uses the current server's verified artifacts, not this image's caches.
 */
export const SOURCE_SANDBOX_IMAGE =
  "ghcr.io/the-vibe-company/armada-sandbox@sha256:30455768ce82cdd61a4575b2d4ad0787a6a69f0c89d622c764b83cd371500ed9";

/** Source deploys retain an immutable product-owned image with the runtime's required tools. */
export function resolveDockerLaunchImage(releasePin: unknown, version: string): string {
  if (releasePin === null) return SOURCE_SANDBOX_IMAGE;
  if (
    !releasePin ||
    typeof releasePin !== "object" ||
    Array.isArray(releasePin) ||
    !("version" in releasePin) ||
    releasePin.version !== version ||
    !("image" in releasePin) ||
    typeof releasePin.image !== "string" ||
    !/^ghcr\.io\/the-vibe-company\/armada-sandbox@sha256:[a-f0-9]{64}$/.test(releasePin.image)
  )
    throw new Error("This build has an invalid official sandbox image pin. Deploy a matching release pin.");
  return releasePin.image;
}

export function officialSandboxImage(): string {
  return resolveDockerLaunchImage(OFFICIAL_SANDBOX_IMAGE, VERSION);
}
