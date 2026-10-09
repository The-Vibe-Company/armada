"use client";

// A ticket's long jobs (THE-1128), on its session's page and in the
// overview's preview: one line each, its name and state, the runner's last
// progress, its estimate, how long since its last news, and "overdue" past
// its `max_hours`. Renders from the polled overview; nothing when the ticket
// has no job.
import type { JobState } from "@armada/core/read";
import { clockIn, dayIn, dayLabel } from "@/lib/activity-view";
import type { Strings } from "@/lib/i18n";
import { type JobLine, ticketJobLines } from "@/lib/jobs-view";
import { useFleet, useNow, useShell } from "../shell/context";

const STATE_COLOR: Record<JobState, string> = {
  starting: "var(--text-3)",
  running: "var(--blue)",
  succeeded: "var(--green)",
  failed: "var(--red)",
  stopped: "var(--text-3)",
  lost: "var(--red)",
};

export function JobStrip({ project, ticket, heading }: { project: string; ticket: string; heading: string }) {
  const { t, zone } = useShell();
  const { overview } = useFleet();
  const now = useNow();
  const jobs = ticketJobLines(
    overview.projects.find((p) => p.slug === project),
    ticket,
    now,
  );
  if (!jobs.length) return null;
  return (
    <section className="jb" aria-label={t.jobs.title}>
      <p className={heading}>{t.jobs.title}</p>
      <ul className="jb-list">
        {jobs.map((j) => (
          <Job key={j.id} job={j} t={t} zone={zone} now={now} />
        ))}
      </ul>
    </section>
  );
}

function Job({ job, t, zone, now }: { job: JobLine; t: Strings; zone: string; now: number }) {
  const color = job.overdue || job.stalledMinutes !== null ? "var(--amber)" : STATE_COLOR[job.state];
  const eta = job.eta && etaText(t, job.eta, zone, now);
  return (
    <li className="jb-row">
      <span className="jb-head">
        <span className="ov-dot" style={{ background: color }} aria-hidden />
        <span className="jb-name mono">{job.name}</span>
        <span style={{ color: STATE_COLOR[job.state] }}>{t.jobs.states[job.state]}</span>
        {job.stalledMinutes !== null && <span className="jb-overdue">{t.jobs.stalled(job.stalledMinutes)}</span>}
        {job.overdue && job.maxHours !== null && (
          <span className="jb-overdue">{t.jobs.overdue(t.duration(job.maxHours * 3_600_000))}</span>
        )}
      </span>
      {job.progress && <span className="jb-progress">{job.progress}</span>}
      <span className="jb-facts">
        {eta && (
          <>
            <span>{eta}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>{t.jobs.lastNews(t.ago(job.lastNewsMs))}</span>
      </span>
      {job.ticketDone && <span className="jb-facts">{t.jobs.ticketDone}</span>}
    </li>
  );
}

/** "ETA 14:32 · in 1 h 20", the day first when it is not today, "passed" once it is. */
function etaText(t: Strings, eta: { at: string; inMs: number }, zone: string, now: number): string {
  const today = dayIn(new Date(now).toISOString(), zone);
  const day = dayIn(eta.at, zone);
  const clock = clockIn(eta.at, zone, t.overview.locale);
  return t.jobs.eta(
    day === today ? clock : `${dayLabel(t, day, today)} ${clock}`,
    eta.inMs > 0 ? t.duration(eta.inMs) : null,
  );
}
