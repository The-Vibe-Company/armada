"use client";

// One agent in flight as a list row (compact or airy), on the page kit's Row:
// the Agents page's row, which the overview (THE-916) and a project's page
// show. "À valider" when the owner has something to validate on it.
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

export function AgentRow({
  row: r,
  projectName,
  airy = false,
  toValidate = false,
}: {
  row: FleetRow;
  projectName?: string;
  airy?: boolean;
  /** The owner has something to validate on it (lib/coordinator-view.ts). */
  toValidate?: boolean;
}) {
  const { t } = useShell();
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
  const harness = harnessOf(r.runtime);
  const fresh = useFresh(r.lastReport);
  const badge = toValidate && <PhasePill tone="waiting">{t.overview.toValidateBadge}</PhasePill>;
  if (airy)
    return (
      <Row href={paths.agent(r.id)} className={fresh ? "sc-agent is-airy is-fresh" : "sc-agent is-airy"}>
        <StatusDot status={state.status} progress={rowProgress(r)} size={14} label={label} />
        <span className="sc-agent-main">
          <span className="ui-row-title">{r.title}</span>
          <span className="sc-agent-meta">
            {badge}
            <span className="mono">{r.id}</span>
            {projectName && <> · {projectName}</>} · <HarnessBadge harness={harness} />
            {r.profile && <> · {r.profile}</>}
            {r.pr?.files && <> · {t.shell.agent.fileCount(r.pr.files.length)}</>}
          </span>
          <span className="ui-row-line" style={{ color: r.question ? "var(--accent)" : undefined }}>
            {rowLine(r)}
          </span>
        </span>
        <span className="sc-agent-stage">
          <Steps step={r.pipeline.step} tone={state.status} wide />
          <span style={{ color: toneColor(state.status) }}>
            {label} <span className="faint">· </span>
            <span className="faint mono">
              <RelativeTime at={r.since} format="duration" />
            </span>
          </span>
        </span>
        <span className="sc-agent-ago">
          <span style={{ color: r.silent ? "var(--active)" : undefined }}>
            {r.lastReport ? <RelativeTime at={r.lastReport} /> : t.shell.neverReported}
            {r.runtimeState && <> · {t.shell.runtimeState[r.runtimeState]}</>}
          </span>
          <span className="sc-agent-ago-label">{t.shell.lastReport}</span>
        </span>
      </Row>
    );
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
      {badge && <RowSide>{badge}</RowSide>}
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
