// The overview's view rules (THE-867): its headline figures, the decisions
// waiting for the owner (THE-880: with the coordinators that stopped answering)
// and each project's card. Pure: they read the overview the shell polls, and
// never recompute what core decides (health, progress, what waits, since when
// an item waits for the coordinator).
import type { FleetOverview, InboxItem, OwnerValidation, WaitingItem } from "@armada/core/read";
import { type DecisionKind, decisionsOf } from "./fleet-view";
import { mergeAsked } from "./queue-view";

/** A question, a plan or a hand-back: what the owner decides. */
export type Decision = WaitingItem & { kind: DecisionKind };

export { type CoordinatorAlert, coordinatorAlerts, pendingValidations } from "@armada/core/read";

/**
 * The Validations page's two lists (THE-1021): what waits for the owner,
 * oldest first (the page opens on it), then what they decided this week,
 * newest first.
 */
export function splitValidations(list: readonly OwnerValidation[]) {
  const pending = list.filter((v) => !v.decision).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decided = list
    .filter((v) => v.decision)
    .sort((a, b) => (b.decision?.at ?? "").localeCompare(a.decision?.at ?? ""));
  return { pending, decided };
}

/** The decisions an agent's page offers, oldest first: a question to answer, a plan to approve. */
export const decisionCards = (o: Pick<FleetOverview, "waiting">): Decision[] =>
  [...decisionsOf(o)].sort((a, b) => a.since.localeCompare(b.since));

const RECOMMENDED = /\b(recommended\b|recommand)/i;

/** A question's options, the recommended one first; else in the worker's order (the first is its pick). */
export function orderOptions(options: readonly string[]): string[] {
  const pick = options.findIndex((o) => RECOMMENDED.test(o));
  if (pick <= 0) return [...options];
  return [options[pick] as string, ...options.filter((_, k) => k !== pick)];
}

/** At most `max` characters of a text, cut on a word, with an ellipsis. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The pull request a hand-back asks to merge: its row's, else the project's open one for the ticket. */
export function handBackPr(o: Pick<FleetOverview, "rows" | "projects">, w: WaitingItem): number | null {
  if (!w.ticket) return null;
  const row = o.rows.find((r) => r.project === w.project && r.id === w.ticket);
  if (row?.pr) return row.pr.number;
  const project = o.projects.find((p) => p.slug === w.project);
  return project?.pullRequests?.find((pr) => pr.ticket?.id === w.ticket)?.number ?? null;
}

/** A request already waiting for the coordinator on a decision. */
export interface SentRequest {
  body: string;
  author: string | null;
  at: string;
  /** A Merge press the queue took (THE-1103), not a request to the coordinator. */
  queued?: boolean;
}

/**
 * What the owner already asked about a decision, as the server holds it: the
 * answer to a question or plan, amendments to a plan, the merge of a hand-back
 * (queued, or asked of the coordinator).
 */
export function sentRequest(o: Pick<FleetOverview, "projects">, w: WaitingItem, pr: number | null): SentRequest | null {
  if (w.answer) return { body: w.answer.body, author: w.answer.author, at: w.answer.at };
  const project = o.projects.find((p) => p.slug === w.project);
  if (w.kind === "hand-back") {
    const asked = mergeAsked(project, pr);
    return asked && { body: `PR #${pr}`, author: asked.author, at: asked.at, queued: asked.queued };
  }
  const match = (r: InboxItem) =>
    w.kind === "approval" && r.kind === "plan-changes" && w.item !== null && r.request?.question === w.item;
  const r = project?.requests.find(match);
  return r ? { body: r.body, author: r.author, at: r.createdAt } : null;
}
