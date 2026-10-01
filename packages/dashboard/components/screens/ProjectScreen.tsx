"use client";

// /projects/[slug] (THE-870): one project as a whole, on the Agents page's
// anatomy. Its header section (progress, root, health, owner), its
// coordinator, its agents in flight, the tickets ready to launch (a launch is
// a request to the coordinator), what blocks it and its open pull requests.
// Health and progress are core's; each section's count is its figure.
import type { ProjectOverview, ReadyTicket } from "@armada/core/read";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { decisionsOf, HARNESS_NAME, paths } from "@/lib/fleet-view";
import {
  type Blocker,
  coordinatorHarness,
  coordinatorLink,
  type PrState,
  prCounts,
  progressPercent,
  projectBlockers,
  projectSlice,
  prState,
} from "@/lib/project-view";
import { HeaderActions, Page, Row, RowIcon, RowId, RowSide, RowText, RowTime, Section, SectionBody } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Dot, EmptyState, harnessColor, ProjectChip, RelativeTime, Tag, toneColor } from "../ui";
import { AgentRow } from "./AgentRow";
import { LaunchControl, useLaunch } from "./Launch";
import { Health, healthColor, Owner, ProgressRing, ProjectNotice, projectLine } from "./ProjectsScreen";

const PR_COLOR: Record<PrState, string> = {
  green: "var(--done)",
  red: "var(--critical)",
  conflict: "var(--critical)",
  pending: "var(--active)",
  none: "var(--text-3)",
};

const coordinatorColor = (state: ProjectOverview["coordinator"]["state"]) =>
  state === "active" ? "var(--done)" : state === "idle" ? "var(--active)" : "var(--text-3)";

/** A key and its value, as a static row. */
function Fact({ k, children, color }: { k: string; children: ReactNode; color?: string }) {
  return (
    <Row>
      <RowIcon />
      <span className="sc-fact-k">{k}</span>
      <span className="sc-fact-v" style={color ? { color } : undefined}>
        {children}
      </span>
    </Row>
  );
}

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
  const { rows, ready, waiting } = projectSlice(overview, slug);
  const decisions = decisionsOf({ waiting }).length;
  const blockers = projectBlockers(project, rows, waiting, paths.agent);
  const prs = prCounts(project.pullRequests);
  const percent = progressPercent(project.progress);
  return (
    <Page>
      <HeaderActions>
        {project.programRoot && (
          <a className="ui-button" href={project.programRoot.url} target="_blank" rel="noreferrer">
            {t.projectPages.openRoot}
          </a>
        )}
        <a className="ui-button" href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer">
          {t.projectPages.openRepo}
        </a>
      </HeaderActions>
      <ProjectNotice project={project} />
      <Section
        icon={<ProjectChip slug={project.slug} bare />}
        label={project.name}
        count={project.progress ? t.projectPages.tickets(project.progress.done, project.progress.total) : undefined}
        side={
          <>
            <Health health={project.health} />
            <Owner name={project.owner} />
          </>
        }
      >
        <Row>
          <RowIcon>
            <ProgressRing percent={percent} />
          </RowIcon>
          <span className="pj-percent">{percent === null ? "—" : `${percent} %`}</span>
          <RowText
            title={project.programRoot?.title ?? project.name}
            line={<span className="mono">{projectLine(project)}</span>}
          />
          {project.progress && (
            <RowSide>
              <span className="pj-progress" aria-hidden>
                <span style={{ width: `${percent ?? 0}%`, background: healthColor("on-track") }} />
              </span>
              <span className="mono">
                {project.progress.done}/{project.progress.total}
              </span>
              <span>{t.projectPages.doneLabel}</span>
            </RowSide>
          )}
        </Row>
      </Section>
      <CoordinatorSection project={project} decisions={decisions} />
      <Section label={t.projectPages.agentsInFlight} count={rows.length}>
        {rows.length === 0 ? (
          <SectionBody>
            <p>{t.shell.noAgents}</p>
          </SectionBody>
        ) : (
          rows.map((r) => <AgentRow key={r.id} row={r} airy={density === "airy"} />)
        )}
      </Section>
      <Section label={t.shell.readyToStart} count={ready.length} side={t.projectPages.routedBy}>
        {ready.length === 0 ? (
          <SectionBody>
            <p>{t.shell.nothingReady}</p>
          </SectionBody>
        ) : (
          ready.map((r) => <LaunchRow key={r.id} ticket={r} />)
        )}
      </Section>
      <Section
        icon={<Dot color={blockers.length ? "var(--critical)" : "var(--done)"} />}
        label={t.projectPages.blockers}
        count={blockers.length}
      >
        {blockers.length === 0 ? (
          <SectionBody>
            <p>{t.projectPages.nothingBlocks}</p>
          </SectionBody>
        ) : (
          blockers.map((b) => <BlockerRow key={`${b.reason}-${b.ticket ?? ""}-${b.pr ?? ""}`} blocker={b} />)
        )}
      </Section>
      <Section
        label={t.projectPages.openPrs}
        count={project.pullRequests?.length ?? "—"}
        side={prs && prs.open > 0 ? t.projectPages.greenCount(prs.green) : undefined}
      >
        {project.pullRequests === null ? (
          <SectionBody>
            <p>{t.projectPages.prsUnknown}</p>
          </SectionBody>
        ) : project.pullRequests.length === 0 ? (
          <SectionBody>
            <p>{t.projectPages.noOpenPrs}</p>
          </SectionBody>
        ) : (
          project.pullRequests.map((pr) => {
            const state = prState(pr);
            return (
              <Row key={pr.number}>
                <RowIcon>
                  <Dot color={PR_COLOR[state]} />
                </RowIcon>
                <RowId>#{pr.number}</RowId>
                <RowText
                  title={
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      {pr.title}
                    </a>
                  }
                  line={pr.branch ? <span className="mono">{pr.branch}</span> : undefined}
                />
                <RowSide width={90}>
                  <span style={{ color: PR_COLOR[state] }}>{t.projectPages.prStates[state]}</span>
                </RowSide>
              </Row>
            );
          })
        )}
      </Section>
    </Page>
  );
}

/** The project's coordinator: what Armada knows of it, never a guess; "—" for what it does not. */
function CoordinatorSection({ project, decisions }: { project: ProjectOverview; decisions: number }) {
  const { t, lang } = useShell();
  const now = useNow();
  const c = project.coordinator;
  const harness = coordinatorHarness(c.harness ?? null);
  const color = coordinatorColor(c.state);
  const since = (at: string) => Math.max(0, now - Date.parse(at));
  const state =
    c.state === "active" && c.seenAt
      ? c.inboxSeenAt
        ? t.projectPages.stateActive(t.ago(since(c.inboxSeenAt)))
        : t.projectPages.stateSeen(t.ago(since(c.seenAt)))
      : c.state === "idle" && c.seenAt
        ? t.projectPages.stateIdle(t.duration(since(c.seenAt)))
        : t.projectPages.stateUnknown;
  const link = coordinatorLink({ harness: c.harness ?? null, handle: c.handle ?? null });
  const clock = (at: string) =>
    new Date(at).toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  return (
    <Section
      icon={<span className={`sc-coord-mark is-${c.state}`} style={{ color }} aria-hidden />}
      label={t.shell.coordinator}
      side={
        <>
          <span style={{ color }}>{state}</span>
          {link && (
            <a className="ui-button" href={link}>
              {t.projectPages.openSession}
            </a>
          )}
        </>
      }
    >
      <Fact k={t.shell.harness}>
        {harness ? (
          <>
            <Dot color={harnessColor(harness)} />
            {HARNESS_NAME[harness]}
          </>
        ) : (
          "—"
        )}
      </Fact>
      <Fact k={t.shell.session}>
        <span className="mono">{c.handle ?? "—"}</span>
      </Fact>
      <Fact k={t.projectPages.model}>
        <span className="mono">{c.model ?? "—"}</span>
      </Fact>
      <Fact k={t.projectPages.state} color={c.state === "active" ? undefined : color}>
        <Dot color={color} />
        {state}
      </Fact>
      <Fact k={t.projectPages.inbox} color={decisions ? "var(--accent)" : undefined}>
        {decisions ? t.projectPages.inboxWaiting(decisions) : t.projectPages.inboxEmpty}
      </Fact>
      <Fact k={t.projectPages.onDuty}>
        {c.startedAt ? (
          <span className="mono" suppressHydrationWarning>
            {t.projectPages.onDutyAt(clock(c.startedAt), t.duration(since(c.startedAt)))}
          </span>
        ) : (
          "—"
        )}
      </Fact>
    </Section>
  );
}

/** What blocks the project, opening the agent (or the pull request) it is about. */
function BlockerRow({ blocker: b }: { blocker: Blocker }) {
  const { t } = useShell();
  const now = useNow();
  const color = toneColor(b.tone);
  const text =
    b.reason === "coordinator" && b.since
      ? t.projectPages.coordinatorAway(t.duration(Math.max(0, now - Date.parse(b.since))))
      : b.text;
  const body = (
    <>
      <RowIcon>
        <Dot color={color} />
      </RowIcon>
      <RowId>{b.ticket ?? (b.pr ? `#${b.pr}` : "")}</RowId>
      <RowText title={<span style={{ color }}>{t.projectPages.blockerReasons[b.reason]}</span>} line={text} />
      {b.since && (
        <RowTime>
          <RelativeTime at={b.since} format="duration" />
        </RowTime>
      )}
    </>
  );
  if (b.href?.startsWith("/")) return <Row href={b.href}>{body}</Row>;
  return (
    <Row>
      {body}
      {b.href && (
        <RowSide>
          <a className="ui-button" href={b.href} target="_blank" rel="noreferrer">
            {t.shell.openPr(b.pr ?? 0)}
          </a>
        </RowSide>
      )}
    </Row>
  );
}

/**
 * A ticket ready to launch, with the profile the routing gives it. "Lancer"
 * sends a launch request to the coordinator: the row shows it sent at once,
 * and goes back, with the reason, when it is refused.
 */
function LaunchRow({ ticket: r }: { ticket: ReadyTicket }) {
  const { t } = useShell();
  const launch = useLaunch(r);
  const { error } = launch.req;
  return (
    <Row className="pj-ready">
      <RowIcon>
        <span title={r.onCriticalPath ? t.a11y.criticalPath : undefined}>
          <Dot color={r.onCriticalPath ? "var(--critical)" : "var(--text-4)"} />
        </span>
        {r.onCriticalPath && <span className="sr-only">{t.a11y.criticalPath}</span>}
      </RowIcon>
      <RowId>{r.id}</RowId>
      <RowText
        title={
          <a href={r.url} target="_blank" rel="noreferrer">
            {r.title}
          </a>
        }
        line={
          r.labels.length > 0 || error ? (
            <span className="pj-labels">
              {error && <span style={{ color: "var(--critical)" }}>{t.requestErrors[error]}</span>}
              {r.labels.map((l) => (
                <Tag key={l}>{l}</Tag>
              ))}
            </span>
          ) : undefined
        }
      />
      <RowSide>
        <LaunchControl ticket={r} launch={launch} />
      </RowSide>
    </Row>
  );
}
