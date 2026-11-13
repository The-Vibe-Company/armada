import { SANDBOX_PROVIDERS } from "@armada/core";
import { PROVIDER_LABELS } from "./golden-form.ts";

/**
 * Where a listed sandbox runs. The database's `sandbox_provider` also has `docker` (#1165): a sandbox on an owned
 * Docker host. `SANDBOX_PROVIDERS` stays Boat and Modal, the providers of goldens and of the golden launch, so the
 * list widens it here rather than in the shared contract, until the server exports its placement provider type.
 */
export const LISTED_PROVIDERS = [...SANDBOX_PROVIDERS, "docker"] as const;
export type ListedProvider = (typeof LISTED_PROVIDERS)[number];

export const LISTED_PROVIDER_LABELS: Record<ListedProvider, string> = { ...PROVIDER_LABELS, docker: "Docker" };
