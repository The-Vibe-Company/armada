"use client";

// A project as a card (THE-899): its progress as a ring in the project's
// color, then its health, coordinator, agents, pull requests, owner and last
// activity. The overview's projects and the Projects page show it.
import type { FleetOverview, ProjectHealth } from "@armada/core/read";
import { useMemo } from "react";
import { HARNESS_NAME, paths, projectColor } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { projectFacts } from "@/lib/overview-view";
import { coordinatorHarness } from "@/lib/project-view";
import { Card, Ring } from "./page";
import { Avatar, Dot, RelativeTime } from "./ui";

const HEALTH_COLOR: Record<ProjectHealth, string> = {
  blocked: "var(--critical)",
  watch: "var(--active)",
  "on-track": "var(--done)",
};

/** A project's card: its progress ring, health, coordinator, agents, pull requests and last activity. */
export function ProjectCard({ t, overview, slug }: { t: Strings; overview: FleetOverview; slug: string }) {
  const p = overview.projects.find((x) => x.slug === slug);
  const facts = useMemo(() => projectFacts(overview, slug), [overview, slug]);
  if (!p) return null;
  const harness = coordinatorHarness(p.coordinator.harness);
  const coordColor =
    p.coordinator.state === "active"
      ? "var(--done)"
      : p.coordinator.state === "idle"
        ? "var(--active)"
        : "var(--text-3)";
  return (
    <Card href={paths.project(p.slug)} className="sc-project-card">
      <Ring
        value={facts.progress === null ? 0 : facts.progress / 100}
        size={44}
        color={projectColor(p.slug)}
        label={facts.progress === null ? undefined : `${facts.progress}%`}
      />
      <div className="sc-project-main">
        <div className="sc-project-name">
          <span className="ui-card-title">{p.name}</span>
          {p.progress && (
            <span className="mono faint">
              {p.progress.done}/{p.progress.total}
            </span>
          )}
        </div>
        {(p.error || p.reading) && (
          <span className="sc-project-note" style={p.error ? { color: "var(--critical)" } : undefined}>
            {p.error ? t.projectPages.unreadable(p.error) : t.projectPages.reading}
          </span>
        )}
        <dl className="sc-facts">
          <dt>{t.overview.healthKey}</dt>
          <dd>
            {p.health ? <span style={{ color: HEALTH_COLOR[p.health] }}>{t.overview.health[p.health]}</span> : "—"}
          </dd>
          <dt>{t.overview.coordinatorKey}</dt>
          <dd>
            <Dot color={coordColor} size={6} />
            {harness ? HARNESS_NAME[harness] : t.shell.coordinatorUnknown}
            {/* The dot's color in words (THE-891): seen when the coordinator is not at work. */}
            {p.coordinator.state === "active" ? (
              <span className="sr-only"> · {t.a11y.coordinator.active}</span>
            ) : (
              harness && ` · ${t.a11y.coordinator[p.coordinator.state]}`
            )}
          </dd>
          <dt>{t.overview.agentsKey}</dt>
          <dd>{t.overview.agents(facts.inFlight, facts.ready)}</dd>
          <dt>{t.overview.prsKey}</dt>
          <dd>{facts.prs ? t.overview.prs(facts.prs.open, facts.prs.green) : "—"}</dd>
          {p.owner && (
            <>
              <dt>{t.projectPages.owner}</dt>
              <dd>
                <Avatar name={p.owner} size={16} />
                {p.owner}
              </dd>
            </>
          )}
          <dt>{t.overview.activityKey}</dt>
          <dd>
            <RelativeTime at={facts.lastActivity} />
          </dd>
        </dl>
      </div>
    </Card>
  );
}
