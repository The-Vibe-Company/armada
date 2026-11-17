/**
 * #2560: launch time per stage. One activation is one launch (activation 1) or one resume (each later
 * activation) of a sandbox, on every provider and path. Each stage keeps its earliest recorded time.
 * Browser-safe: no I/O.
 */
export const LAUNCH_STAGES = [
  /** The launch or resume request was accepted. */
  "accepted",
  /** The provider allocated the machine (Boat/Modal fork returned; Docker host picked up the job). */
  "provider_claimed",
  /** The machine is running (provider readiness, Docker host completion, or the bootstrap's first report). */
  "machine_started",
  /** Armada prepared the repository checkout (Boat/Modal launches; Docker images and resumes carry it). */
  "checkout_done",
  /** The Armada runtime bootstrap reported it started inside the machine (runtime paths only). */
  "bootstrap_started",
  /** The Armada runtime exchanged its ticket for a session (runtime paths only). */
  "enrolled",
  /** The sandbox can take a prompt: workspace, skills and connections are ready. */
  "harness_ready",
  /** First model output of the activation (runtime paths, where events reach the server). */
  "first_token",
] as const;
export type LaunchStage = (typeof LAUNCH_STAGES)[number];

export const LAUNCH_STAGE_LABELS: Record<LaunchStage, string> = {
  accepted: "Accepted",
  provider_claimed: "Provider claimed",
  machine_started: "Machine started",
  checkout_done: "Checkout done",
  bootstrap_started: "Bootstrap started",
  enrolled: "Enrolled",
  harness_ready: "Harness ready",
  first_token: "First model token",
};

export const isLaunchStage = (value: unknown): value is LaunchStage =>
  typeof value === "string" && (LAUNCH_STAGES as readonly string[]).includes(value);

export interface LaunchStageRow {
  activation: string | number;
  stage: string;
  at: string;
}

export interface LaunchTiming {
  /** "1" is the launch; a higher activation is a resume. */
  activation: string;
  /** Recorded stages in time order; `ms` is the time since the previous recorded stage. */
  stages: { stage: LaunchStage; at: string; ms: number | null }[];
  /** Harness ready was recorded: the launch finished. */
  ready: boolean;
  /**
   * First recorded stage to harness ready (or to the last stage reached so far). first_token is excluded: it waits
   * for the first prompt, which an idle launch may receive hours later.
   */
  totalMs: number | null;
  /** Largest step within totalMs, named by the stage that ended it. */
  slowest: { stage: LaunchStage; ms: number } | null;
}

const order = (stage: string) => LAUNCH_STAGES.indexOf(stage as LaunchStage);

/** Summarize the latest activation in `rows`; unknown stages and unparsable timestamps are ignored. */
export function summarizeLaunch(rows: readonly LaunchStageRow[]): LaunchTiming | null {
  const valid = rows.filter((row) => isLaunchStage(row.stage) && Number.isFinite(Date.parse(row.at)));
  if (!valid.length) return null;
  const activation = valid.map((row) => BigInt(row.activation)).reduce((max, value) => (value > max ? value : max));
  // Time order, not catalog order: a runtime launch prepares its checkout after enrolment.
  const ordered = valid
    .filter((row) => BigInt(row.activation) === activation)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order(a.stage) - order(b.stage));
  const launch = ordered.filter((row) => row.stage !== "first_token");
  let slowest: LaunchTiming["slowest"] = null;
  const stages = ordered.map((row, index) => {
    const previous = ordered[index - 1];
    const ms = previous ? Math.max(0, Date.parse(row.at) - Date.parse(previous.at)) : null;
    if (ms !== null && row.stage !== "first_token" && (!slowest || ms > slowest.ms))
      slowest = { stage: row.stage as LaunchStage, ms };
    return { stage: row.stage as LaunchStage, at: new Date(row.at).toISOString(), ms };
  });
  const first = launch[0];
  const ready = launch.find((row) => row.stage === "harness_ready");
  const last = ready ?? launch[launch.length - 1];
  return {
    activation: activation.toString(),
    stages,
    ready: Boolean(ready),
    totalMs: first && last && last !== first ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : null,
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

export interface LaunchPercentiles {
  provider: string;
  kind: "launch" | "resume";
  count: number;
  p50Ms: number;
  p90Ms: number;
}

/**
 * p50/p90 accepted-to-harness-ready time per provider, launches and resumes apart: only activations with both
 * stages, so unfinished activations never skew the sample.
 */
export function launchReadyPercentiles(
  rows: readonly (LaunchStageRow & { sandbox_id: string; provider: string })[],
): LaunchPercentiles[] {
  const activations = new Map<
    string,
    { provider: string; kind: LaunchPercentiles["kind"]; accepted?: number; ready?: number }
  >();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || (row.stage !== "accepted" && row.stage !== "harness_ready")) continue;
    const key = `${row.sandbox_id}:${row.activation}`;
    const activation = activations.get(key) ?? {
      provider: row.provider,
      kind: String(row.activation) === "1" ? "launch" : "resume",
    };
    if (row.stage === "accepted") activation.accepted = at;
    else activation.ready = at;
    activations.set(key, activation);
  }
  const samples = new Map<string, { provider: string; kind: LaunchPercentiles["kind"]; values: number[] }>();
  for (const { provider, kind, accepted, ready } of activations.values()) {
    if (accepted === undefined || ready === undefined) continue;
    const key = `${provider}:${kind}`;
    const sample = samples.get(key) ?? { provider, kind, values: [] };
    sample.values.push(Math.max(0, ready - accepted));
    samples.set(key, sample);
  }
  return [...samples.values()]
    .map(({ provider, kind, values }) => ({
      provider,
      kind,
      count: values.length,
      p50Ms: percentile(values, 50)!,
      p90Ms: percentile(values, 90)!,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind));
}

/**
 * Server-only SQL: record `stage` for the sandbox's current activation, `elapsedMs` before the database clock.
 * No activation yet (a sandbox started before #2560) records nothing. A repeated or late report keeps the earliest time.
 */
export async function recordLaunchStageSql(
  sql: { query(text: string, values?: unknown[]): Promise<unknown> },
  sandboxId: string,
  stage: LaunchStage,
  elapsedMs = 0,
): Promise<void> {
  await sql.query(
    `insert into public.sandbox_launch_stages(sandbox_id,activation,stage,at)
     select $1::uuid,max(l.activation),$2,clock_timestamp()-make_interval(secs=>$3::double precision/1000)
       from public.sandbox_launch_stages l where l.sandbox_id=$1::uuid having max(l.activation) is not null
     on conflict(sandbox_id,activation,stage) do update set at=least(sandbox_launch_stages.at,excluded.at)`,
    [sandboxId, stage, Math.max(0, Math.round(elapsedMs))],
  );
}
