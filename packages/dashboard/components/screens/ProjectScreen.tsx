"use client";

// /projects/[slug] (THE-1021, design/dashboard-v7): one project. Its
// repository and owner over its name, one line of what is blocked, what waits
// for the owner and what is ready, its program's progress; then its sessions
// in flight grouped by state (the overview's rows), the tickets ready to
// launch (a launch is a request to the coordinator), its open pull requests,
// and its coordinator beside them, or each of them when it names them
// (THE-1112). Renders from the overview the shell polls.
import type { ProjectCoordinator, ProjectOverview, ReadyTicket } from "@armada/core/read";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { groupCounts, groupItems, showsOwners } from "@/lib/coordinator-view";
import { HARNESS_NAME } from "@/lib/fleet-view";
import { coordinatorHarness, coordinatorLink, type PrState, progressPercent, prState } from "@/lib/project-view";
import { Alert, LONG_LIST, Notice } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { useOverviewItems } from "../shell/use-items";
import { EmptyState } from "../ui";
import { LaunchControl, useLaunch } from "./Launch";
import { List } from "./OverviewScreen";

const PR_COLOR: Record<PrState, string> = {
  green: "var(--green)",
  red: "var(--red)",
  conflict: "var(--red)",
  pending: "var(--amber)",
  none: "var(--text-3)",
};

const COORDINATOR_COLOR = { active: "var(--green)", idle: "var(--amber)", unknown: "var(--text-3)" } as const;

export function ProjectScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const slug = decodeURIComponent(String(useParams<{ slug: string }>().slug ?? ""));
  const project = overview.projects.find((p) => p.slug === slug);
  const all = useOverviewItems();
  const items = useMemo(() => all.filter((i) => i.project === slug && i.group !== "merged"), [all, slug]);
  const groups = useMemo(() => groupItems(items, "state", project ? [project] : []), [items, project]);
  const names = useMemo(() => new Map(project ? [[project.slug, project.name]] : []), [project]);
  const named = useMemo(() => new Set(project && showsOwners(project, items) ? [project.slug] : []), [project, items]);
  if (!project)
    return (
      <div className="pg">
        <EmptyState title={t.shell.projectMissing} hint={t.shell.projectMissingHint} />
      </div>
    );
  const p = t.projectPage;
  const ready = overview.ready.filter((r) => r.project === slug);
  const n = groupCounts(items);
  const progress = project.progress;
  const percent = progressPercent(progress) ?? 0;
  return (
    <div className="pg is-wide pj">
      {project.error ? (
        <Alert title={t.projectError(project.name)}>{project.error}</Alert>
      ) : project.reading ? (
        <Notice>{t.readingProject(project.name)}</Notice>
      ) : null}
      <div className="pj-top">
        <div className="pg-head">
          <p className="pg-meta">
            <span className="mono">{project.repository}</span>
            {project.owner && (
              <>
                <span aria-hidden>·</span>
                <span>{p.owner(project.owner)}</span>
              </>
            )}
          </p>
          <p className="pg-title">{project.name}</p>
          <p className="pg-sub">
            {p.line({ live: items.length, blocked: n.blocked, you: n.you, ready: ready.length })}
          </p>
        </div>
        <div className="pj-links">
          {project.programRoot && (
            <a className="btn is-soft" href={project.programRoot.url} target="_blank" rel="noreferrer">
              {p.openRoot}
            </a>
          )}
          <a className="btn is-soft" href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer">
            {p.openRepo}
          </a>
        </div>
      </div>
      {progress && (
        <div className="pj-progress">
          <p className="pj-progress-head">
            <span>{p.progress}</span>
            <span className="mono">{p.tickets(progress.done, progress.total)}</span>
          </p>
          <span className="pj-bar" aria-hidden>
            <span style={{ width: `${percent}%` }} />
          </span>
        </div>
      )}
      <div className="pj-body">
        <div className="pj-main">
          {groups.length ? (
            <List groups={groups} names={names} named={named} boxed long={items.length > LONG_LIST} />
          ) : (
            <p className="pj-empty">{t.shell.noAgents}</p>
          )}
          <section className="pj-block" aria-labelledby="pj-ready">
            <h2 className="pj-block-h" id="pj-ready">
              {p.ready}
              <span className="pj-n">{ready.length}</span>
              <span className="pj-hint">{p.readyHint}</span>
            </h2>
            {ready.length === 0 ? (
              <p className="pg-none">{p.noReady}</p>
            ) : (
              <ul className="pj-rows">
                {ready.map((r) => (
                  <ReadyRow key={r.id} ticket={r} />
                ))}
              </ul>
            )}
          </section>
          <section className="pj-block" aria-labelledby="pj-prs">
            <h2 className="pj-block-h" id="pj-prs">
              {p.prs}
              <span className="pj-n">{project.pullRequests?.length ?? "—"}</span>
            </h2>
            {project.pullRequests === null ? (
              <p className="pg-none">{p.prsUnknown}</p>
            ) : project.pullRequests.length === 0 ? (
              <p className="pg-none">{p.noPrs}</p>
            ) : (
              <ul className="pj-rows">
                {project.pullRequests.map((pr) => {
                  const state = prState(pr);
                  return (
                    <li key={pr.number}>
                      <a href={pr.url} target="_blank" rel="noreferrer" className="pj-pr">
                        <span className="pj-id">#{pr.number}</span>
                        <span className="pj-title">{pr.title}</span>
                        <span className="pj-state" style={{ color: PR_COLOR[state] }}>
                          {p.prStates[state]}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
        {named.size ? (
          <div className="pj-coords">
            {(project.coordinators ?? []).map((c) => (
              <Coordinator key={c.name} coordinator={c} role={c} />
            ))}
          </div>
        ) : (
          <Coordinator coordinator={project.coordinator} />
        )}
      </div>
    </div>
  );
}

/** A ticket ready to launch: its labels, and Launch (a request to the coordinator). */
function ReadyRow({ ticket: r }: { ticket: ReadyTicket }) {
  const { t } = useShell();
  const launch = useLaunch(r);
  const { error } = launch.req;
  return (
    <li className="pj-ready">
      <span className="pj-id">{r.id}</span>
      <a href={r.url} target="_blank" rel="noreferrer" className="pj-title">
        {r.title}
      </a>
      <span className="pj-labels">
        {r.labels.map((l) => (
          <span key={l} className="pj-label">
            {l}
          </span>
        ))}
      </span>
      <span className="pj-launch-cell">
        <LaunchControl ticket={r} launch={launch} />
      </span>
      {/* Its own line, under the row: a phone hides the labels' column. */}
      {error && (
        <span className="pj-error" role="alert">
          {t.requestErrors[error]}
        </span>
      )}
    </li>
  );
}

/**
 * A coordinator of the project: what Armada knows of it, never a guess; "—"
 * for what it does not. `role` is one of the coordinators a project names,
 * with its name and its sessions; without it, the one coordinator seen last.
 */
function Coordinator({
  coordinator: c,
  role,
}: {
  coordinator: Omit<ProjectOverview["coordinator"], "cliVersion">;
  role?: ProjectCoordinator;
}) {
  const { t, zone } = useShell();
  const now = useNow();
  const p = t.projectPage;
  const harness = coordinatorHarness(c.harness ?? null);
  const color = COORDINATOR_COLOR[c.state];
  const since = (at: string) => Math.max(0, now - Date.parse(at));
  const state =
    c.state === "active" && c.seenAt
      ? p.coordinatorState.active(t.ago(since(c.inboxSeenAt ?? c.seenAt)))
      : c.state === "idle" && c.seenAt
        ? p.coordinatorState.idle(t.duration(since(c.seenAt)))
        : p.coordinatorState.unknown;
  const link = coordinatorLink({ harness: c.harness ?? null, handle: c.handle ?? null });
  const clock = (at: string) =>
    new Intl.DateTimeFormat(t.overview.locale, {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
  const facts = [
    { k: p.harness, v: harness ? (c.harness === "conductor-cloud" ? "Conductor Cloud" : HARNESS_NAME[harness]) : "—" },
    { k: p.session, v: c.handle ?? "—", mono: true },
    { k: p.model, v: c.model ?? "—", mono: true },
    {
      k: p.onDuty,
      v: c.startedAt ? p.onDutyAt(clock(c.startedAt), t.duration(since(c.startedAt))) : "—",
      mono: true,
    },
    ...(role ? [{ k: p.sessions, v: String(role.tickets.length), mono: true }] : []),
  ];
  const id = role ? `pj-coord-${role.name}` : "pj-coord";
  return (
    <aside className="pj-coord" aria-labelledby={id}>
      <h2 className="pj-coord-h" id={id}>
        <span className="ov-diamond" style={{ color }} aria-hidden />
        {role ? p.coordinatorNamed(role.name) : p.coordinator}
      </h2>
      <p className="pj-coord-state" style={{ color }}>
        {state}
      </p>
      {c.updateAvailable && (
        <p className="pj-coord-state" style={{ color: "var(--text-3)" }}>
          {p.updateAvailable}
        </p>
      )}
      <dl className="pj-coord-facts">
        {facts.map((f) => (
          <div key={f.k}>
            <dt>{f.k}</dt>
            <dd className={f.mono ? "mono" : undefined}>{f.v}</dd>
          </div>
        ))}
      </dl>
      {link && (
        <a className="btn is-soft pj-coord-open" href={link}>
          {p.openSession}
        </a>
      )}
    </aside>
  );
}
