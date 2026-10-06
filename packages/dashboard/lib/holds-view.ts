// What stops the fleet shipping, as the overview and a project's page show it
// (THE-1105): each open merge pause, newest first, with its age; and each
// target of a project's `[deploy]` with its last state and how long ago it
// changed. Read from the polled overview (Postgres only); recomputed against
// the ticking clock between polls.
import type { DeployState, HoldKind, ProjectOverview } from "@armada/core/read";

/** A deploy still waiting with no observation for this long says so. */
export const DEPLOY_QUIET_MS = 10 * 60_000;

export interface HoldLine {
  project: string;
  projectName: string;
  id: number;
  kind: HoldKind;
  reason: string;
  ageMs: number;
}

/** The open merge pauses of these projects, newest first. */
export function holdLines(projects: readonly ProjectOverview[], now: number): HoldLine[] {
  return projects
    .flatMap((p) =>
      (p.holds ?? []).map((h) => ({
        project: p.slug,
        projectName: p.name,
        id: h.id,
        kind: h.kind,
        reason: h.reason,
        ageMs: Math.max(0, now - Date.parse(h.openedAt)),
      })),
    )
    .sort((a, b) => a.ageMs - b.ageMs || b.id - a.id);
}

export interface DeployLine {
  target: string;
  /** Null before its first observation. */
  state: DeployState | null;
  sha: string | null;
  /** Since its last observation. */
  ageMs: number | null;
  /** Still waiting with no news for `DEPLOY_QUIET_MS` or more. */
  quiet: boolean;
}

/** A project's deploy targets in its `[deploy]` order; null without any, or when the live data was not read. */
export function deployLines(project: ProjectOverview, now: number): DeployLine[] | null {
  if (!project.deploys?.length) return null;
  return project.deploys.map(({ target, last }) => {
    const ageMs = last ? Math.max(0, now - Date.parse(last.updatedAt)) : null;
    return {
      target,
      state: last?.state ?? null,
      sha: last?.sha ?? null,
      ageMs,
      quiet: last?.state === "waiting" && ageMs !== null && ageMs >= DEPLOY_QUIET_MS,
    };
  });
}
