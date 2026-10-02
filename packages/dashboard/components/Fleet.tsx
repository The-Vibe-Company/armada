"use client";

// The overview (THE-867, Night watch THE-899): what needs the owner and what
// the fleet is doing. Its status sentence ("11 agents in flight. 4 wait for
// you.", "Welcome back. 6 merged while you were away." when the viewer
// returns) and its figures as chips (failing and silent open their group on
// /agents), what happened while the viewer was away, the decisions as cards
// the owner acts on (a coordinator that stopped answering first), the live
// timeline (THE-868) and one card per project. A failing or
// silent agent shows in the timeline and on /agents, not in a list of its own
// (THE-880). It renders the overview core builds, as the shell polls it
// (components/shell/context.tsx), on the page kit (components/page.tsx),
// through the view rules of lib/overview-view.ts.
import type { FleetOverview, SinceSummary } from "@armada/core/read";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { agentState, paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import {
  type CoordinatorAlert,
  coordinatorAlerts,
  overviewFigures,
  pendingValidations,
  withCoordinator,
} from "@/lib/overview-view";
import { type OverviewLead, type OverviewThen, overviewStatus } from "@/lib/status-view";
import type { ActionContext } from "./Actions";
import { LiveMark } from "./mark";
import { ProjectCard } from "./ProjectCard";
import {
  Alert,
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
  Stat,
  StatusHeader,
} from "./page";
import { SinceAway, useSince } from "./SinceAway";
import { ValidationCard } from "./screens/ValidationCard";
import { useFleet, useNow, useShell } from "./shell/context";
import { Dot, EmptyState, ProjectChip, Tag } from "./ui";

// The timeline is its own chunk (THE-892): rendered on the server as before,
// so nothing moves, but the rest of the overview does not wait for its code.
const LiveTimeline = dynamic(() => import("./timeline/Timeline").then((m) => m.LiveTimeline));

/**
 * `insights`: this week's delivery (THE-893), a chip of the status, and
 * `since`: what happened while the viewer was away (THE-894), both read with
 * the overview's page; the landing's replica has neither.
 */
export function Fleet({ insights, since }: { insights?: ReactNode; since?: SinceSummary | null } = {}) {
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
  const away = useSince(since);
  const ready = overview.ready.filter((r) => r.readyForAgent && !r.launch).length;
  const merge = overview.rows.filter((r) => agentState(r).status === "done").length;
  const status = overviewStatus(figures, away.summary && { merged: away.summary.merged.length }, ready);

  return (
    <Page
      status={
        <StatusHeader
          lead={leadText(t, status.lead)}
          then={thenText(t, status.then)}
          line={
            <>
              <time className="tnum" dateTime={new Date(now).toISOString()} suppressHydrationWarning>
                {dateLabel(now, t.overview.locale)}
              </time>
              {" · "}
              {t.overview.subline(figures)}
            </>
          }
          stats={
            <>
              <Stat
                value={figures.decide}
                label={t.status.stats.decide}
                hue={figures.decide ? "yours" : undefined}
                href={figures.decide ? paths.validations : undefined}
              />
              <Stat
                value={figures.failing}
                label={t.status.stats.failing}
                hue={figures.failing ? "fail" : undefined}
                href={figures.failing ? paths.agentGroup("error") : undefined}
              />
              <Stat
                value={figures.silent}
                label={t.status.stats.silent}
                hue={figures.silent ? "silent" : undefined}
                href={figures.silent ? paths.agentGroup("silent") : undefined}
              />
              <Stat
                value={merge}
                label={t.status.stats.merge}
                hue={merge ? "done" : undefined}
                href={merge ? paths.agentGroup("done") : undefined}
              />
              <Stat
                value={`${figures.coordinators.active}/${figures.coordinators.total}`}
                label={t.status.stats.coordinators}
              />
              {insights}
            </>
          }
        />
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
      {overview.live.state === "unreachable" && (
        <Alert tone="warn" title={t.live.unreachable}>
          {t.unreachableBanner(overview.live.error)}
        </Alert>
      )}
      {overview.live.state === "off" && <Notice>{t.offBanner}</Notice>}
      {unread.map((p) =>
        p.error ? (
          <Alert key={p.slug} title={t.projectError(p.name)}>
            {p.error}
          </Alert>
        ) : (
          <Notice key={p.slug}>{t.readingProject(p.name)}</Notice>
        ),
      )}
      {away.summary && <SinceAway summary={away.summary} onDismiss={away.dismiss} />}

      {overview.projects.length === 0 ? (
        <Section label={t.overview.projectsTitle} count={0}>
          <EmptyState title={t.noProjects} hint={t.noProjectsHint} />
        </Section>
      ) : (
        <>
          <Section
            label={t.overview.decideTitle}
            count={figures.decide}
            side={
              checks.length > 0 && (
                <Link href={paths.validations} prefetch>
                  {t.overview.allValidations}
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
                {alerts.map((a, i) => (
                  <StoppedCard
                    key={a.project}
                    t={t}
                    a={a}
                    now={now}
                    projectName={names.get(a.project) ?? a.project}
                    oldest={i === 0}
                  />
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
            <CardGrid thirds>
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

/** The status sentence's first half, in the viewer's language. */
function leadText(t: Strings, lead: OverviewLead): string {
  if (lead.kind === "away") return t.status.welcome(lead.merged);
  if (lead.kind === "flight") return t.status.flight(lead.agents);
  return t.status.rest;
}

/** Its quieter second half. */
function thenText(t: Strings, then: OverviewThen): string {
  if (then.kind === "decide") return t.status.decide(then.n);
  if (then.kind === "failing") return t.status.failing(then.n);
  if (then.kind === "ready") return t.status.ready(then.n);
  return t.status.calm;
}

/** A coordinator that stopped answering while items wait for it: what the owner does to bring it back. */
function StoppedCard({
  t,
  a,
  now,
  projectName,
  oldest,
}: {
  t: Strings;
  a: CoordinatorAlert;
  now: number;
  projectName: string;
  /** The oldest decision: its card glows (THE-899). */
  oldest: boolean;
}) {
  const seen = a.seenAt === null ? null : t.duration(Math.max(0, now - Date.parse(a.seenAt)));
  return (
    <Card className={oldest ? "is-oldest" : undefined}>
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
        <Tag>
          <ProjectChip slug={a.project} name={projectName} />
        </Tag>
        <span className="late">{t.overview.stopped.waiting(a.waiting)}</span>
        <span>{t.overview.stopped.seen(seen)}</span>
      </CardMeta>
      <p className="wait-detail is-note">{t.overview.stopped.what}</p>
      <span className="ui-card-actions">
        <Link href={paths.project(a.project)} prefetch className="ui-button is-small">
          {t.overview.stopped.open}
        </Link>
      </span>
    </Card>
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
        <LiveMark
          size={14}
          state={state === "ok" ? "live" : pending && !checkedAt ? "loading" : "paused"}
          beat={checkedAt ?? undefined}
        />
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
