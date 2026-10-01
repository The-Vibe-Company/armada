"use client";

// /projects/[slug] until THE-868 builds it: the project's figures, its
// coordinator, its agents in flight and the tickets ready to start.
import { useParams } from "next/navigation";
import { decisionsOf } from "@/lib/fleet-view";
import { useFleet, useShell } from "../shell/context";
import { EmptyState, Kpi, KpiRow, ProjectChip, RowList, SectionHeader, Tag } from "../ui";
import { AgentRow } from "./AgentRow";
import { PlaceholderNote } from "./Placeholder";
import { CoordinatorState } from "./ProjectsScreen";

export function ProjectScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const slug = decodeURIComponent(String(useParams<{ slug: string }>().slug ?? ""));
  const project = overview.projects.find((p) => p.slug === slug);
  if (!project)
    return (
      <div className="sc-page">
        <EmptyState title={t.shell.projectMissing} hint={t.shell.projectMissingHint} />
      </div>
    );
  const rows = overview.rows.filter((r) => r.project === slug);
  const ready = overview.ready.filter((r) => r.project === slug);
  const prs = rows.filter((r) => r.pr).length;
  const waiting = decisionsOf(overview).filter((d) => d.project === slug).length;
  return (
    <div className="sc-page">
      <div className="sc-head">
        <h1 className="sc-title">
          <ProjectChip slug={project.slug} bare />
          {project.name}
        </h1>
        <p className="sc-lead mono faint">
          {project.repository}
          {project.programRoot ? ` · ${project.programRoot.id}` : ""}
        </p>
        <CoordinatorState project={project} />
      </div>
      <KpiRow>
        <Kpi label={t.shell.inFlight} value={rows.length} tone="running" />
        <Kpi label={t.shell.waitingForYou} value={waiting} tone={waiting ? "waiting" : undefined} />
        <Kpi label={t.shell.readyToStart} value={ready.length} />
        <Kpi label={t.shell.openPrs} value={prs} />
      </KpiRow>
      <PlaceholderNote />
      <section className="sc-section">
        <SectionHeader title={t.shell.inFlight} count={rows.length} />
        {rows.length === 0 ? (
          <EmptyState title={t.shell.noAgents} />
        ) : (
          <RowList>
            {rows.map((r) => (
              <AgentRow key={r.id} row={r} />
            ))}
          </RowList>
        )}
      </section>
      <section className="sc-section">
        <SectionHeader title={t.shell.readyToStart} count={ready.length} />
        {ready.length === 0 ? (
          <EmptyState title={t.shell.nothingReady} />
        ) : (
          <div className="ui-rows">
            {ready.map((r) => (
              <div key={r.id} className="sc-ready">
                <span className="mono faint sc-agent-id">{r.id}</span>
                <span className="sc-agent-title">{r.title}</span>
                <span className="spacer" />
                {r.route && <Tag>{r.route.profile}</Tag>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
