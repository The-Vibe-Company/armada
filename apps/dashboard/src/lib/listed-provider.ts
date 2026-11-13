import { SANDBOX_PLACEMENT_LABELS, SANDBOX_PLACEMENT_PROVIDERS, type SandboxPlacementProviderId } from "@armada/core";

/** One server/client row vocabulary, distinct from golden-source providers. */
export const LISTED_PROVIDERS = SANDBOX_PLACEMENT_PROVIDERS;
export type ListedProvider = SandboxPlacementProviderId;

export const LISTED_PROVIDER_LABELS = SANDBOX_PLACEMENT_LABELS;
