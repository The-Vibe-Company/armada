"use client";

// What stops the fleet shipping (THE-1105), shared by the overview and a
// project's page: an alert per open merge pause, newest first, and the words
// and color of a deploy target's last state. View rules: lib/holds-view.ts.
import type { DeployState, ProjectOverview } from "@armada/core/read";
import { type DeployLine, holdLines } from "@/lib/holds-view";
import type { Strings } from "@/lib/i18n";
import { Alert } from "../page";
import { useNow, useShell } from "../shell/context";

const DEPLOY_COLOR: Record<DeployState, string> = {
  skipped: "var(--text-3)",
  waiting: "var(--amber)",
  live: "var(--blue)",
  healthy: "var(--green)",
  "deploy-failed": "var(--red)",
  "smoke-failed": "var(--red)",
  timeout: "var(--red)",
};

export const deployColor = (d: DeployLine) => (d.state ? DEPLOY_COLOR[d.state] : "var(--text-3)");

/** "healthy · 5 min ago", "waiting · no news for 12 min", "no deploy yet". */
export function deployText(t: Strings, d: DeployLine): string {
  const w = t.overview.deploys;
  if (!d.state || d.ageMs === null) return w.none;
  return `${w.states[d.state]} · ${d.quiet ? w.quiet(t.duration(d.ageMs)) : t.ago(d.ageMs)}`;
}

/**
 * One alert per open merge pause of these projects, newest first: a deploy or
 * a red main is critical, a pause someone chose is a warning. `named` puts
 * each project's name before its reason (the overview, across projects).
 */
export function HoldAlerts({ projects, named = false }: { projects: readonly ProjectOverview[]; named?: boolean }) {
  const { t } = useShell();
  const now = useNow();
  const p = t.overview.pause;
  return holdLines(projects, now).map((h) => (
    <Alert
      key={`${h.project}/${h.id}`}
      tone={h.kind === "manual" ? "warn" : "critical"}
      title={named ? `${h.projectName}: ${p.title(h.reason)}` : p.title(h.reason)}
    >
      {p.detail(p.kinds[h.kind], h.id)} ·{" "}
      {/* The age ticks every minute: kept out of the alert's live region so the pause is not read again each time. */}
      <span aria-live="off">{p.opened(t.ago(h.ageMs))}</span>
    </Alert>
  ));
}
