/**
 * #2560: launch time per stage. One runtime activation (launch or resume) is one enrolment epoch;
 * the server records each stage once, at the point where it already authenticates that stage.
 * Browser-safe: no I/O.
 */
export const LAUNCH_STAGES = [
  /** Sandbox row created (first activation only; resumes start at machine_started). */
  "created",
  /** Provider machine running and the runtime ticket issued (Boat, Modal and Docker, launch and resume). */
  "machine_started",
  /** Bootstrap script reported it started inside the machine. */
  "bootstrap_started",
  /** Runtime exchanged its ticket for a session. */
  "enrolled",
  /** Harness (Claude Code, Codex or OpenCode) process started. */
  "harness_ready",
  /** First agent event stored. */
  "first_event",
] as const;
export type LaunchStage = (typeof LAUNCH_STAGES)[number];

export const LAUNCH_STAGE_LABELS: Record<LaunchStage, string> = {
  created: "Created",
  machine_started: "Machine started",
  bootstrap_started: "Bootstrap started",
  enrolled: "Enrolled",
  harness_ready: "Harness ready",
  first_event: "First event",
};

export const isLaunchStage = (value: unknown): value is LaunchStage =>
  typeof value === "string" && (LAUNCH_STAGES as readonly string[]).includes(value);

export interface LaunchStageRow {
  epoch: string | number;
  stage: string;
  at: string;
}

export interface LaunchTiming {
  epoch: string;
  /** Recorded stages in launch order; `ms` is the time since the previous recorded stage. */
  stages: { stage: LaunchStage; at: string; ms: number | null }[];
  /** First to last recorded stage. */
  totalMs: number | null;
  /** Largest step between two recorded stages, named by the stage that ended it. */
  slowest: { stage: LaunchStage; ms: number } | null;
}

/** Summarize the latest epoch in `rows`; unknown stages and unparsable timestamps are ignored. */
export function summarizeLaunch(rows: readonly LaunchStageRow[]): LaunchTiming | null {
  const valid = rows.filter((row) => isLaunchStage(row.stage) && Number.isFinite(Date.parse(row.at)));
  if (!valid.length) return null;
  const epoch = valid.map((row) => BigInt(row.epoch)).reduce((max, value) => (value > max ? value : max));
  const ordered = valid
    .filter((row) => BigInt(row.epoch) === epoch)
    .sort((a, b) => LAUNCH_STAGES.indexOf(a.stage as LaunchStage) - LAUNCH_STAGES.indexOf(b.stage as LaunchStage));
  let slowest: LaunchTiming["slowest"] = null;
  const stages = ordered.map((row, index) => {
    const previous = ordered[index - 1];
    const ms = previous ? Math.max(0, Date.parse(row.at) - Date.parse(previous.at)) : null;
    if (ms !== null && (!slowest || ms > slowest.ms)) slowest = { stage: row.stage as LaunchStage, ms };
    return { stage: row.stage as LaunchStage, at: new Date(row.at).toISOString(), ms };
  });
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  return {
    epoch: epoch.toString(),
    stages,
    totalMs: ordered.length > 1 ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : null,
    slowest,
  };
}

/** Nearest-rank percentile; null for no samples. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** Human duration: "850 ms", "12.4 s", "2 min 5 s". */
export function formatLaunchDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * p50/p90 launch-to-ready time per provider: only first activations with both `created` and
 * `harness_ready`, so resumes and unfinished launches never skew the sample.
 */
export function launchReadyPercentiles(
  rows: readonly (LaunchStageRow & { sandbox_id: string; provider: string })[],
): { provider: string; count: number; p50Ms: number; p90Ms: number }[] {
  const launches = new Map<string, { provider: string; created?: number; ready?: number }>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || (row.stage !== "created" && row.stage !== "harness_ready")) continue;
    const key = `${row.sandbox_id}:${row.epoch}`;
    const launch = launches.get(key) ?? { provider: row.provider };
    if (row.stage === "created") launch.created = at;
    else launch.ready = at;
    launches.set(key, launch);
  }
  const byProvider = new Map<string, number[]>();
  for (const launch of launches.values())
    if (launch.created !== undefined && launch.ready !== undefined)
      byProvider.set(launch.provider, [
        ...(byProvider.get(launch.provider) ?? []),
        Math.max(0, launch.ready - launch.created),
      ]);
  return [...byProvider]
    .map(([provider, values]) => ({
      provider,
      count: values.length,
      p50Ms: percentile(values, 50)!,
      p90Ms: percentile(values, 90)!,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}
