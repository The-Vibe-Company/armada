// What the shell's live region says (THE-891): from one overview to the next,
// only what matters to someone who cannot see the page change. A new item
// waiting for the viewer (a validation, a worker's question, plan or
// hand-back, a coordinator that stopped), and an agent's phase change. Pure:
// the shell's Announcer keeps the last snapshot, debounces and speaks.
import type { AgentPhase, FleetOverview } from "@armada/core/read";
import { decisionsOf } from "./fleet-view";
import type { Strings } from "./i18n";
import { coordinatorAlerts, pendingValidations } from "./overview-view";

/** What an overview holds that the live region watches. */
export interface Watched {
  /** Each item waiting for the viewer, by a stable key, with what to call it. */
  waiting: Map<string, string>;
  /** Each agent's phase, keyed `project/ticket`. */
  phases: Map<string, { ticket: string; phase: AgentPhase }>;
}

export type Change = { kind: "waiting"; title: string } | { kind: "phase"; ticket: string; phase: AgentPhase };

type Watchable = Pick<FleetOverview, "rows" | "waiting" | "projects"> & Partial<Pick<FleetOverview, "validations">>;

export function watched(o: Watchable): Watched {
  const waiting = new Map<string, string>();
  for (const v of pendingValidations(o)) waiting.set(`validation:${v.id}`, v.title ?? v.what);
  for (const w of decisionsOf(o))
    waiting.set(`${w.kind}:${w.project}:${w.ticket ?? ""}:${w.item ?? ""}`, w.title ?? w.ticket ?? w.project);
  const names = new Map(o.projects.map((p) => [p.slug, p.name]));
  for (const c of coordinatorAlerts(o)) waiting.set(`coordinator:${c.project}`, names.get(c.project) ?? c.project);
  const phases = new Map(o.rows.map((r) => [`${r.project}/${r.id}`, { ticket: r.id, phase: r.phase }]));
  return { waiting, phases };
}

/**
 * What changed from `before` to `after`: items that started waiting, and
 * agents still in flight whose phase moved. An agent that appears or leaves
 * is not a phase change; an item that stops waiting is not news.
 */
export function changes(before: Watched, after: Watched): Change[] {
  const out: Change[] = [];
  for (const [key, title] of after.waiting) if (!before.waiting.has(key)) out.push({ kind: "waiting", title });
  for (const [key, now] of after.phases) {
    const was = before.phases.get(key);
    if (was && was.phase !== now.phase) out.push({ kind: "phase", ticket: now.ticket, phase: now.phase });
  }
  return out;
}

/** One sentence per kind, a count when several arrived together; null when nothing is worth saying. */
export function sentence(t: Strings, list: Change[]): string | null {
  const waiting = list.filter((c) => c.kind === "waiting");
  const phases = list.filter((c) => c.kind === "phase");
  const parts: string[] = [];
  const [first] = waiting;
  if (waiting.length === 1 && first) parts.push(t.a11y.waiting(first.title));
  else if (waiting.length > 1) parts.push(t.a11y.waitingMany(waiting.length));
  const [one] = phases;
  if (phases.length === 1 && one) parts.push(t.a11y.phase(one.ticket, t.shell.phases[one.phase]));
  else if (phases.length > 1) parts.push(t.a11y.phaseMany(phases.length));
  return parts.length ? parts.join(". ") : null;
}
