"use client";

// /agents/[ticket] until THE-870 builds it: the session's status, its steps
// and what Armada knows of it today.
import { useParams } from "next/navigation";
import { agentState, HARNESS_NAME, harnessOf } from "@/lib/fleet-view";
import { useFleet, useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import {
  Dot,
  EmptyState,
  HarnessBadge,
  harnessColor,
  ProjectChip,
  RelativeTime,
  SidePanel,
  Steps,
  toneColor,
} from "../ui";
import { rowLine } from "./AgentRow";
import { PlaceholderNote } from "./Placeholder";

export function AgentScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const ticket = decodeURIComponent(String(useParams<{ ticket: string }>().ticket ?? ""));
  const row = overview.rows.find((r) => r.id.toLowerCase() === ticket.toLowerCase());
  if (!row)
    return (
      <div className="sc-page">
        <EmptyState title={t.shell.agentMissing} hint={t.shell.agentMissingHint} />
      </div>
    );
  const state = agentState(row);
  const harness = harnessOf(row.runtime);
  const project = overview.projects.find((p) => p.slug === row.project);
  const color = toneColor(state.status);
  return (
    <div className="sc-page">
      <div className="sc-agent-head">
        <div className="sc-head">
          <span className="sc-agent-meta">
            <span className="mono">{row.id}</span> ·{" "}
            <ProjectChip slug={row.project} name={project?.name ?? row.project} /> · <HarnessBadge harness={harness} />
          </span>
          <h1>{row.title}</h1>
          <span className="sc-agent-status">
            <span style={{ color }} className="sc-agent-state">
              <Dot color={color} size={8} pulse={state.status === "running" ? "pulse" : undefined} />
              {stateLabel(t, state, row.phase)}
            </span>
            <span className="sc-agent-line">{rowLine(row)}</span>
          </span>
        </div>
        <div className="sc-actions">
          <a className="ui-button" href={row.url} target="_blank" rel="noreferrer">
            {t.shell.openLinear}
          </a>
          {row.pr ? (
            <a className="ui-button" href={row.pr.url} target="_blank" rel="noreferrer">
              {t.shell.openPr(row.pr.number)}
            </a>
          ) : (
            <span className="ui-button is-disabled">{t.shell.noPr}</span>
          )}
        </div>
      </div>
      <div className="ui-card sc-steps">
        <Steps step={row.pipeline.step} tone={state.status} wide />
        <div className="sc-step-labels">
          {t.shell.steps.map((s, k) => (
            <span key={s} className={k === row.pipeline.step ? "is-now" : k < row.pipeline.step ? "is-past" : ""}>
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="sc-columns">
        <div className="sc-column">
          <PlaceholderNote />
        </div>
        <aside className="sc-side">
          <SidePanel
            title={t.shell.session}
            rows={[
              { k: t.shell.harness, v: HARNESS_NAME[harness], dot: harnessColor(harness) },
              { k: t.shell.profile, v: row.profile ?? "—", mono: true },
              { k: t.shell.session, v: row.handle ?? "—", mono: true },
              { k: t.shell.phases[row.phase], v: <RelativeTime at={row.since} format="duration" /> },
              {
                k: t.shell.lastReportKey,
                v: row.lastReport ? <RelativeTime at={row.lastReport} /> : t.shell.neverReported,
                tone: row.silent ? "silent" : undefined,
              },
            ]}
          />
          <SidePanel
            title="Code"
            rows={[
              {
                k: t.shell.pr,
                v: row.pr ? `#${row.pr.number}` : "—",
                mono: true,
                dot: row.pr
                  ? row.pr.ci === "success"
                    ? "var(--done)"
                    : row.pr.ci === "failure"
                      ? "var(--critical)"
                      : "var(--active)"
                  : undefined,
              },
            ]}
          />
        </aside>
      </div>
    </div>
  );
}
