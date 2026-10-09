// Jobs run on the project's runner. Armada keeps their durable record only.
export const JOB_STATES = ["starting", "running", "succeeded", "failed", "stopped", "lost"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const JOB_PROGRESS_MAX = 4_000;
export const JOB_REF_MAX = 2_000;
export const jobIsOpen = (job: { state: JobState }) => job.state === "starting" || job.state === "running";

export interface Job {
  id: number;
  project: string;
  /** Monotonic observation generation, independent of clock resolution. */
  revision?: number;
  ticket: string;
  name: string;
  ref: string | null;
  state: JobState;
  progress: string | null;
  eta: string | null;
  startedBy: string | null;
  startedAt: string;
  observedAt: string;
  /** Last meaningful progress movement; absent on older servers. */
  progressChangedAt?: string;
  finishedAt: string | null;
}

export interface JobStart {
  ticket: string;
  name: string;
}
export interface JobObservation {
  id: number;
  ticket: string;
  /** Status probes must not overwrite newer news pushed while they ran. */
  expectedRevision?: number;
  state: Exclude<JobState, "starting">;
  /** A runner reference is set only by the first observation of a starting job. */
  ref?: string | null;
  /** Omitted progress preserves the previous observation; null explicitly clears it. */
  progress?: string | null;
  eta?: string | null;
}
export interface JobQuery {
  ticket?: string;
  open?: boolean;
  id?: number;
}
export interface JobSummary extends Job {
  overdue: boolean;
  stalled: boolean;
  /** Thresholds for recomputing the alert between dashboard polls. */
  stallMinutes?: number;
  silenceMinutes?: number;
  ticketDone: boolean;
  /** `[jobs.<name>] max_hours` of armada.toml; null when unset or the job is no longer configured. */
  maxHours: number | null;
}

/** The last nonblank stdout line is the runner contract; preceding lines may be tool chatter. */
export const lastJobLine = (stdout: string) => stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";

/** Estimates completion only from a meaningful fraction while the runner is still running. */
export function parseJobStatus(
  stdout: string,
  startedAt: string | Date,
  now: Date,
): Pick<JobObservation, "state" | "progress" | "eta"> {
  const line = lastJobLine(stdout);
  const match = /^(running|succeeded|failed)(?:\s+(.*))?$/.exec(line);
  if (!match || line.length > JOB_PROGRESS_MAX)
    throw new Error("job status must end with running, succeeded or failed followed by optional progress text");
  const state = match[1] as "running" | "succeeded" | "failed";
  const progress = match[2]?.trim() || null;
  let eta: string | null = null;
  const fraction = progress?.match(/(?:^|\s)(\d+)\/(\d+)(?=\s|$)/);
  if (state === "running" && fraction) {
    const done = Number(fraction[1]);
    const total = Number(fraction[2]);
    const start = typeof startedAt === "string" ? Date.parse(startedAt) : startedAt.getTime();
    const elapsed = now.getTime() - start;
    const end = start + Math.round((elapsed * total) / done);
    if (
      Number.isSafeInteger(done) &&
      Number.isSafeInteger(total) &&
      done > 0 &&
      done < total &&
      elapsed > 0 &&
      Number.isFinite(end) &&
      Math.abs(end) <= 8.64e15
    )
      eta = new Date(end).toISOString();
  }
  return { state, progress, eta };
}

export function jobOverdue(
  job: Pick<Job, "state" | "startedAt">,
  maxHours: number | null | undefined,
  now: Date,
): boolean {
  return jobIsOpen(job) && maxHours != null && now.getTime() - Date.parse(job.startedAt) > maxHours * 3_600_000;
}

/** Compare fractions before text so changing clocks and ETAs are not progress. */
export function progressMoved(previous: string | null, next: string | null): boolean {
  const fraction = (text: string | null) => text?.match(/(?:^|\s)(\d+)\/(\d+)(?=\s|$)/)?.[0]?.trim();
  const oldFraction = fraction(previous);
  const newFraction = fraction(next);
  return oldFraction && newFraction ? oldFraction !== newFraction : previous !== next;
}

/** Silence wins: a stalled runner is still answering, but its progress is unchanged. */
export function jobStalled(
  job: Pick<Job, "state" | "progress" | "progressChangedAt" | "observedAt">,
  stallMinutes: number,
  now: Date,
  silenceMinutes = 15,
): boolean {
  return (
    job.state === "running" &&
    !!job.progress?.trim() &&
    job.progressChangedAt !== undefined &&
    now.getTime() - Date.parse(job.observedAt) <= silenceMinutes * 60_000 &&
    now.getTime() - Date.parse(job.progressChangedAt) > stallMinutes * 60_000
  );
}

/** Minutes since movement, only used after jobStalled confirms a timestamp. */
export const jobStalledMinutes = (job: Pick<Job, "progressChangedAt">, now: Date) =>
  Math.floor((now.getTime() - Date.parse(job.progressChangedAt ?? "")) / 60_000);

/** A terminal notice is stored once with the job transition. */
export function jobEndedBody(job: Job): string {
  return `Job ${job.id} · ${job.name} · ${job.ticket} · ${job.state}\nLast progress: ${job.progress ?? "no progress reported"}`;
}
