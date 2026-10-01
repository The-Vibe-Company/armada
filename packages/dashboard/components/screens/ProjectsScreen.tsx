"use client";

// /projects until THE-868 builds it: one row per project of the viewer's organization.
import type { ProjectOverview } from "@armada/core/read";
import { decisionsOf, paths } from "@/lib/fleet-view";
import { useFleet, useNow, useShell } from "../shell/context";
import { Dot, EmptyState, ProjectChip, Row, RowList } from "../ui";
import { PlaceholderNote } from "./Placeholder";

/** A coordinator's state, in its color: "actif · il y a 2 min", "inactif depuis 24 min". */
export function CoordinatorState({ project }: { project: ProjectOverview }) {
  const { t } = useShell();
  const now = useNow();
  const { state, seenAt } = project.coordinator;
  const ms = seenAt ? Math.max(0, now - Date.parse(seenAt)) : 0;
  const color = state === "active" ? "var(--done)" : state === "idle" ? "var(--active)" : "var(--text-3)";
  return (
    <span className="sc-coord" style={{ color }}>
      <span className={`sc-coord-mark is-${state}`} aria-hidden />
      <span className="faint">{t.shell.coordinator}</span>
      {state === "active"
        ? t.shell.coordinatorActive(t.ago(ms))
        : state === "idle"
          ? t.shell.coordinatorIdle(t.duration(ms))
          : t.shell.coordinatorUnknown}
    </span>
  );
}

export function ProjectsScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const decisions = decisionsOf(overview);
  return (
    <div className="sc-page">
      <div className="sc-head">
        <h1>{t.shell.nav.projects}</h1>
        <p className="sc-lead">{t.shell.projectsLead}</p>
      </div>
      <PlaceholderNote />
      {overview.projects.length === 0 ? (
        <EmptyState title={t.shell.noProjects} hint={t.shell.noProjectsHint} />
      ) : (
        <RowList>
          {overview.projects.map((p) => {
            const waiting = decisions.filter((d) => d.project === p.slug).length;
            return (
              <Row key={p.slug} href={paths.project(p.slug)} className="sc-project">
                <span className="sc-project-name">
                  <ProjectChip slug={p.slug} name={p.name} />
                  <span className="sc-project-repo">
                    {p.repository}
                    {p.programRoot ? ` · ${p.programRoot.id}` : ""}
                  </span>
                </span>
                <CoordinatorState project={p} />
                <span className="sc-project-figure">
                  <span className="faint">{t.shell.inFlight}</span> {p.inFlight}
                </span>
                <span className="sc-project-figure">
                  {waiting > 0 && <Dot color="var(--accent)" size={6} />}
                  <span className="faint">{t.shell.waitingForYou}</span> {waiting}
                </span>
              </Row>
            );
          })}
        </RowList>
      )}
    </div>
  );
}
