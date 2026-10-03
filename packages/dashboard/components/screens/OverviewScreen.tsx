"use client";

// The overview (THE-916): the Agents page's filters and density (THE-869),
// its sessions in flight as a board (THE-968): one lane per coordinator, six
// columns, the steps a session goes through (lib/coordinator-view.ts). Each
// lane's header says the project, its coordinator's harness, active or idle
// and since when, how many sessions run and, in orange, how many the owner has
// to validate; the lanes with something to validate come first. On a desk the
// columns line up from lane to lane, and a column no lane fills is a narrow
// strip; on a phone each lane scrolls sideways a column at a time, its empty
// columns narrow. The filters live in the address (THE-895: ?coordinator=,
// ?harness=, ?state=, ?q=, ?sort=… sorts each column), and the live timeline
// (THE-868) sits under the board, compact.
// `Overview` draws it on the filters it is given: the landing's replica
// (components/landing/Replica.tsx, THE-931), which has no router, plays it.
import type { FleetRow, ProjectOverview } from "@armada/core/read";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type CSSProperties, type ReactNode, useCallback, useId, useMemo } from "react";
import {
  BOARD_COLUMNS,
  type BoardColumn,
  type CoordinatorGroup,
  checksOf,
  coordinatorGroups,
  laneColumns,
  overviewLine,
  ownerChecks,
} from "@/lib/coordinator-view";
import { filterAgents, hasFilters } from "@/lib/filters";
import { coordinatorHarness, HARNESS_NAME, HARNESSES, harnessOf, paths } from "@/lib/fleet-view";
import { LONGEST_TIMES } from "@/lib/i18n";
import { FilterFields, type ListFilterControl, useListFilters } from "../FilterBar";
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
import { Dot, EmptyState, harnessColor, PhasePill, Steady, Tabs } from "../ui";
import { SessionCard } from "./SessionCard";

// The timeline is its own chunk (THE-892): the list does not wait for its code.
const LiveTimeline = dynamic(() => import("../timeline/Timeline").then((m) => m.LiveTimeline));

export function OverviewScreen() {
  return <Overview {...useListFilters("agents")} />;
}

/** The overview on the filters it is given, their links, and how to change them. */
export function Overview({ filters, go, hrefFor }: ListFilterControl) {
  const { t, density } = useShell();
  const { overview, failed } = useFleet();
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
  const lanes = useMemo(
    () => groups.map((g) => ({ group: g, columns: laneColumns(checks, g.rows) })),
    [groups, checks],
  );
  // A desk's columns line up from lane to lane: those no lane fills are narrow.
  const filled = useMemo(() => BOARD_COLUMNS.filter((c) => lanes.some((l) => l.columns[c].length)), [lanes]);
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
          <FilterFields list="agents" omit={["harness"]} filters={filters} go={go} />
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
        lanes.map(({ group: g, columns }) => (
          <CoordinatorSection key={g.project.slug} group={g}>
            {g.rows.length === 0 ? (
              <SectionBody>
                <p>{t.overview.nothingRunning}</p>
              </SectionBody>
            ) : (
              <Board
                columns={columns}
                filled={filled}
                long={all.length > LONG_LIST}
                airy={density === "airy"}
                toValidate={(r) => checksOf(checks, r).length > 0}
              />
            )}
          </CoordinatorSection>
        ))
      )}
      {overview.projects.length > 0 && <LiveTimeline project={filters.project} compact />}
    </Page>
  );
}

/** A grid's tracks: a column in `wide` takes its share, any other is a narrow strip. */
const tracks = (wide: readonly BoardColumn[]) =>
  BOARD_COLUMNS.map((c) => (wide.includes(c) ? "var(--ov-wide)" : "var(--ov-narrow)")).join(" ");

/**
 * One lane's board: its six columns, each a group named by its heading (the
 * column and its count) and holding its cards in a list. On a desk the
 * columns some lane fills (`filled`) are wide in every lane; on a phone, those
 * this lane fills.
 */
function Board({
  columns,
  filled,
  long,
  airy,
  toValidate,
}: {
  columns: Record<BoardColumn, FleetRow[]>;
  filled: readonly BoardColumn[];
  long: boolean;
  airy: boolean;
  toValidate: (r: FleetRow) => boolean;
}) {
  const { t } = useShell();
  const id = useId();
  const lane = tracks(BOARD_COLUMNS.filter((c) => columns[c].length));
  return (
    <div className="ov-lane">
      <div
        className={long ? "ov-board is-long" : "ov-board"}
        style={{ "--ov-board": tracks(filled), "--ov-lane": lane } as CSSProperties}
      >
        {BOARD_COLUMNS.map((c) => {
          const cards = columns[c];
          return (
            // biome-ignore lint/a11y/useSemanticElements: a column of cards, named by its heading; a fieldset would mean form fields
            <div
              key={c}
              role="group"
              aria-labelledby={`${id}-${c}`}
              className={`ov-col is-${c}${cards.length ? "" : " is-empty"}${filled.includes(c) ? "" : " is-narrow"}`}
            >
              <h3 className="ov-col-h" id={`${id}-${c}`}>
                <span className="ov-col-name">{t.overview.columns[c]}</span>{" "}
                <span className="ui-count">{cards.length}</span>
              </h3>
              {cards.length > 0 && (
                <ol className="ov-cards">
                  {cards.map((r) => (
                    <li key={`${r.project}-${r.id}`}>
                      <SessionCard row={r} airy={airy} toValidate={toValidate(r)} />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const COORDINATOR_COLOR = { active: "var(--done)", idle: "var(--active)", unknown: "var(--text-3)" } as const;

/** A coordinator's diamond, filled while it is active. */
function CoordinatorMark({ state }: { state: ProjectOverview["coordinator"]["state"] }) {
  return <span className={`sc-coord-mark is-${state}`} style={{ color: COORDINATOR_COLOR[state] }} aria-hidden />;
}

/**
 * One coordinator's lane: its header (the project, which opens the overview
 * filtered to it; the harness; active or idle and since when; what the owner
 * has to validate) and its board.
 */
function CoordinatorSection({
  group: { project: p, rows, toValidate },
  children,
}: {
  group: CoordinatorGroup;
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
            {c.state === "unknown" ? (
              t.shell.coordinatorUnknown
            ) : (
              // Active and idle share one box: a coordinator that turns idle as the clock moves moves nothing either.
              <Steady
                widest={LONGEST_TIMES.flatMap((n) => [
                  t.shell.coordinatorActive(t.ago(n)),
                  t.shell.coordinatorIdle(t.duration(n)),
                ])}
              >
                {c.state === "active" ? t.shell.coordinatorActive(t.ago(ms)) : t.shell.coordinatorIdle(t.duration(ms))}
              </Steady>
            )}
          </span>
          {toValidate > 0 && <PhasePill tone="waiting">{t.overview.toValidate(toValidate)}</PhasePill>}
        </span>
      }
    >
      {children}
    </Section>
  );
}
