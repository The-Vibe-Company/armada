"use client";

// /agents until THE-869 builds it: every session grouped by what it needs, the
// harness filter in the address (?harness=), the density the viewer chose.
// It is the page the page kit (components/page.tsx) was taken from.
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import {
  AGENT_STATUSES,
  agentState,
  HARNESS_NAME,
  HARNESSES,
  type Harness,
  harnessOf,
  isHarness,
  paths,
} from "@/lib/fleet-view";
import { DensityToggle, Page, Section, Toolbar } from "../page";
import { useFleet, useShell } from "../shell/context";
import { EmptyState, harnessColor, StatusDot, Tabs } from "../ui";
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
      {groups.length === 0 ? (
        <EmptyState title={t.shell.noAgents} hint={t.shell.noAgentsHint} />
      ) : (
        groups.map((g) => (
          <Section
            key={g.status}
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
