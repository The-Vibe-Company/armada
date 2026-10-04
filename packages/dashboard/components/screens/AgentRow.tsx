"use client";

// One agent in flight as a list row, on the page kit's Row: the row a
// project's page shows.
import type { FleetRow } from "@armada/core/read";
import { useEffect, useRef, useState } from "react";
import { agentState, harnessOf, paths } from "@/lib/fleet-view";
import { splitQuestion } from "../Actions";
import { Row, RowId, RowSide, RowText, RowTime } from "../page";
import { useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import { HarnessBadge, PhasePill, ProjectChip, RelativeTime, StatusDot, Steps, Tag, toneColor } from "../ui";

/** What a row says under its title: the open question, else the worker's last status. */
export const rowLine = (r: FleetRow) =>
  r.question ? splitQuestion(r.question.body).text.split("\n")[0] : (r.statusLine?.summary ?? "");

/** How long a row glows after it reported (THE-899). */
const FRESH_MS = 1_600;

/**
 * True for a moment after `at` moves while the row is on screen: a row that
 * just reported glows once. Never on the first render.
 */
export function useFresh(at: string | null): boolean {
  const first = useRef(at);
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    if (at === first.current || at === null) return;
    first.current = at;
    setFresh(at);
    const timer = setTimeout(() => setFresh(null), FRESH_MS);
    return () => clearTimeout(timer);
  }, [at]);
  return fresh !== null;
}

/** How far along the six steps a row is, for its status ring. */
export const rowProgress = (r: FleetRow) => Math.round(((r.pipeline.step + 0.5) / 6) * 100);

export function AgentRow({ row: r, projectName }: { row: FleetRow; projectName?: string }) {
  const { t } = useShell();
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
  const harness = harnessOf(r.runtime);
  const fresh = useFresh(r.lastReport);
  return (
    <Row href={paths.agent(r.id)} className={fresh ? "sc-agent is-fresh" : "sc-agent"}>
      <StatusDot status={state.status} progress={rowProgress(r)} label={label} />
      <RowId>
        {r.id}
        {/* A phone's second line: the id, then the phase in its tone (THE-899). */}
        <span className="sc-agent-phase" style={{ color: toneColor(state.status) }} aria-hidden>
          {" · "}
          {label}
        </span>
      </RowId>
      <RowText title={r.title} line={rowLine(r) || <PhasePill tone={state.status}>{label}</PhasePill>} />
      {projectName && (
        <RowSide roomy>
          <Tag>
            <ProjectChip slug={r.project} name={projectName} />
          </Tag>
        </RowSide>
      )}
      <RowSide roomy>
        <Steps step={r.pipeline.step} tone={state.status} />
      </RowSide>
      <RowSide>
        <HarnessBadge harness={harness} bare />
      </RowSide>
      <RowTime color={r.silent ? "var(--active)" : undefined}>
        <RelativeTime at={r.lastReport} format="duration" />
        {r.runtimeState && <> · {t.shell.runtimeState[r.runtimeState]}</>}
      </RowTime>
    </Row>
  );
}
