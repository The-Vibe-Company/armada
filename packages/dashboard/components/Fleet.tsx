"use client";

// The overview (THE-867): what waits for the owner across every project. A
// summary band (how many agents run, what waits, what fails, the active
// coordinators), the decisions as cards the owner acts on, the problems as
// rows, the live timeline (THE-868) and one card per project. It renders the
// overview core builds, as the shell polls it (components/shell/context.tsx),
// on the page kit (components/page.tsx), through the view rules of
// lib/overview-view.ts.
import type { FleetOverview, ProjectHealth } from "@armada/core/read";
import { type ReactNode, useMemo } from "react";
import { HARNESS_NAME, paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import {
  decisionCards,
  handBackPr,
  overviewFigures,
  type Problem,
  problemsOf,
  projectFacts,
  sentRequest,
} from "@/lib/overview-view";
import { coordinatorHarness } from "@/lib/project-view";
import type { ActionContext } from "./Actions";
import {
  Card,
  CardGrid,
  CardHead,
  CardMeta,
  HeaderActions,
  Notice,
  Page,
  Row,
  RowIcon,
  RowId,
  RowSide,
  RowText,
  RowTime,
  Section,
  SectionBody,
} from "./page";
import { DecisionCard } from "./screens/DecisionCard";
import { useFleet, useNow, useShell } from "./shell/context";
import { LiveTimeline } from "./timeline/Timeline";
import { Dot, EmptyState, PhasePill, ProjectChip, RelativeTime, StatusDot, Tag, type Tone } from "./ui";

const PROBLEM_TONE: Record<Problem["kind"], Tone> = {
  ci: "error",
  conflict: "error",
  blocked: "error",
  silent: "silent",
  "not-started": "silent",
};

const HEALTH_COLOR: Record<ProjectHealth, string> = {
  blocked: "var(--critical)",
  watch: "var(--active)",
  "on-track": "var(--done)",
};

export function Fleet() {
  const { overview, checkedAt, failed, pending, refresh, version } = useFleet();
  const { t, author, setAuthor, account } = useShell();
  const now = useNow();
  const figures = useMemo(() => overviewFigures(overview), [overview]);
  const decisions = useMemo(() => decisionCards(overview), [overview]);
  const problems = useMemo(() => problemsOf(overview), [overview]);
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const coordinators = new Map(overview.projects.map((p) => [p.slug, p.coordinator.state]));
  const ctx: ActionContext = {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
  const unread = overview.projects.filter((p) => p.error || p.reading);

  return (
    <Page>
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
      {unread.map((p) =>
        p.error ? (
          <Notice key={p.slug} tone="critical">
            {t.projectError(p.name)} {p.error}
          </Notice>
        ) : (
          <Notice key={p.slug}>{t.readingProject(p.name)}</Notice>
        ),
      )}

      <Section
        label={t.overview.headline(figures.inFlight, figures.decide)}
        side={
          <>
            <Figure label={t.overview.figures.inFlight} value={figures.inFlight} />
            <Figure
              label={t.overview.figures.decide}
              value={figures.decide}
              dot={figures.decide ? "var(--accent)" : undefined}
            />
            <Figure
              label={t.overview.figures.failing}
              value={figures.failing}
              dot={figures.failing ? "var(--critical)" : undefined}
            />
            <Figure
              label={t.overview.figures.silent}
              value={figures.silent}
              dot={figures.silent ? "var(--active)" : undefined}
            />
            <Figure
              label={t.overview.figures.coordinators}
              value={`${figures.coordinators.active}/${figures.coordinators.total}`}
            />
          </>
        }
      >
        <SectionBody>
          <p>
            <time dateTime={new Date(now).toISOString()} suppressHydrationWarning>
              {dateLabel(now, t.overview.locale)}
            </time>
            {" · "}
            {t.overview.subline(figures)}
          </p>
        </SectionBody>
      </Section>

      {overview.projects.length === 0 ? (
        <EmptyState title={t.noProjects} hint={t.noProjectsHint} />
      ) : (
        <>
          <Section label={t.overview.decideTitle} count={decisions.length}>
            {decisions.length === 0 ? (
              <SectionBody>
                <p>{t.overview.decideEmpty}</p>
              </SectionBody>
            ) : (
              <CardGrid>
                {decisions.map((w, k) => {
                  const pr = w.kind === "hand-back" ? handBackPr(overview, w) : null;
                  return (
                    <DecisionCard
                      key={`${w.project}-${w.ticket ?? k}-${w.kind}`}
                      ctx={ctx}
                      w={w}
                      projectName={names.get(w.project) ?? w.project}
                      coordinator={coordinators.get(w.project) ?? "unknown"}
                      pr={pr}
                      sent={sentRequest(overview, w, pr)}
                    />
                  );
                })}
              </CardGrid>
            )}
          </Section>

          {problems.length > 0 && (
            <Section label={t.overview.problemsTitle} count={problems.length}>
              {problems.map((p) => (
                <ProblemRow key={`${p.project}-${p.ticket}`} t={t} p={p} now={now} projectName={names.get(p.project)} />
              ))}
            </Section>
          )}

          <LiveTimeline />

          <Section label={t.overview.projectsTitle} count={overview.projects.length}>
            <CardGrid>
              {overview.projects.map((p) => (
                <ProjectCard key={p.slug} t={t} overview={overview} slug={p.slug} />
              ))}
            </CardGrid>
          </Section>
        </>
      )}
    </Page>
  );
}

/** "Wednesday 1 October · 15:42", in the viewer's language. */
function dateLabel(now: number, locale: string): string {
  const d = new Date(now);
  const day = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(d);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time}`;
}

/** A figure of a section's side, its label in grey: "En vol 10". */
function Figure({ label, value, dot }: { label: string; value: number | string; dot?: string }) {
  return (
    <span className="sc-figure">
      {dot && <Dot color={dot} size={6} />}
      <span className="faint">{label}</span> <span className="mono">{value}</span>
    </span>
  );
}

/** Something broken, as a row that opens the agent (or, for a launch never started, its project). */
function ProblemRow({ t, p, now, projectName }: { t: Strings; p: Problem; now: number; projectName?: string }) {
  const tone = PROBLEM_TONE[p.kind];
  const line =
    p.kind === "ci"
      ? t.overview.ciLine(p.pr, p.check)
      : p.kind === "conflict"
        ? t.overview.conflictLine(p.pr)
        : p.kind === "silent"
          ? t.overview.silentLine(t.duration(Math.max(0, now - Date.parse(p.since))))
          : (p.detail ?? "");
  return (
    <Row href={p.href}>
      <RowIcon>
        <StatusDot status={tone === "error" ? "error" : "silent"} label={t.overview.problems[p.kind]} />
      </RowIcon>
      <RowId>{p.ticket}</RowId>
      <RowText title={p.title ?? p.ticket} line={line} />
      {projectName && (
        <RowSide roomy>
          <Tag>{projectName}</Tag>
        </RowSide>
      )}
      <RowSide>
        <PhasePill tone={tone}>{t.overview.problems[p.kind]}</PhasePill>
      </RowSide>
      <RowTime>
        <RelativeTime at={p.since} format="duration" />
      </RowTime>
    </Row>
  );
}

/** A project's card: its progress, health, coordinator, agents, pull requests and last activity. */
function ProjectCard({ t, overview, slug }: { t: Strings; overview: FleetOverview; slug: string }) {
  const p = overview.projects.find((x) => x.slug === slug);
  const facts = useMemo(() => projectFacts(overview, slug), [overview, slug]);
  if (!p) return null;
  const harness = coordinatorHarness(p.coordinator.harness);
  const coordColor =
    p.coordinator.state === "active"
      ? "var(--done)"
      : p.coordinator.state === "idle"
        ? "var(--active)"
        : "var(--text-3)";
  return (
    <Card href={paths.project(p.slug)}>
      <CardHead
        icon={<ProjectChip slug={p.slug} bare />}
        label={p.name}
        color="var(--text)"
        side={facts.progress === null ? "—" : `${facts.progress}%`}
      />
      <CardMeta>
        <span className="mono">{p.repository}</span>
      </CardMeta>
      <Fact label={t.overview.healthKey}>
        {p.health ? <span style={{ color: HEALTH_COLOR[p.health] }}>{t.overview.health[p.health]}</span> : "—"}
      </Fact>
      <Fact label={t.overview.coordinatorKey}>
        <Dot color={coordColor} size={6} />
        {harness ? HARNESS_NAME[harness] : t.shell.coordinatorUnknown}
      </Fact>
      <Fact label={t.overview.agentsKey}>{t.overview.agents(facts.inFlight, facts.ready)}</Fact>
      <Fact label={t.overview.prsKey}>{facts.prs ? t.overview.prs(facts.prs.open, facts.prs.green) : "—"}</Fact>
      <Fact label={t.overview.activityKey}>
        <RelativeTime at={facts.lastActivity} />
      </Fact>
    </Card>
  );
}

/** A line of a project's card: its name in grey, its value after. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <CardMeta>
      <span className="sc-figure">
        <span className="faint">{label}</span> {children}
      </span>
    </CardMeta>
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
