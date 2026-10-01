"use client";

// /agents/[ticket] until THE-869 builds it: the session's status, its steps
// and what Armada knows of it today.
import { useParams } from "next/navigation";
import { agentState, HARNESS_NAME, harnessOf } from "@/lib/fleet-view";
import { HeaderActions, Page, Row, RowIcon, RowId, RowSide, RowText, Section } from "../page";
import { useFleet, useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import {
  Dot,
  EmptyState,
  HarnessBadge,
  harnessColor,
  ProjectChip,
  RelativeTime,
  StatusDot,
  Steps,
  toneColor,
} from "../ui";
import { rowLine, rowProgress } from "./AgentRow";

/** A key and its value, as a static row. */
function Fact({ k, children, color }: { k: string; children: React.ReactNode; color?: string }) {
  return (
    <Row>
      <RowIcon />
      <span className="sc-fact-k">{k}</span>
      <span className="sc-fact-v" style={color ? { color } : undefined}>
        {children}
      </span>
    </Row>
  );
}

export function AgentScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const ticket = decodeURIComponent(String(useParams<{ ticket: string }>().ticket ?? ""));
  const row = overview.rows.find((r) => r.id.toLowerCase() === ticket.toLowerCase());
  if (!row)
    return (
      <Page>
        <EmptyState title={t.shell.agentMissing} hint={t.shell.agentMissingHint} />
      </Page>
    );
  const state = agentState(row);
  const label = stateLabel(t, state, row.phase);
  const harness = harnessOf(row.runtime);
  const project = overview.projects.find((p) => p.slug === row.project);
  const ci = row.pr?.ci === "success" ? "var(--done)" : row.pr?.ci === "failure" ? "var(--critical)" : "var(--active)";
  return (
    <Page>
      <HeaderActions>
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
      </HeaderActions>
      <Section
        icon={<StatusDot status={state.status} progress={rowProgress(row)} />}
        label={<span style={{ color: toneColor(state.status) }}>{label}</span>}
        side={
          <span className="mono">
            <RelativeTime at={row.since} format="duration" />
          </span>
        }
      >
        <Row>
          <RowIcon />
          <RowId>{row.id}</RowId>
          <RowText title={row.title} line={rowLine(row)} lineColor={row.question ? "var(--accent)" : undefined} />
          <RowSide roomy>
            <ProjectChip slug={row.project} name={project?.name ?? row.project} />
          </RowSide>
          <RowSide>
            <HarnessBadge harness={harness} />
          </RowSide>
        </Row>
      </Section>
      <Section label={t.shell.stepsHeading} count={`${row.pipeline.step + 1}/${t.shell.steps.length}`}>
        <Row className="sc-steps">
          <RowIcon />
          <span className="sc-steps-body">
            <Steps step={row.pipeline.step} tone={state.status} wide />
            <span className="sc-step-labels">
              {t.shell.steps.map((s, k) => (
                <span key={s} className={k === row.pipeline.step ? "is-now" : k < row.pipeline.step ? "is-past" : ""}>
                  {s}
                </span>
              ))}
            </span>
          </span>
        </Row>
      </Section>
      <Section label={t.shell.session}>
        <Fact k={t.shell.harness}>
          <Dot color={harnessColor(harness)} />
          {HARNESS_NAME[harness]}
        </Fact>
        <Fact k={t.shell.profile}>
          <span className="mono">{row.profile ?? "—"}</span>
        </Fact>
        <Fact k={t.shell.session}>
          <span className="mono">{row.handle ?? "—"}</span>
        </Fact>
        <Fact k={t.shell.phases[row.phase]}>
          <span className="mono">
            <RelativeTime at={row.since} format="duration" />
          </span>
        </Fact>
        <Fact k={t.shell.lastReportKey} color={row.silent ? "var(--active)" : undefined}>
          {row.lastReport ? (
            <span className="mono">
              <RelativeTime at={row.lastReport} />
            </span>
          ) : (
            t.shell.neverReported
          )}
        </Fact>
      </Section>
      <Section label={t.shell.code}>
        <Fact k={t.shell.pr}>
          {row.pr && <Dot color={ci} />}
          <span className="mono">{row.pr ? `#${row.pr.number}` : "—"}</span>
        </Fact>
      </Section>
    </Page>
  );
}
