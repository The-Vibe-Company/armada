"use client";

// /projects until THE-870 builds it: one row per project of the viewer's organization.
import type { ProjectOverview } from "@armada/core/read";
import { decisionsOf, paths } from "@/lib/fleet-view";
import { Page, Row, RowIcon, RowSide, RowText, Section } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Dot, EmptyState, ProjectChip } from "../ui";

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

/** A figure of a row, its label in grey: "en vol 5". */
export function Figure({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <span className="sc-figure">
      {dot && <Dot color={dot} size={6} />}
      <span className="faint">{label}</span> <span className="mono">{value}</span>
    </span>
  );
}

export const projectLine = (p: Pick<ProjectOverview, "repository" | "programRoot">) =>
  `${p.repository}${p.programRoot ? ` · ${p.programRoot.id}` : ""}`;

export function ProjectsScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const decisions = decisionsOf(overview);
  return (
    <Page>
      {overview.projects.length === 0 ? (
        <EmptyState title={t.shell.noProjects} hint={t.shell.noProjectsHint} />
      ) : (
        <Section label={t.allProjects} count={overview.projects.length}>
          {overview.projects.map((p) => {
            const waiting = decisions.filter((d) => d.project === p.slug).length;
            return (
              <Row key={p.slug} href={paths.project(p.slug)}>
                <RowIcon>
                  <ProjectChip slug={p.slug} bare />
                </RowIcon>
                <RowText title={p.name} line={<span className="mono">{projectLine(p)}</span>} />
                <RowSide roomy>
                  <CoordinatorState project={p} />
                </RowSide>
                <RowSide>
                  <Figure label={t.shell.inFlight} value={p.inFlight} />
                </RowSide>
                <RowSide>
                  <Figure
                    label={t.shell.waitingForYou}
                    value={waiting}
                    dot={waiting > 0 ? "var(--accent)" : undefined}
                  />
                </RowSide>
              </Row>
            );
          })}
        </Section>
      )}
    </Page>
  );
}
