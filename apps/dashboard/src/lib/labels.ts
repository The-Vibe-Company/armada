import type { Harness } from "@armada/core";
import { mapHarnesses } from "@armada/core";

/** The agent a harness runs, as people know it. */
export const HARNESS_LABELS: Record<Harness, string> = mapHarnesses((descriptor) => descriptor.label);

/** A reasoning effort as the model pickers name it. */
export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
