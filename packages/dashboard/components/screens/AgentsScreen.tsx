"use client";

import type { ProjectOverview } from "@armada/core/read";
// /agents (THE-869): each project's coordinator, then every session grouped by
// what it needs, the harness filter in the address (?harness=), the density
// the viewer chose. It is the page the page kit (components/page.tsx) was
// taken from.
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import {
  AGENT_STATUSES,
  agentState,
  coordinatorHarness,
  decisionsOf,
  HARNESS_NAME,
  HARNESSES,
  type Harness,
  harnessOf,
  isHarness,
  paths,
} from "@/lib/fleet-view";
import { DensityToggle, Page, Row, RowIcon, RowSide, RowText, Section, Toolbar } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Dot, EmptyState, harnessColor, StatusDot, Tabs } from "../ui";
import { AgentRow } from "./AgentRow";

export function AgentsScreen() {
  const { t, density } = useShell();
  const { overview } = useFleet();
  const asked = useSearchParams().get("harness");
  const harness: Harness | null = isHarness(asked) ? asked : null;
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const groups = useMemo(() => {
    const rows = overview.rows.filter((r) => !harness || harnessOf(r.runtime) === harness);
    return AGENT_STATUSES.map((status) => ({
      status,
      rows: rows.filter((r) => agentState(r).status === status),
    })).filter((g) => g.rows.length);
  }, [overview, harness]);
  const all = overview.rows;
  const coordinators = overview.projects.filter(
    (p) => !harness || coordinatorHarness(p.coordinator.harness) === harness,
  );
  const decisions = decisionsOf(overview);

  return (
    <Page
      toolbar={
        <Toolbar end={<DensityToggle />}>
          <Tabs
            label={t.shell.harnessHeading}
            value={harness ?? "all"}
            items={[
              { key: "all", label: t.shell.all, count: all.length, dot: "var(--text-3)", href: paths.agents() },
              ...HARNESSES.map((h) => ({
                key: h,
                label: HARNESS_NAME[h],
                count: all.filter((r) => harnessOf(r.runtime) === h).length,
                dot: harnessColor(h),
                href: paths.agents(h),
              })),
            ]}
          />
        </Toolbar>
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
        <EmptyState title={t.shell.noAgents} hint={t.shell.noAgentsHint} />
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
