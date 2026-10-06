// A ticket's long jobs as the session's page and the overview's preview show
// them (THE-1128): what each runner said last and how long ago, its estimate
// and whether it ran past `max_hours`. Read from the polled overview (Postgres
// only); recomputed against the ticking clock between polls.
import { type JobState, jobIsOpen, jobOverdue, type ProjectOverview, type ShownJob } from "@armada/core/read";

export interface JobLine {
  id: number;
  name: string;
  state: JobState;
  open: boolean;
  /** The runner's last progress text, as it gave it. */
  progress: string | null;
  /** When it should end and how long until then (negative once passed); only while it runs. */
  eta: { at: string; inMs: number } | null;
  /** Since its last observation: its start for a job never observed. */
  lastNewsMs: number;
  /** Still open past its `max_hours`; never stopped for it. */
  overdue: boolean;
  maxHours: number | null;
  /** Its ticket is Done while it runs on. */
  ticketDone: boolean;
}

export function jobLine(job: ShownJob, now: number): JobLine {
  const open = jobIsOpen(job);
  const maxHours = job.maxHours ?? null;
  return {
    id: job.id,
    name: job.name,
    state: job.state,
    open,
    progress: job.progress,
    eta: job.state === "running" && job.eta ? { at: job.eta, inMs: Date.parse(job.eta) - now } : null,
    lastNewsMs: Math.max(0, now - Date.parse(job.observedAt)),
    overdue: jobOverdue(job, maxHours, new Date(now)),
    maxHours,
    ticketDone: open && job.ticketDone,
  };
}

/** One ticket's jobs: the open ones first, then the newest. */
export function ticketJobLines(project: ProjectOverview | undefined, ticket: string, now: number): JobLine[] {
  return (project?.jobs ?? [])
    .filter((j) => j.ticket === ticket)
    .map((j) => jobLine(j, now))
    .sort((a, b) => Number(b.open) - Number(a.open) || b.id - a.id);
}
