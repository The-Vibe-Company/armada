import { formatLaunchDuration, LAUNCH_STAGE_LABELS, type LaunchTiming } from "@armada/core";

/** #2560: the sandbox detail fact, total and slowest stage of the latest launch or resume; null before any stage. */
export function launchTimingFact(timing: LaunchTiming | null): [string, string] | null {
  if (!timing) return null;
  if (timing.totalMs === null || !timing.slowest) return ["Launch time", "One stage recorded so far"];
  const total = formatLaunchDuration(timing.totalMs);
  const slowest = `slowest: ${LAUNCH_STAGE_LABELS[timing.slowest.stage]}, ${formatLaunchDuration(timing.slowest.ms)}`;
  if (timing.ready) return ["Launch time", `${total} (${slowest})`];
  // Still starting, or stopped before the harness was ready: say how far it got, never a finished time.
  const reached = timing.stages.filter((stage) => stage.stage !== "first_token").at(-1);
  const until = reached ? ` until ${LAUNCH_STAGE_LABELS[reached.stage].toLowerCase()}` : "";
  return ["Launch time", `Not ready: ${total}${until} (${slowest})`];
}
