import pin from "./official-sandbox-image.json" with { type: "json" };
import { VERSION } from "./version.ts";

/** Release builds replace the null development pin with the published GHCR digest. */
export const OFFICIAL_SANDBOX_IMAGE = pin as {
  version: string;
  image: string;
} | null;

/** Fail closed for unreleased builds or a pin from a different release. */
export function officialSandboxImage(): string {
  if (
    !OFFICIAL_SANDBOX_IMAGE ||
    OFFICIAL_SANDBOX_IMAGE.version !== VERSION ||
    !/^ghcr\.io\/the-vibe-company\/armada-sandbox@sha256:[a-f0-9]{64}$/.test(OFFICIAL_SANDBOX_IMAGE.image)
  )
    throw new Error("This build has no official sandbox image for its version.");
  return OFFICIAL_SANDBOX_IMAGE.image;
}
