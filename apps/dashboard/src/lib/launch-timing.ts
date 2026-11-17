import { formatLaunchDuration, LAUNCH_STAGE_LABELS, type LaunchTiming } from "@armada/core";

/** #2560: the sandbox detail fact, total and slowest stage of the latest launch or resume; null before any stage. */
export function launchTimingFact(timing: LaunchTiming | null): [string, string] | null {
  if (!timing) return null;
  if (timing.totalMs === null || !timing.slowest) return ["Launch time", "One stage recorded so far"];
  const slowest = `${LAUNCH_STAGE_LABELS[timing.slowest.stage]}, ${formatLaunchDuration(timing.slowest.ms)}`;
  return ["Launch time", `${formatLaunchDuration(timing.totalMs)} (slowest: ${slowest})`];
}
