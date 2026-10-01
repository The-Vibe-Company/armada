"use client";

// The overview until THE-867 rebuilds it: what waits for the owner across
// every project, the agents at work, the tickets ready to start and each
// project's coordinator. It renders the overview core builds, as the v4 shell
// polls it (components/shell/context.tsx), on the page kit (components/page.tsx).
import type { CoordinatorState, FleetOverview, ProjectOverview, WaitingItem, WaitingKind } from "@armada/core/read";
import { useMemo, useState } from "react";
import { projectColor } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { type ActionContext, QuestionBlock, ReadyBlock } from "./Actions";
import {
  Card,
  CardGrid,
  CardHead,
  CardMeta,
  CardTitle,
  HeaderActions,
  Notice,
  Page,
  Section,
  SectionBody,
  Toolbar,
} from "./page";
import { AgentRow } from "./screens/AgentRow";
import { CoordinatorState as CoordinatorLine, Figure } from "./screens/ProjectsScreen";
import { useFleet, useNow, useShell } from "./shell/context";
import { Dot, EmptyState, ProjectChip, Tabs, Tag } from "./ui";

const since = (now: number, iso: string | null | undefined) => (iso ? now - Date.parse(iso) : 0);

/** A waiting item's color, by kind; a kind added later reads as a decision. */
const KIND_COLOR: Partial<Record<WaitingKind, string>> = {
  question: "var(--accent)",
  approval: "var(--accent)",
  blocked: "var(--critical)",
  "hand-back": "var(--done)",
  silent: "var(--active)",
};

export function Fleet({ initialProject }: { initialProject: string | null }) {
  const { overview, checkedAt, failed, pending, refresh, version } = useFleet();
  const { t, author, setAuthor, account, density } = useShell();
  const now = useNow();
  const [project, setProject] = useState(initialProject);

  const chooseProject = (next: string | null) => {
    setProject(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("project", next);
    else url.searchParams.delete("project");
    window.history.replaceState(null, "", url);
  };

  const known = overview.projects.some((p) => p.slug === project);
  const active = known ? project : null;
  const rows = useMemo(() => overview.rows.filter((r) => !active || r.project === active), [overview, active]);
  const waiting = useMemo(() => overview.waiting.filter((w) => !active || w.project === active), [overview, active]);
  const projects = overview.projects.filter((p) => !active || p.slug === active);
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const ready = useMemo(() => overview.ready.filter((r) => !active || r.project === active), [overview, active]);
  const coordinators = new Map<string, CoordinatorState>(overview.projects.map((p) => [p.slug, p.coordinator.state]));
  const profiles = new Map(overview.projects.map((p) => [p.slug, p.profiles]));
  const ctx: ActionContext = {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
  const silent = rows.filter((r) => r.silent).length;
  const redCi = rows.filter((r) => r.flags.includes("ci-failing")).length;
  const problems = projects.filter((p) => p.error || p.reading);

  return (
    <Page
      toolbar={
        overview.projects.length > 0 && (
          <Toolbar>
            <Tabs
              label={t.filterLabel}
              value={active ?? ""}
              onChange={(slug) => chooseProject(slug || null)}
              items={[
                { key: "", label: t.allProjects, count: overview.rows.length, dot: "var(--text-3)" },
                ...overview.projects.map((p) => ({
                  key: p.slug,
                  label: p.name,
                  count: p.inFlight,
                  dot: projectColor(p.slug),
                })),
              ]}
            />
          </Toolbar>
        )
      }
    >
      <HeaderActions>
        <LiveLine
          t={t}
          overview={overview}
          now={now}
          checkedAt={checkedAt}
          failed={failed}
          pending={pending}
          onRefresh={refresh}
        />
      </HeaderActions>
      {overview.live.state === "unreachable" && <Notice tone="warn">{t.unreachableBanner(overview.live.error)}</Notice>}
      {overview.live.state === "off" && <Notice>{t.offBanner}</Notice>}

      <Section label={t.waitingTitle} count={waiting.length}>
        {waiting.length === 0 ? (
          <SectionBody>
            <p>{t.waitingEmpty}</p>
          </SectionBody>
        ) : (
          <CardGrid wide>
            {waiting.map((w, k) => (
              <WaitingCard
                key={`${w.project}-${w.ticket ?? k}-${w.kind}`}
                ctx={ctx}
                w={w}
                names={names}
                coordinator={coordinators.get(w.project) ?? "unknown"}
              />
            ))}
          </CardGrid>
        )}
      </Section>

      <Section
        label={t.atWorkTitle}
        count={rows.length}
        side={
          <>
            <Figure label={t.stats.silent} value={silent} dot={silent ? "var(--active)" : undefined} />
            <Figure label={t.stats.redCi} value={redCi} dot={redCi ? "var(--critical)" : undefined} />
          </>
        }
      >
        {problems.map((p) =>
          p.error ? (
            <Notice key={p.slug} tone="critical">
              {t.projectError(p.name)} {p.error}
            </Notice>
          ) : (
            <Notice key={p.slug}>{t.readingProject(p.name)}</Notice>
          ),
        )}
        {overview.projects.length === 0 ? (
          <EmptyState title={t.noProjects} hint={t.noProjectsHint} />
        ) : rows.length === 0 ? (
          <EmptyState title={t.emptyFleet} hint={t.emptyFleetHint} />
        ) : (
          rows.map((r) => (
            <AgentRow
              key={`${r.project}-${r.id}`}
              row={r}
              projectName={names.get(r.project) ?? r.project}
              airy={density === "airy"}
            />
          ))
        )}
      </Section>

      {overview.projects.length > 0 && (
        <ReadyBlock ctx={ctx} ready={ready} profiles={profiles} names={names} coordinators={coordinators} />
      )}

      {projects.length > 0 && (
        <Section label={t.projects} count={projects.length} side={t.footerRefresh}>
          <CardGrid>
            {projects.map((p) => (
              <ProjectCard key={p.slug} t={t} p={p} now={now} />
            ))}
          </CardGrid>
        </Section>
      )}
    </Page>
  );
}

/** The header bar's live line: the source state, when the overview and Linear and GitHub were read, refresh. */
function LiveLine({
  t,
  overview,
  now,
  checkedAt,
  failed,
  pending,
  onRefresh,
}: {
  t: Strings;
  overview: FleetOverview;
  now: number;
  checkedAt: number | null;
  failed: boolean;
  pending: boolean;
  onRefresh: () => void;
}) {
  const state = failed ? "offline" : overview.live.state;
  const label = failed ? t.offline : t.live[overview.live.state];
  const checked = checkedAt ?? Date.parse(overview.generatedAt);
  // The oldest reading of Linear and GitHub shown: so nobody takes a stale view for a live one.
  const readings = overview.projects.flatMap((p) =>
    p.sources ? [p.sources.linear.fetchedAt, p.sources.github.fetchedAt ?? p.sources.linear.fetchedAt] : [],
  );
  const oldest = readings.length ? Math.min(...readings.map((r) => Date.parse(r))) : null;
  return (
    <span className="refresh">
      {/* Only the source state is announced; the ticking "checked" text is not. */}
      <span className={`source is-${state}`} role="status">
        <span className={`dot ${state === "ok" ? "live" : ""}`} />
        {label}
      </span>
      <span className="refresh-text">
        {pending && !checkedAt ? t.refreshing : t.checked(now - checked)}
        {oldest !== null && (
          <span className="faint" title={t.dataReadHint}>
            {" · "}
            {t.dataRead(now - oldest)}
          </span>
        )}
      </span>
      <button
        type="button"
        className={`icon-btn ${pending ? "spin" : ""}`}
        onClick={onRefresh}
        title={t.refresh}
        aria-label={t.refresh}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </span>
  );
}

/** One item waiting for the owner, as a decision card, with its answer or approval form. */
function WaitingCard({
  ctx,
  w,
  names,
  coordinator,
}: {
  ctx: ActionContext;
  w: WaitingItem;
  names: Map<string, string>;
  coordinator: CoordinatorState;
}) {
  const { t, now } = ctx;
  const color = KIND_COLOR[w.kind] ?? "var(--accent)";
  return (
    <Card>
      <CardHead
        icon={<Dot color={color} />}
        label={t.kinds[w.kind]}
        color={color}
        side={<span title={w.since}>{t.duration(since(now, w.since))}</span>}
      />
      <CardTitle>
        {w.url ? (
          <a href={w.url} target="_blank" rel="noreferrer">
            {w.title ?? w.ticket} <span className="faint">↗</span>
          </a>
        ) : (
          (w.title ?? w.ticket ?? names.get(w.project))
        )}
      </CardTitle>
      <CardMeta>
        <Tag>{names.get(w.project) ?? w.project}</Tag>
        {w.ticket && <span className="mono">{w.ticket}</span>}
        {w.author && <span>{w.author}</span>}
        {w.coordinatorSince && (
          <span className="late">{t.coordinatorLate(t.duration(since(now, w.coordinatorSince)))}</span>
        )}
      </CardMeta>
      {(w.kind === "question" || w.kind === "approval") && w.detail ? (
        <QuestionBlock
          ctx={ctx}
          project={w.project}
          ticket={w.ticket}
          item={w.item}
          body={w.detail}
          answer={w.answer}
          coordinator={coordinator}
          approval={w.kind === "approval"}
        />
      ) : (
        w.detail && <p className="wait-detail">{w.detail}</p>
      )}
    </Card>
  );
}

/** A project's card: its coordinator (and the CLI it runs), when Linear and GitHub were read, its notes. */
function ProjectCard({ t, p, now }: { t: Strings; p: ProjectOverview; now: number }) {
  return (
    <Card>
      <CardHead icon={<ProjectChip slug={p.slug} bare />} label={p.name} color="var(--text)" side={p.repository} />
      <CardMeta>
        <Figure label={t.shell.inFlight} value={p.inFlight} />
        <Figure label={t.shell.waitingForYou} value={p.waiting} dot={p.waiting ? "var(--accent)" : undefined} />
      </CardMeta>
      <CardMeta>
        <CoordinatorLine project={p} />
        {p.coordinator.cliVersion && (
          <span className="mono">{t.coordinatorCli(p.coordinator.cliVersion, p.coordinator.updateAvailable)}</span>
        )}
      </CardMeta>
      <CardMeta>
        {p.sources ? t.linearRead(t.duration(since(now, p.sources.linear.fetchedAt))) : "—"}
        {p.sources?.github.error ? ` · ${t.githubMissing}` : ""}
      </CardMeta>
      {p.warnings.length > 0 && (
        <details className="notes">
          <summary>{t.notes(p.warnings.length)}</summary>
          <ul>
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
