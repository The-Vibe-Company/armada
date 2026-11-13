import { DOCKER_DEFAULT_IMAGE } from "./docker-api.ts";
import pin from "./official-sandbox-image.json" with { type: "json" };
import { VERSION } from "./version.ts";

/** Release builds replace the null source-build pin with the published GHCR digest. */
export const OFFICIAL_SANDBOX_IMAGE = pin as { version: string; image: string } | null;

/** Source deploys between releases retain the immutable, server-owned bootstrap baseline. */
export function resolveDockerLaunchImage(releasePin: unknown, version: string): string {
  if (releasePin === null) return DOCKER_DEFAULT_IMAGE;
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
