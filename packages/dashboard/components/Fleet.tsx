"use client";

// The overview (THE-867): what needs the owner and what the fleet is doing.
// A summary band (how many agents run, what waits, what fails, the active
// coordinators; failing and silent open their group on /agents), the
// decisions as cards the owner acts on (a coordinator that stopped answering
// first), the live timeline (THE-868) and one card per project. A failing or
// silent agent shows in the timeline and on /agents, not in a list of its own
// (THE-880). It renders the overview core builds, as the shell polls it
// (components/shell/context.tsx), on the page kit (components/page.tsx),
// through the view rules of lib/overview-view.ts.
import type { FleetOverview, ProjectHealth } from "@armada/core/read";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { HARNESS_NAME, paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import {
  type CoordinatorAlert,
  coordinatorAlerts,
  overviewFigures,
  pendingValidations,
  projectFacts,
  withCoordinator,
} from "@/lib/overview-view";
import { coordinatorHarness } from "@/lib/project-view";
import type { ActionContext } from "./Actions";
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
} from "./page";
import { ValidationCard } from "./screens/ValidationCard";
import { useFleet, useNow, useShell } from "./shell/context";
import { LiveTimeline } from "./timeline/Timeline";
import { Dot, EmptyState, ProjectChip, RelativeTime, Tag } from "./ui";

const HEALTH_COLOR: Record<ProjectHealth, string> = {
  blocked: "var(--critical)",
  watch: "var(--active)",
  "on-track": "var(--done)",
};

/** `insights`: the line under the summary (THE-893), which the overview page reads; the landing's replica has none. */
export function Fleet({ insights }: { insights?: ReactNode } = {}) {
  const { overview, checkedAt, failed, pending, refresh, version } = useFleet();
  const { t, author, setAuthor, account } = useShell();
  const now = useNow();
  const figures = useMemo(() => overviewFigures(overview), [overview]);
  const checks = useMemo(() => pendingValidations(overview), [overview]);
  const alerts = useMemo(() => coordinatorAlerts(overview), [overview]);
  const queue = useMemo(() => withCoordinator(overview), [overview]);
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
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
              href={figures.failing ? paths.agentGroup("error") : undefined}
            />
            <Figure
              label={t.overview.figures.silent}
              value={figures.silent}
              dot={figures.silent ? "var(--active)" : undefined}
              href={figures.silent ? paths.agentGroup("silent") : undefined}
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
          {insights}
        </SectionBody>
      </Section>

      {overview.projects.length === 0 ? (
        <EmptyState title={t.noProjects} hint={t.noProjectsHint} />
      ) : (
        <>
          <Section
            label={t.overview.decideTitle}
            count={figures.decide}
            side={
              checks.length > 0 && (
                <Link href={paths.validations} prefetch className="sc-figure is-link">
                  <span className="faint">{t.shell.nav.validations}</span> <span className="mono">{checks.length}</span>
                </Link>
              )
            }
          >
            {figures.decide === 0 ? (
              <SectionBody>
                <p>{t.overview.decideEmpty}</p>
              </SectionBody>
            ) : (
              <CardGrid>
                {alerts.map((a) => (
                  <StoppedCard key={a.project} t={t} a={a} now={now} projectName={names.get(a.project) ?? a.project} />
                ))}
                {checks.map((v) => (
                  <ValidationCard
                    key={v.id}
                    ctx={ctx}
                    v={v}
                    projectName={names.get(v.project) ?? v.project}
                    mode="compact"
                  />
                ))}
              </CardGrid>
            )}
            {queue && (
              <SectionBody>
                <p className="calm">
                  {t.overview.withCoordinator(queue.count, t.duration(Math.max(0, now - Date.parse(queue.since))))}
                </p>
              </SectionBody>
            )}
          </Section>

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

/** A figure of a section's side, its label in grey: "En vol 10"; with `href`, a link to what it counts. */
function Figure({ label, value, dot, href }: { label: string; value: number | string; dot?: string; href?: string }) {
  const body = (
    <>
      {dot && <Dot color={dot} size={6} />}
      <span className="faint">{label}</span> <span className="mono">{value}</span>
    </>
  );
  return href ? (
    <Link href={href} prefetch className="sc-figure is-link">
      {body}
    </Link>
  ) : (
    <span className="sc-figure">{body}</span>
  );
}

/** A coordinator that stopped answering while items wait for it: what the owner does to bring it back. */
function StoppedCard({
  t,
  a,
  now,
  projectName,
}: {
  t: Strings;
  a: CoordinatorAlert;
  now: number;
  projectName: string;
}) {
  const seen = a.seenAt === null ? null : t.duration(Math.max(0, now - Date.parse(a.seenAt)));
  return (
    <Card>
      <CardHead
        icon={<Dot color="var(--active)" />}
        label={t.overview.stopped.kind}
        color="var(--active)"
        side={<span title={a.since}>{t.ago(Math.max(0, now - Date.parse(a.since)))}</span>}
      />
      <CardTitle>
        <Link href={paths.project(a.project)} prefetch>
          {t.overview.stopped.title(projectName)}
        </Link>
      </CardTitle>
      <CardMeta>
        <Tag>{projectName}</Tag>
        <span className="late">{t.overview.stopped.waiting(a.waiting)}</span>
        <span>{t.overview.stopped.seen(seen)}</span>
      </CardMeta>
      <p className="wait-detail is-note">{t.overview.stopped.what}</p>
      <Link href={paths.project(a.project)} prefetch className="link">
        {t.overview.stopped.open}
      </Link>
    </Card>
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
        {/* The dot's color in words (THE-891): seen when the coordinator is not at work. */}
        {p.coordinator.state === "active" ? (
          <span className="sr-only"> · {t.a11y.coordinator.active}</span>
        ) : (
          harness && ` · ${t.a11y.coordinator[p.coordinator.state]}`
        )}
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
      {/* Read, not announced: the shell's one live region says what changed (THE-891). */}
      <span className={`source is-${state}`}>
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
