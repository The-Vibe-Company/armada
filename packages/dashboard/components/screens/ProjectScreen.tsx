"use client";

// /projects/[slug] until THE-870 builds it: the project and its coordinator,
// its agents in flight and the tickets ready to start.
import { useParams } from "next/navigation";
import { decisionsOf } from "@/lib/fleet-view";
import { Page, Row, RowIcon, RowId, RowSide, RowText, Section } from "../page";
import { useFleet, useShell } from "../shell/context";
import { Dot, EmptyState, ProjectChip, Tag } from "../ui";
import { AgentRow } from "./AgentRow";
import { CoordinatorState, Figure, projectLine } from "./ProjectsScreen";

export function ProjectScreen() {
  const { t, density } = useShell();
  const { overview } = useFleet();
  const slug = decodeURIComponent(String(useParams<{ slug: string }>().slug ?? ""));
  const project = overview.projects.find((p) => p.slug === slug);
  if (!project)
    return (
      <Page>
        <EmptyState title={t.shell.projectMissing} hint={t.shell.projectMissingHint} />
      </Page>
    );
  const rows = overview.rows.filter((r) => r.project === slug);
  const ready = overview.ready.filter((r) => r.project === slug);
  const prs = rows.filter((r) => r.pr).length;
  const waiting = decisionsOf(overview).filter((d) => d.project === slug).length;
  return (
    <Page>
      <Section
        icon={<ProjectChip slug={project.slug} bare />}
        label={project.name}
        side={<span className="mono">{projectLine(project)}</span>}
      >
        <Row>
          <CoordinatorState project={project} />
          <span className="spacer" />
          <RowSide>
            <Figure label={t.shell.inFlight} value={rows.length} />
            <Figure label={t.shell.waitingForYou} value={waiting} dot={waiting > 0 ? "var(--accent)" : undefined} />
            <Figure label={t.shell.readyToStart} value={ready.length} />
            <Figure label={t.shell.openPrs} value={prs} />
          </RowSide>
        </Row>
      </Section>
      <Section label={t.shell.inFlight} count={rows.length}>
        {rows.length === 0 ? (
          <EmptyState title={t.shell.noAgents} />
        ) : (
          rows.map((r) => <AgentRow key={r.id} row={r} airy={density === "airy"} />)
        )}
      </Section>
      <Section label={t.shell.readyToStart} count={ready.length}>
        {ready.length === 0 ? (
          <EmptyState title={t.shell.nothingReady} />
        ) : (
          ready.map((r) => (
            <Row key={r.id}>
              <RowIcon>
                <Dot color="var(--text-4)" />
              </RowIcon>
              <RowId>{r.id}</RowId>
              <RowText title={r.title} />
              {r.route && (
                <RowSide>
                  <Tag>{r.route.profile}</Tag>
                </RowSide>
              )}
            </Row>
          ))
        )}
      </Section>
    </Page>
  );
}
