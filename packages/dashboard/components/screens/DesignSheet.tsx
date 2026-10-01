"use client";

// /design: the reference every page is checked against (THE-876). First the
// page anatomy, the page kit of components/page.tsx put together as the
// Agents page uses it, with when to use each part; then every shared
// component in its states.
import type { ReactNode } from "react";
import { AGENT_STATUSES, HARNESS_NAME, HARNESSES, PROJECT_PALETTE } from "@/lib/fleet-view";
import {
  Card,
  CardGrid,
  CardHead,
  CardMeta,
  CardTitle,
  DensityToggle,
  Notice,
  Page,
  PageHeader,
  Row,
  RowIcon,
  RowId,
  RowSide,
  RowText,
  RowTime,
  Section,
  SectionBody,
  Toolbar,
} from "../page";
import { useNow, useShell } from "../shell/context";
import {
  Avatar,
  Dot,
  EmptyState,
  HarnessBadge,
  harnessColor,
  Kbd,
  PhasePill,
  ProjectChip,
  RelativeTime,
  StatusDot,
  Steps,
  Tabs,
  Tag,
} from "../ui";

/** One component in its states. */
function Specimen({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Section label={<span className="mono">{name}</span>}>
      <SectionBody>
        <div className="ds-items">{children}</div>
      </SectionBody>
    </Section>
  );
}

const SAMPLE = [
  { id: "WID-15", title: "Sign in with a magic link", line: "How long should a sign-in link stay valid?", step: 1 },
  { id: "GAD-3", title: "Import products from a spreadsheet", line: "Plan posted: parse, validate, import", step: 1 },
] as const;

export function DesignSheet() {
  const { t } = useShell();
  const now = useNow();
  const d = t.shell.design;
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return (
    <Page>
      <Section label={d.anatomy}>
        <SectionBody>
          <p className="ds-use">{d.lead}</p>
          <div className="ds-frame" title={d.sample}>
            <PageHeader
              sample
              title={
                <span className="sh-crumb">
                  <span aria-current="page">{t.shell.nav.agents}</span>
                </span>
              }
              hints={
                <>
                  <Kbd>j k</Kbd>
                  {t.shell.navigate} <Kbd>↵</Kbd>
                  {t.shell.open}
                </>
              }
            />
            <Toolbar end={<DensityToggle />}>
              <Tabs
                label={t.shell.harnessHeading}
                value="all"
                items={[
                  { key: "all", label: t.shell.all, count: 10, dot: "var(--text-3)" },
                  ...HARNESSES.map((h, k) => ({
                    key: h,
                    label: HARNESS_NAME[h],
                    count: [5, 3, 2][k],
                    dot: harnessColor(h),
                  })),
                ]}
              />
            </Toolbar>
            <Section icon={<StatusDot status="waiting" />} label={t.shell.groups.waiting} count={SAMPLE.length}>
              {SAMPLE.map((r, k) => (
                <Row key={r.id} href={`/agents/${r.id}`}>
                  <StatusDot status="waiting" />
                  <RowId>{r.id}</RowId>
                  <RowText title={r.title} line={r.line} />
                  <RowSide roomy>
                    <Tag>{k ? "Gadgets" : "Widgets"}</Tag>
                  </RowSide>
                  <RowSide roomy>
                    <Steps step={r.step} tone="waiting" />
                  </RowSide>
                  <RowTime>
                    <RelativeTime at={ago(12 + k * 6)} format="duration" />
                  </RowTime>
                </Row>
              ))}
              <Row>
                <RowIcon>
                  <Dot color="var(--text-4)" />
                </RowIcon>
                <RowId>WID-20</RowId>
                <RowText title="Let users change their email address" line="static row: no href" />
                <RowSide>
                  <Tag>opus</Tag>
                </RowSide>
              </Row>
            </Section>
            <Section label={t.shell.waitingForYou} count={2}>
              <CardGrid>
                {SAMPLE.map((r) => (
                  <Card key={r.id}>
                    <CardHead
                      icon={<Dot color="var(--accent)" />}
                      label={t.kinds.question}
                      color="var(--accent)"
                      side="12 min"
                    />
                    <CardTitle>{r.title}</CardTitle>
                    <CardMeta>
                      <Tag>Widgets</Tag>
                      <span className="mono">{r.id}</span>
                    </CardMeta>
                  </Card>
                ))}
              </CardGrid>
            </Section>
          </div>
          {(Object.keys(d.uses) as (keyof typeof d.uses)[]).map((k) => (
            <p key={k} className="ds-use">
              <b>{k}</b> {d.uses[k]}
            </p>
          ))}
        </SectionBody>
      </Section>

      <Specimen name="Notice">
        <div className="ds-frame">
          <Notice tone="critical">{t.projectError("Gadgets")} GitHub answered 502.</Notice>
          <Notice tone="warn">{t.unreachableBanner("timeout")}</Notice>
          <Notice>{t.readingProject("Widgets")}</Notice>
        </div>
      </Specimen>

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

      <Specimen name="Tabs · DensityToggle">
        <Tabs
          label="tabs"
          value="activity"
          items={[
            { key: "activity", label: "Activité" },
            { key: "files", label: "Fichiers", count: 4 },
            { key: "terminal", label: "Terminal" },
          ]}
        />
        <DensityToggle />
      </Specimen>

      <Specimen name="Steps">
        {AGENT_STATUSES.map((s, k) => (
          <Steps key={s} step={k} tone={s} />
        ))}
        <span className="ds-item" style={{ flex: 1 }}>
          <Steps step={3} tone="running" wide />
        </span>
      </Specimen>

      <Specimen name="RelativeTime">
        {[0, 12, 185].map((m) => (
          <span key={m} className="ds-item mono">
            <RelativeTime at={ago(m)} />
          </span>
        ))}
        <span className="ds-item mono">
          <RelativeTime at={ago(185)} format="duration" />
        </span>
        <span className="ds-item mono">
          <RelativeTime at={null} />
        </span>
      </Specimen>

      <Section label={<span className="mono">EmptyState</span>}>
        <EmptyState title={t.shell.noAgents} hint={t.shell.noAgentsHint} />
      </Section>
    </Page>
  );
}
