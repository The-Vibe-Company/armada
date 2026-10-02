"use client";

// /projects (THE-870, Night watch THE-899): the organization's projects in
// one sentence ("3 projects, 56 of 79 tickets done. 2 are blocked."), then one
// card per project, its progress a ring (components/ProjectCard.tsx).
// Registering a project stays a terminal step: the header's button shows them.
import type { ProjectHealth, ProjectOverview } from "@armada/core/read";
import { useMemo, useState } from "react";
import { filterProjects, hasFilters } from "@/lib/filters";
import { REGISTER_STEPS } from "@/lib/project-view";
import { FilterBar, useListFilters } from "../FilterBar";
import { ProjectCard } from "../ProjectCard";
import {
  Alert,
  Button,
  CardGrid,
  HeaderActions,
  LONG_LIST,
  Notice,
  Page,
  Row,
  RowIcon,
  RowSide,
  RowText,
  Section,
  StatusHeader,
} from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { Avatar, Dot, EmptyState } from "../ui";

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
  const { filters, go } = useListFilters("projects");
  const shown = useMemo(() => filterProjects(overview, filters), [overview, filters]);
  const done = overview.projects.reduce((n, p) => n + (p.progress?.done ?? 0), 0);
  const total = overview.projects.reduce((n, p) => n + (p.progress?.total ?? 0), 0);
  const blocked = overview.projects.filter((p) => p.health === "blocked").length;
  const watch = overview.projects.filter((p) => p.health === "watch").length;
  return (
    <Page
      status={
        overview.projects.length > 0 ? (
          <StatusHeader
            lead={t.status.projects(overview.projects.length, done, total)}
            then={blocked ? t.status.blocked(blocked) : watch ? t.status.watch(watch) : t.status.onTrack}
            line={t.projectPages.lead}
          />
        ) : undefined
      }
      toolbar={overview.projects.length > 0 ? <FilterBar list="projects" /> : undefined}
    >
      <HeaderActions>
        <button type="button" className="ui-button" aria-expanded={register} onClick={() => setRegister(!register)}>
          {t.projectPages.register}
        </button>
      </HeaderActions>
      {register && <RegisterSteps onClose={() => setRegister(false)} />}
      {overview.projects.length === 0 ? (
        <EmptyState title={t.shell.noProjects} hint={t.shell.noProjectsHint} />
      ) : shown.length === 0 && hasFilters(filters) ? (
        <EmptyState title={t.filters.noMatch} hint={t.filters.noMatchHint}>
          <Button
            type="button"
            onClick={() => go({ project: null, harness: null, state: null, profile: null, mine: false, q: "" })}
          >
            {t.filters.clear}
          </Button>
        </EmptyState>
      ) : (
        <Section label={t.allProjects} count={shown.length}>
          <CardGrid thirds long={shown.length > LONG_LIST}>
            {shown.map((p) => (
              <ProjectCard key={p.slug} t={t} overview={overview} slug={p.slug} />
            ))}
          </CardGrid>
        </Section>
      )}
    </Page>
  );
}

/** A project that could not be read, or is read for the first time, as the top line of its page. */
export function ProjectNotice({ project }: { project: ProjectOverview }) {
  const { t } = useShell();
  if (project.error) return <Alert title={t.projectPages.unreadable(project.error)} />;
  if (project.reading) return <Notice>{t.projectPages.reading}</Notice>;
  return null;
}
