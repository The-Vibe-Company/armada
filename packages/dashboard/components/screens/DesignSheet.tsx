"use client";

// /design: the shared components of the v4 dashboard, each in its states, so
// the screens can be checked against one sheet (THE-866).
import { useState } from "react";
import { AGENT_STATUSES, DENSITIES, HARNESSES, PROJECT_PALETTE } from "@/lib/fleet-view";
import { useNow, useShell } from "../shell/context";
import {
  Avatar,
  Card,
  Dot,
  EmptyState,
  GroupHeader,
  HarnessBadge,
  Kbd,
  Kpi,
  KpiRow,
  PhasePill,
  ProjectChip,
  RelativeTime,
  Row,
  RowList,
  SectionHeader,
  SidePanel,
  StatusDot,
  Steps,
  Tabs,
  Tag,
} from "../ui";

function Specimen({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="ds-specimen">
      <h2 className="ds-name mono">{name}</h2>
      <div className="ds-body">{children}</div>
    </section>
  );
}

export function DesignSheet() {
  const { t, density, setDensity } = useShell();
  const now = useNow();
  const [tab, setTab] = useState<"activity" | "files" | "terminal">("activity");
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return (
    <div className="sc-page">
      <div className="sc-head">
        <h1>{t.shell.design.title}</h1>
        <p className="sc-lead">{t.shell.design.lead}</p>
      </div>

      <Specimen name="StatusDot">
        {AGENT_STATUSES.map((s) => (
          <span key={s} className="ds-item">
            <StatusDot status={s} progress={s === "running" ? 40 : 50} /> {t.shell.groups[s]}
          </span>
        ))}
        <span className="ds-item">
          <StatusDot status="running" progress={10} /> 10%
        </span>
        <span className="ds-item">
          <StatusDot status="running" progress={90} /> 90%
        </span>
      </Specimen>

      <Specimen name="Dot · pulse / live / breathe">
        <span className="ds-item">
          <Dot color="var(--frontier)" size={8} pulse="pulse" /> pulse
        </span>
        <span className="ds-item">
          <Dot color="var(--done)" pulse="live" /> live
        </span>
        <span className="ds-item">
          <Dot color="var(--frontier)" size={6} pulse="breathe" /> breathe
        </span>
      </Specimen>

      <Specimen name="PhasePill">
        <PhasePill tone="waiting">{t.shell.reasons.question}</PhasePill>
        <PhasePill tone="waiting">{t.shell.reasons.approval}</PhasePill>
        <PhasePill tone="error">{t.shell.reasons.ci}</PhasePill>
        <PhasePill tone="error">{t.shell.reasons.conflict}</PhasePill>
        <PhasePill tone="silent">{t.shell.reasons.silent}</PhasePill>
        <PhasePill tone="running" dot>
          {t.shell.phases.implementing}
        </PhasePill>
        <PhasePill tone="done" dot>
          {t.shell.reasons.ready}
        </PhasePill>
        <PhasePill tone="neutral">{t.shell.phases.planning}</PhasePill>
      </Specimen>

      <Specimen name="HarnessBadge">
        {HARNESSES.map((h) => (
          <HarnessBadge key={h} harness={h} />
        ))}
        <HarnessBadge harness="codex" local />
        <HarnessBadge harness="other" />
      </Specimen>

      <Specimen name="ProjectChip · palette">
        <ProjectChip slug="widgets" name="Widgets" />
        <ProjectChip slug="gadgets" name="Gadgets" />
        <ProjectChip slug="armada" name="Armada" />
        {PROJECT_PALETTE.map((c) => (
          <span key={c} className="ui-project-mark" style={{ background: c }} title={c} />
        ))}
      </Specimen>

      <Specimen name="Avatar · Tag · Kbd">
        <Avatar name="Léa Martin" />
        <Avatar name="Hugo Bernard" size={28} />
        <Tag>web</Tag>
        <Tag>api</Tag>
        <Kbd>⌘K</Kbd>
        <Kbd>esc</Kbd>
        <Kbd>j k</Kbd>
      </Specimen>

      <Specimen name="KPI">
        <KpiRow>
          <Kpi label={t.shell.inFlight} value={10} />
          <Kpi label={t.shell.waitingForYou} value={4} tone="waiting" />
          <Kpi label={t.shell.reasons.ci} value={2} tone="error" />
          <Kpi label={t.shell.reasons.silent} value={1} tone="silent" />
          <Kpi label={t.shell.coordinators} value="2/3" />
        </KpiRow>
      </Specimen>

      <Specimen name="SectionHeader · GroupHeader">
        <div className="ds-stack">
          <SectionHeader title={t.shell.waitingForYou} count={4} />
          <SectionHeader title={t.shell.readyToStart} count={3}>
            <span className="faint">armada.toml</span>
          </SectionHeader>
          <GroupHeader icon={<StatusDot status="error" />} label={t.shell.groups.error} count={2} />
        </div>
      </Specimen>

      <Specimen name="Row · RowList (j/k)">
        <div className="ds-stack">
          <RowList>
            {["WID-15", "WID-18", "GAD-5"].map((id, k) => (
              <Row key={id} href={`/agents/${id}`} className="sc-agent">
                <StatusDot status={(["waiting", "done", "error"] as const)[k] ?? "running"} />
                <span className="sc-agent-id mono">{id}</span>
                <span className="sc-agent-title">Row {k + 1}</span>
                <span className="spacer" />
                <Steps step={[2, 5, 4][k] ?? 0} tone={(["waiting", "done", "error"] as const)[k] ?? "running"} />
              </Row>
            ))}
          </RowList>
        </div>
      </Specimen>

      <Specimen name="Card">
        <Card>
          <SectionHeader title="Card" as="h3" />
          <span className="faint">{t.shell.projectsLead}</span>
        </Card>
        <Card href="/projects">
          <SectionHeader title="Card · link" as="h3" />
          <span className="faint">/projects</span>
        </Card>
      </Specimen>

      <Specimen name="SidePanel">
        <div className="ds-panel">
          <SidePanel
            title={t.shell.session}
            rows={[
              { k: t.shell.harness, v: "Conductor Cloud", dot: "var(--h-conductor)" },
              { k: t.shell.profile, v: "opus", mono: true },
              { k: t.shell.session, v: "ws-4f2a/ses-91", mono: true },
              { k: t.shell.lastReportKey, v: <RelativeTime at={ago(42)} />, tone: "silent" },
            ]}
          />
        </div>
      </Specimen>

      <Specimen name="Tabs">
        <Tabs
          label="tabs"
          value={tab}
          onChange={setTab}
          items={[
            { key: "activity", label: "Activité" },
            { key: "files", label: "Fichiers", count: 4 },
            { key: "terminal", label: "Terminal" },
          ]}
        />
        <Tabs
          label={t.shell.density.label}
          value={density}
          onChange={setDensity}
          size="sm"
          items={DENSITIES.map((d) => ({ key: d, label: t.shell.density[d] }))}
        />
      </Specimen>

      <Specimen name="Steps">
        {AGENT_STATUSES.map((s, k) => (
          <Steps key={s} step={k} tone={s} />
        ))}
        <Steps step={3} tone="running" wide />
      </Specimen>

      <Specimen name="RelativeTime">
        <span className="ds-item">
          <RelativeTime at={ago(0)} />
        </span>
        <span className="ds-item">
          <RelativeTime at={ago(12)} />
        </span>
        <span className="ds-item">
          <RelativeTime at={ago(185)} />
        </span>
        <span className="ds-item">
          <RelativeTime at={ago(185)} format="duration" />
        </span>
        <span className="ds-item">
          <RelativeTime at={null} />
        </span>
      </Specimen>

      <Specimen name="EmptyState">
        <div className="ds-stack">
          <EmptyState title={t.shell.noAgents} hint={t.shell.noAgentsHint} />
        </div>
      </Specimen>
    </div>
  );
}
