"use client";

// The overview (THE-916): the Agents page (THE-869), its list, density, rows
// and filters, with its sessions grouped by coordinator. Each group's header
// says the project, its coordinator's harness, active or idle and since when,
// how many sessions run and, in orange, how many the owner has to validate;
// the sessions to validate come first, and so do their groups. The filters
// live in the address (THE-895: ?coordinator=, ?harness=, ?state=, ?q=,
// ?sort=…), and the live timeline (THE-868) sits under the list, compact.
import type { FleetRow, ProjectOverview } from "@armada/core/read";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type ReactNode, useCallback, useMemo } from "react";
import { type CoordinatorGroup, checksOf, coordinatorGroups, overviewLine, ownerChecks } from "@/lib/coordinator-view";
import { filterAgents, hasFilters } from "@/lib/filters";
import { coordinatorHarness, HARNESS_NAME, HARNESSES, harnessOf, paths } from "@/lib/fleet-view";
import { FilterBar, useListFilters } from "../FilterBar";
import {
  Alert,
  Button,
  DensityToggle,
  LONG_LIST,
  Notice,
  Page,
  Section,
  SectionBody,
  StatusHeader,
  Toolbar,
} from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Dot, EmptyState, harnessColor, PhasePill, Tabs } from "../ui";
import { AgentRow } from "./AgentRow";

// The timeline is its own chunk (THE-892): the list does not wait for its code.
const LiveTimeline = dynamic(() => import("../timeline/Timeline").then((m) => m.LiveTimeline));

export function OverviewScreen() {
  const { t, density } = useShell();
  const { overview, failed } = useFleet();
  const { filters, go, hrefFor } = useListFilters("agents");
  const { harness } = filters;
  const names = useMemo(() => new Map(overview.projects.map((p) => [p.slug, p.name])), [overview]);
  const checks = useMemo(() => ownerChecks(overview), [overview]);
  // "Needs me" keeps what the owner has to validate.
  const mine = useCallback((r: FleetRow) => checksOf(checks, r).length > 0, [checks]);
  // The tabs count what the other filters keep.
  const all = useMemo(
    () => filterAgents(overview.rows, { ...filters, harness: null }, names, mine),
    [overview, filters, names, mine],
  );
  const groups = useMemo(() => {
    const rows = filterAgents(overview.rows, filters, names, mine);
    // A coordinator with nothing in flight shows while the view is filtered on nothing but it.
    const empty = !hasFilters({ ...filters, project: null });
    const kept = filters.project ? overview.projects.filter((p) => p.slug === filters.project) : overview.projects;
    return coordinatorGroups({ ...overview, projects: kept }, rows, { sorted: filters.sort !== null, empty });
  }, [overview, filters, names, mine]);
  const line = overviewLine(overview);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const unread = overview.projects.filter((p) => p.error || p.reading);

  return (
    <Page
      status={
        <StatusHeader
          lead={`${t.overview.line.coordinators(line.coordinators)} · ${t.overview.line.running(line.running)}`}
          then={
            line.toValidate ? (
              <span className="ov-yours">· {t.overview.line.toValidate(line.toValidate)}</span>
            ) : (
              `· ${t.overview.line.nothing}`
            )
          }
        />
      }
      toolbar={
        <>
          <Toolbar end={<DensityToggle />}>
            <Tabs
              label={t.shell.harnessHeading}
              value={harness ?? "all"}
              push
              items={[
                {
                  key: "all",
                  label: t.shell.all,
                  count: all.length,
                  dot: "var(--text-3)",
                  href: hrefFor({ harness: null }),
                },
                ...HARNESSES.map((h) => ({
                  key: h,
                  label: HARNESS_NAME[h],
                  count: all.filter((r) => harnessOf(r.runtime) === h).length,
                  dot: harnessColor(h),
                  href: hrefFor({ harness: h }),
                })),
              ]}
            />
          </Toolbar>
          <FilterBar list="agents" omit={["harness"]} />
        </>
      }
    >
      {overview.live.state === "unreachable" && !failed && (
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
      {overview.projects.length === 0 ? (
        <EmptyState title={t.noProjects} hint={t.noProjectsHint} />
      ) : groups.length === 0 || (shown === 0 && hasFilters({ ...filters, project: null, harness: null })) ? (
        <EmptyState title={t.filters.noMatch} hint={t.filters.noMatchHint}>
          <Button
            type="button"
            onClick={() => go({ project: null, state: null, profile: null, mine: false, q: "", harness: null })}
          >
            {t.filters.clear}
          </Button>
        </EmptyState>
      ) : (
        groups.map((g) => (
          <CoordinatorSection key={g.project.slug} group={g} long={all.length > LONG_LIST}>
            {g.rows.length === 0 ? (
              <SectionBody>
                <p>{t.overview.nothingRunning}</p>
              </SectionBody>
            ) : (
              g.rows.map((r) => (
                <AgentRow
                  key={`${r.project}-${r.id}`}
                  row={r}
                  airy={density === "airy"}
                  toValidate={checksOf(checks, r).length > 0}
                />
              ))
            )}
          </CoordinatorSection>
        ))
      )}
      {overview.projects.length > 0 && <LiveTimeline project={filters.project} compact />}
    </Page>
  );
}

const COORDINATOR_COLOR = { active: "var(--done)", idle: "var(--active)", unknown: "var(--text-3)" } as const;

/** A coordinator's diamond, filled while it is active. */
function CoordinatorMark({ state }: { state: ProjectOverview["coordinator"]["state"] }) {
  return <span className={`sc-coord-mark is-${state}`} style={{ color: COORDINATOR_COLOR[state] }} aria-hidden />;
}

/**
 * One coordinator's group: its header (the project, which opens the overview
 * filtered to it; the harness; active or idle and since when; what the owner
 * has to validate) and its sessions in flight.
 */
function CoordinatorSection({
  group: { project: p, rows, toValidate },
  long,
  children,
}: {
  group: CoordinatorGroup;
  long: boolean;
  children: ReactNode;
}) {
  const { t } = useShell();
  const now = useNow();
  const c = p.coordinator;
  const h = coordinatorHarness(c.harness);
  const ms = c.seenAt ? Math.max(0, now - Date.parse(c.seenAt)) : 0;
  return (
    <Section
      id={`coordinator-${p.slug}`}
      icon={<CoordinatorMark state={c.state} />}
      label={
        <Link href={paths.coordinator(p.slug)} prefetch={false} className="ov-group-link">
          {p.name}
        </Link>
      }
      count={rows.length}
      long={long}
      side={
        <span className="ov-group-side">
          {h && (
            <span className="ui-harness">
              <Dot color={harnessColor(h)} />
              {h === "other"
                ? t.shell.agent.terminal
                : h === "conductor"
                  ? HARNESS_NAME[h]
                  : t.shell.local(HARNESS_NAME[h])}
            </span>
          )}
          <span className="ov-group-state" style={{ color: COORDINATOR_COLOR[c.state] }}>
            {c.state === "active"
              ? t.shell.coordinatorActive(t.ago(ms))
              : c.state === "idle"
                ? t.shell.coordinatorIdle(t.duration(ms))
                : t.shell.coordinatorUnknown}
          </span>
          {toValidate > 0 && <PhasePill tone="waiting">{t.overview.toValidate(toValidate)}</PhasePill>}
        </span>
      }
    >
      {children}
    </Section>
  );
}
