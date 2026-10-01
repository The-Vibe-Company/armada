"use client";

// One agent in flight as a list row (compact or airy), shared by the
// placeholders of the Agents and project pages until THE-869 and THE-868 build theirs.
import type { FleetRow } from "@armada/core/read";
import { agentState, harnessOf, paths } from "@/lib/fleet-view";
import { splitQuestion } from "../Actions";
import { useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import { Dot, HarnessBadge, harnessColor, PhasePill, RelativeTime, Row, StatusDot, Steps, Tag, toneColor } from "../ui";

/** What a row says under its title: the open question, else the worker's last status. */
export const rowLine = (r: FleetRow) =>
  r.question ? splitQuestion(r.question.body).text.split("\n")[0] : (r.statusLine?.summary ?? "");

/** How far along the six steps a row is, for its status ring. */
export const rowProgress = (r: FleetRow) => Math.round(((r.pipeline.step + 0.5) / 6) * 100);

export function AgentRow({
  row: r,
  projectName,
  airy = false,
}: {
  row: FleetRow;
  projectName?: string;
  airy?: boolean;
}) {
  const { t } = useShell();
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
  const harness = harnessOf(r.runtime);
  if (airy)
    return (
      <Row href={paths.agent(r.id)} className="sc-agent is-airy">
        <StatusDot status={state.status} progress={rowProgress(r)} size={14} label={label} />
        <span className="sc-agent-main">
          <span className="sc-agent-title">{r.title}</span>
          <span className="sc-agent-meta">
            <span className="mono">{r.id}</span>
            {projectName && <> · {projectName}</>} · <HarnessBadge harness={harness} />
            {r.profile && <> · {r.profile}</>}
          </span>
          <span className="sc-agent-line" style={{ color: r.question ? "var(--accent)" : undefined }}>
            {rowLine(r)}
          </span>
        </span>
        <span className="sc-agent-stage">
          <Steps step={r.pipeline.step} tone={state.status} wide />
          <span style={{ color: toneColor(state.status) }}>
            {label} <span className="faint">· </span>
            <span className="faint">
              <RelativeTime at={r.since} format="duration" />
            </span>
          </span>
        </span>
        <span className="sc-agent-ago">
          <span style={{ color: r.silent ? "var(--active)" : undefined }}>
            {r.lastReport ? <RelativeTime at={r.lastReport} /> : t.shell.neverReported}
          </span>
          <span className="sc-agent-ago-label">{t.shell.lastReport}</span>
        </span>
      </Row>
    );
  return (
    <Row href={paths.agent(r.id)} className="sc-agent">
      <StatusDot status={state.status} progress={rowProgress(r)} label={label} />
      <span className="sc-agent-id mono">{r.id}</span>
      <span className="sc-agent-text">
        <span className="sc-agent-title">{r.title}</span>
        <span className="sc-agent-line">{rowLine(r) || <PhasePill tone={state.status}>{label}</PhasePill>}</span>
      </span>
      {projectName && (
        <span className="sc-roomy">
          <Tag>{projectName}</Tag>
        </span>
      )}
      <span className="sc-roomy">
        <Steps step={r.pipeline.step} tone={state.status} />
      </span>
      <span title={harness}>
        <Dot color={harnessColor(harness)} />
      </span>
      <span className="sc-agent-ago-short" style={{ color: r.silent ? "var(--active)" : undefined }}>
        <RelativeTime at={r.lastReport} format="duration" />
      </span>
    </Row>
  );
}
