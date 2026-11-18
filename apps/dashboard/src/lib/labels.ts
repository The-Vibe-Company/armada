import type { Harness } from "@armada/core";
import { mapHarnesses } from "@armada/core";

/** The agent a harness runs, as people know it. */
export const HARNESS_LABELS: Record<Harness, string> = mapHarnesses((descriptor) => descriptor.label);

/** A reasoning effort as the model pickers name it. */
export const EFFORT_LABEL: Record<string, string> = {
  default: "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export const CLOUD_PROVIDERS_LABEL = "Cloud providers";
export const DOCKER_HOST_LABEL = "Docker host";
export const DOCKER_HOSTS_LABEL = "Docker hosts";

/** A Docker host's launch-picker group: its name (when set), the shared term and details such as its state. */
export function dockerHostGroup(name: string | null | undefined, ...details: string[]): string {
  return [name, DOCKER_HOST_LABEL, ...details].filter(Boolean).join(" · ");
}
