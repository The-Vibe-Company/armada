"use client";

// /projects (THE-870): one row per project of the viewer's organization, as
// the Agents page lists its sessions, with more columns: progress, name and
// root, coordinator, health, agents, pull requests, owner and last activity.
// Registering a project stays a terminal step: the header's button shows them.
import type { FleetRow, ProjectHealth, ProjectOverview } from "@armada/core/read";
import { useState } from "react";
import { HARNESS_NAME, harnessOf, paths } from "@/lib/fleet-view";
import { coordinatorHarness, lastActivity, prCounts, progressPercent, REGISTER_STEPS } from "@/lib/project-view";
import { HeaderActions, Notice, Page, Row, RowIcon, RowSide, RowText, RowTime, Section } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Avatar, Dot, EmptyState, harnessColor, ProjectChip, RelativeTime } from "../ui";

/** A coordinator's state, in its color: "actif · il y a 2 min", "inactif depuis 24 min". */
export function CoordinatorState({ project }: { project: ProjectOverview }) {
  const { t } = useShell();
  const now = useNow();
  const { state, seenAt } = project.coordinator;
  const ms = seenAt ? Math.max(0, now - Date.parse(seenAt)) : 0;
  const color = state === "active" ? "var(--done)" : state === "idle" ? "var(--active)" : "var(--text-3)";
  return (
    <span className="sc-coord" style={{ color }}>
      <span className={`sc-coord-mark is-${state}`} aria-hidden />
      <span className="faint">{t.shell.coordinator}</span>
      {state === "active"
        ? t.shell.coordinatorActive(t.ago(ms))
        : state === "idle"
          ? t.shell.coordinatorIdle(t.duration(ms))
          : t.shell.coordinatorUnknown}
    </span>
  );
}

/** A figure of a row, its label in grey: "en vol 5". */
export function Figure({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <span className="sc-figure">
      {dot && <Dot color={dot} size={6} />}
      <span className="faint">{label}</span> <span className="mono">{value}</span>
    </span>
  );
}

export const projectLine = (p: Pick<ProjectOverview, "repository" | "programRoot">) =>
  `${p.repository}${p.programRoot ? ` · ${p.programRoot.id}` : ""}`;

/** Done out of total as a ring: green for done, empty for the rest. Unknown progress draws an empty ring. */
export function ProgressRing({ percent, size = 14 }: { percent: number | null; size?: number }) {
  return (
    <span
      className="pj-ring"
      aria-hidden
      style={{ width: size, height: size, ["--p" as string]: `${percent ?? 0}%` }}
    />
  );
}

export const healthColor = (health: ProjectHealth | null) =>
  health === "blocked"
    ? "var(--critical)"
    : health === "watch"
      ? "var(--active)"
      : health === "on-track"
        ? "var(--done)"
        : "var(--text-3)";

/** core's health of a project, in its color: "En bonne voie", "À surveiller", "Bloqué". */
export function Health({ health }: { health: ProjectHealth | null }) {
  const { t } = useShell();
  return (
    <span className="pj-health" style={{ color: healthColor(health) }}>
      {health ? t.projectPages.health[health] : t.projectPages.healthUnknown}
    </span>
  );
}

/** Who owns a project: initials and name, or that nobody is recorded. */
export function Owner({ name }: { name: string | null }) {
  const { t } = useShell();
  if (!name) return <span className="faint">{t.projectPages.noOwner}</span>;
  return (
    <span className="pj-owner">
      <Avatar name={name} />
      <span className="pj-owner-name">{name}</span>
    </span>
  );
}

/** The coordinator in a list's column: its harness and whether it is at work. */
function CoordinatorCell({ project }: { project: ProjectOverview }) {
  const { t } = useShell();
  const now = useNow();
  const { state, seenAt, harness } = project.coordinator;
  const h = coordinatorHarness(harness ?? null);
  const color = state === "active" ? "var(--done)" : state === "idle" ? "var(--active)" : "var(--text-3)";
  const ms = seenAt ? Math.max(0, now - Date.parse(seenAt)) : 0;
  return (
    <span className="sc-coord" title={t.shell.coordinator}>
      <span className={`sc-coord-mark is-${state}`} style={{ color }} aria-hidden />
      {h ? HARNESS_NAME[h] : <span className="faint">{t.shell.coordinator}</span>}
      <span style={{ color }}>
        {state === "active"
          ? t.shell.coordinatorActive(t.ago(ms))
          : state === "idle"
            ? t.shell.coordinatorIdle(t.duration(ms))
            : t.projectPages.stateUnknown}
      </span>
    </span>
  );
}

/** One bar per agent in flight, in its harness's color, then their count. */
export function AgentBars({ rows }: { rows: Pick<FleetRow, "id" | "runtime">[] }) {
  const { t } = useShell();
  return (
    <span className="pj-agents" title={t.projectPages.agents(rows.length)}>
      <span className="pj-bars" aria-hidden>
        {rows.slice(0, 8).map((r) => (
          <span key={r.id} className="pj-bar" style={{ background: harnessColor(harnessOf(r.runtime)) }} />
        ))}
      </span>
      <span>{t.projectPages.agents(rows.length)}</span>
    </span>
  );
}

/** The `armada init` steps, each command copyable. */
function RegisterSteps({ onClose }: { onClose: () => void }) {
  const { t } = useShell();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, command: string) =>
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    });
  return (
    <Section
      label={t.projectPages.register}
      side={
        <button type="button" className="ui-button" onClick={onClose}>
          {t.projectPages.close}
        </button>
      }
    >
      <Row>
        <RowIcon />
        <RowText title={<span className="pj-lead">{t.projectPages.registerLead}</span>} />
      </Row>
      {REGISTER_STEPS.map((s, k) => (
        <Row key={s.key}>
          <RowIcon>
            <span className="mono faint">{k + 1}</span>
          </RowIcon>
          <RowText title={t.projectPages.registerSteps[s.key]} line={<code className="mono">{s.command}</code>} />
          <RowSide>
            <button type="button" className="ui-button" onClick={() => copy(s.key, s.command)}>
              {copied === s.key ? t.projectPages.copied : t.projectPages.copy}
            </button>
          </RowSide>
        </Row>
      ))}
    </Section>
  );
}

export function ProjectsScreen() {
  const { t } = useShell();
  const { overview } = useFleet();
  const [register, setRegister] = useState(false);
  return (
    <Page>
      <HeaderActions>
        <button type="button" className="ui-button" aria-expanded={register} onClick={() => setRegister(!register)}>
          {t.projectPages.register}
        </button>
      </HeaderActions>
      {register && <RegisterSteps onClose={() => setRegister(false)} />}
      {overview.projects.length === 0 ? (
        <EmptyState title={t.shell.noProjects} hint={t.shell.noProjectsHint} />
      ) : (
        <Section
          label={t.allProjects}
          count={overview.projects.length}
          side={<span className="pj-lead">{t.projectPages.lead}</span>}
        >
          {overview.projects.map((p) => (
            <ProjectRow key={p.slug} project={p} rows={overview.rows.filter((r) => r.project === p.slug)} />
          ))}
        </Section>
      )}
    </Page>
  );
}

function ProjectRow({ project: p, rows }: { project: ProjectOverview; rows: FleetRow[] }) {
  const { t } = useShell();
  const percent = progressPercent(p.progress);
  const prs = prCounts(p.pullRequests);
  const activity = lastActivity(p, rows);
  const line = `${projectLine(p)}${p.progress ? ` · ${t.projectPages.tickets(p.progress.done, p.progress.total)}` : ""}`;
  return (
    <Row href={paths.project(p.slug)} className="pj-row">
      <RowIcon>
        <ProgressRing percent={percent} />
      </RowIcon>
      <span className="pj-percent">{percent === null ? "—" : `${percent} %`}</span>
      <RowText
        title={<ProjectChip slug={p.slug} name={p.name} />}
        line={
          p.error ? (
            <span style={{ color: "var(--critical)" }}>{t.projectPages.unreadable(p.error)}</span>
          ) : p.reading ? (
            t.projectPages.reading
          ) : (
            <span className="mono">{line}</span>
          )
        }
      />
      <RowSide roomy width={230}>
        <CoordinatorCell project={p} />
      </RowSide>
      <RowSide width={104}>
        <Health health={p.health} />
      </RowSide>
      <RowSide width={110}>
        <AgentBars rows={rows} />
      </RowSide>
      <RowSide roomy width={130}>
        <span>{prs ? t.projectPages.prs(prs.open, prs.green) : t.projectPages.prsUnknown}</span>
      </RowSide>
      <RowSide roomy width={150}>
        <Owner name={p.owner} />
      </RowSide>
      <RowTime>
        <span title={t.projectPages.lastActivity}>
          <RelativeTime at={activity} format="duration" />
        </span>
      </RowTime>
    </Row>
  );
}

/** A project that could not be read, or is read for the first time, as the top line of its page. */
export function ProjectNotice({ project }: { project: ProjectOverview }) {
  const { t } = useShell();
  if (project.error) return <Notice tone="critical">{t.projectPages.unreadable(project.error)}</Notice>;
  if (project.reading) return <Notice>{t.projectPages.reading}</Notice>;
  return null;
}
