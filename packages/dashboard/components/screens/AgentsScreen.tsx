"use client";

import type { ProjectOverview } from "@armada/core/read";
// /agents (THE-869): each project's coordinator, then every session grouped by
// what it needs, the density the viewer chose. Its filters live in the
// address (THE-895: ?harness=, ?project=, ?state=, ?q=, ?sort=…). It is the
// page the page kit (components/page.tsx) was taken from.
import { useMemo } from "react";
import { filterAgents, hasFilters } from "@/lib/filters";
import {
  AGENT_STATUSES,
  agentState,
  coordinatorHarness,
  decisionsOf,
  HARNESS_NAME,
  HARNESSES,
  harnessOf,
  paths,
} from "@/lib/fleet-view";
import { FilterBar, useListFilters } from "../FilterBar";
import { Button, DensityToggle, Page, Row, RowIcon, RowSide, RowText, Section, Toolbar } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Dot, EmptyState, harnessColor, StatusDot, Tabs } from "../ui";
import { AgentRow } from "./AgentRow";

export function AgentsScreen() {
  const { t, density } = useShell();
  const { overview } = useFleet();
  const { filters, go, hrefFor } = useListFilters("agents");
  const { harness } = filters;
  const names = useMemo(() => new Map(overview.projects.map((p) => [p.slug, p.name])), [overview]);
  const groups = useMemo(() => {
    const rows = filterAgents(overview.rows, filters, names);
    return AGENT_STATUSES.map((status) => ({
      status,
      rows: rows.filter((r) => agentState(r).status === status),
    })).filter((g) => g.rows.length);
  }, [overview, filters, names]);
  // The tabs count what the other filters keep.
  const all = useMemo(
    () => filterAgents(overview.rows, { ...filters, harness: null }, names),
    [overview, filters, names],
  );
  // Coordinators answer to a project, a harness and a project's name; a session's state or profile is not theirs.
  const coordinators =
    filters.state || filters.profile || filters.mine
      ? []
      : overview.projects.filter(
          (p) =>
            (!harness || coordinatorHarness(p.coordinator.harness) === harness) &&
            (!filters.project || p.slug === filters.project) &&
            (!filters.q || `${p.name} ${p.slug}`.toLowerCase().includes(filters.q.toLowerCase())),
        );
  const decisions = decisionsOf(overview);

  return (
    <Page
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
      {coordinators.length > 0 && (
        <Section
          icon={
            <CoordinatorMark state={coordinators.some((p) => p.coordinator.state === "active") ? "active" : "idle"} />
          }
          label={t.shell.coordinators}
          count={coordinators.length}
          side={t.shell.onePerProject}
        >
          {coordinators.map((p) => (
            <CoordinatorRow key={p.slug} project={p} waiting={decisions.filter((d) => d.project === p.slug).length} />
          ))}
        </Section>
      )}
      {groups.length === 0 ? (
        hasFilters({ ...filters, harness: null }) && overview.rows.length > 0 ? (
          <EmptyState title={t.filters.noMatch} hint={t.filters.noMatchHint}>
            <Button type="button" onClick={() => go({ project: null, state: null, profile: null, mine: false, q: "" })}>
              {t.filters.clear}
            </Button>
          </EmptyState>
        ) : (
          <EmptyState title={t.shell.noAgents} hint={t.shell.noAgentsHint} />
        )
      ) : (
        groups.map((g) => (
          <Section
            key={g.status}
            id={g.status}
            icon={<StatusDot status={g.status} />}
            label={t.shell.groups[g.status]}
            count={g.rows.length}
          >
            {g.rows.map((r) => (
              <AgentRow
                key={`${r.project}-${r.id}`}
                row={r}
                projectName={names.get(r.project)}
                airy={density === "airy"}
              />
            ))}
          </Section>
        ))
      )}
    </Page>
  );
}

const COORDINATOR_COLOR = { active: "var(--done)", idle: "var(--active)", unknown: "var(--text-3)" } as const;

/** A coordinator's diamond, filled while it is active. */
function CoordinatorMark({ state }: { state: ProjectOverview["coordinator"]["state"] }) {
  return <span className={`sc-coord-mark is-${state}`} style={{ color: COORDINATOR_COLOR[state] }} aria-hidden />;
}

/** One project's coordinator: its harness, where it runs, what waits for the owner, active or not. */
function CoordinatorRow({ project: p, waiting }: { project: ProjectOverview; waiting: number }) {
  const { t } = useShell();
  const now = useNow();
  const c = p.coordinator;
  const h = coordinatorHarness(c.harness);
  const ms = c.seenAt ? Math.max(0, now - Date.parse(c.seenAt)) : 0;
  return (
    <Row href={paths.project(p.slug)}>
      <RowIcon>
        <CoordinatorMark state={c.state} />
      </RowIcon>
      <RowText
        title={p.name}
        line={
          h ? (
            <span className="ui-harness">
              <Dot color={harnessColor(h)} />
              {h === "other"
                ? t.shell.agent.terminal
                : h === "conductor"
                  ? HARNESS_NAME[h]
                  : t.shell.local(HARNESS_NAME[h])}
              {c.handle && <span className="mono"> {c.handle}</span>}
            </span>
          ) : (
            c.handle && <span className="mono">{c.handle}</span>
          )
        }
      />
      <RowSide roomy>
        <span style={{ color: waiting ? "var(--accent)" : "var(--text-3)" }}>
          {t.shell.agent.coordinatorWaiting(waiting)}
        </span>
      </RowSide>
      <RowSide width={160}>
        <span style={{ color: COORDINATOR_COLOR[c.state], marginLeft: "auto" }}>
          {c.state === "active"
            ? t.shell.coordinatorActive(t.ago(ms))
            : c.state === "idle"
              ? t.shell.coordinatorIdle(t.duration(ms))
              : t.shell.coordinatorUnknown}
        </span>
      </RowSide>
    </Row>
  );
}
