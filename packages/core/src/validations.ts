// What the owner validates (THE-885): a merge the project's rule keeps for
// them (`[policy] merge_approval`, `armada merge --ask-owner`), a piece of
// work a kind of ticket must show first (`[[policy.validation]]`, `armada
// validate`), or a question the coordinator escalates (`armada ask-owner`).
// Each is one item on the dashboard's Validations page, opened from one link
// (`/approve/<id>`). The owner's decision lands in the coordinator's inbox as
// a `decision` item: the coordinator merges, or relays it to the worker.
// Pure: the store keeps them (`FleetStore`), these rules read them.
import type { ChangedFile, CiState } from "./types.ts";

export const VALIDATION_KINDS = ["merge", "validation", "question"] as const;
export type ValidationKind = (typeof VALIDATION_KINDS)[number];

/** The pull request a merge approval holds, as GitHub showed it when the coordinator asked. */
export interface ValidationPr {
  number: number;
  url: string;
  title: string;
  /** The exact head the owner approves: a new head needs a new approval. */
  headSha: string;
  files: ChangedFile[] | null;
  additions: number | null;
  deletions: number | null;
  ci: CiState | null;
  /** The preview deployment of the head (a GitHub deployment, or Vercel's status); null when none. */
  preview: string | null;
}

/**
 * `approved` and `changes` answer a merge or a validation; `answered` a
 * question's choice; `superseded`: a newer submission of the same thing replaced it.
 */
export type ValidationOutcome = "approved" | "changes" | "answered" | "superseded";

export interface ValidationDecision {
  outcome: ValidationOutcome;
  /** The choice picked, for a question or a validation sent with choices. */
  answer: string | null;
  /** The owner's words: the changes to make, or a note with an approval. */
  note: string | null;
  /** Who decided; null for a superseded one. */
  by: string | null;
  at: string;
}

export interface NewValidation {
  project: string;
  ticket: string;
  kind: ValidationKind;
  /** What to check, or the question. */
  what: string;
  /** Why the coordinator asks: its judgement of the project's rule. */
  reason: string | null;
  /** The owner's buttons; null: Approve and Request changes. */
  choices: string[] | null;
  pr: ValidationPr | null;
  /** Attachment ids (THE-886) the owner looks at; none: the ticket's own. */
  attachments: string[];
  /** Who asked: the worker's session or the coordinator. */
  author: string | null;
  at: Date;
}

export interface Validation extends Omit<NewValidation, "at"> {
  id: number;
  createdAt: string;
  decision: ValidationDecision | null;
}

export const VALIDATION_LIMITS = { what: 4000, reason: 1000, choice: 120, choices: 6, note: 4000, attachments: 20 };

/** The page an approval link opens, on the dashboard. */
export const approvalPath = (id: number) => `/approve/${id}`;

/** The approval link the CLI prints and posts on the ticket. */
export const approvalUrl = (appUrl: string | null, id: number) =>
  appUrl ? new URL(approvalPath(id), appUrl).toString() : approvalPath(id);

/** `--choices "a | b"`: each choice trimmed, empty ones and duplicates dropped. */
export function parseChoices(raw: string | null | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const choices = [...new Set(raw.split("|").map((c) => c.replace(/\s+/g, " ").trim()))].filter(Boolean);
  return choices.length ? choices : null;
}

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const short = (sha: string) => sha.slice(0, 12);

/** How the owner decided, in one line for the ticket and the merge record: "approved by Ada at 2026-10-01 14:02 UTC". */
export function decidedLine(d: ValidationDecision): string {
  const who = `${d.by ?? "the owner"} at ${when(d.at)}`;
  if (d.outcome === "approved") return `approved by ${who}`;
  if (d.outcome === "changes") return `changes requested by ${who}`;
  if (d.outcome === "answered") return `answered "${d.answer ?? ""}" by ${who}`;
  return `superseded at ${when(d.at)}`;
}

/** The coordinator's inbox item for an owner's decision: what was decided, and what the coordinator does next. */
export function decisionBody(v: Validation, d: Omit<ValidationDecision, "at">): string {
  const by = d.by ?? "The owner";
  const note = d.note?.trim() ? `\n\n${d.note.trim()}` : "";
  const subject =
    v.kind === "merge" && v.pr
      ? `the merge of PR #${v.pr.number} (${v.ticket}) at ${short(v.pr.headSha)}`
      : v.kind === "question"
        ? `${v.ticket}'s question "${v.what.split("\n")[0]}"`
        : `the validation of ${v.ticket}: ${v.what.split("\n")[0]}`;
  if (d.outcome === "answered")
    return `${by} answered ${subject}: ${d.answer}${note}\nRelay it to the worker, then armada answer <this item> "<what you did>".`;
  if (d.outcome === "changes")
    return `${by} requested changes on ${subject}:${note || " (no detail)"}\nRelay them to the worker, then armada answer <this item> "<what you did>".`;
  const next =
    v.kind === "merge" && v.pr
      ? `Merge it: armada merge ${v.pr.number}`
      : v.kind === "validation"
        ? `Tell the worker; for a design ticket, close it with armada done ${v.ticket}`
        : "Relay it to the worker";
  return `${by} approved ${subject}${d.answer ? ` (${d.answer})` : ""}.${note}\n${next}, then armada answer <this item> "<what you did>".`;
}

/** Where a pull request stands with the owner: what `armada merge` checks before merging. */
export type MergeApproval =
  | { state: "none" }
  | { state: "approved"; validation: Validation; decision: ValidationDecision }
  | { state: "pending" | "changes" | "stale"; validation: Validation };

/**
 * The newest merge approval asked for pull request `pr`. Approved counts only
 * for the head the owner saw, or for a head that is that one with only the
 * base branch merged in (`sameAs`, what `armada merge` proved of the head).
 */
export function mergeApproval(
  validations: readonly Validation[],
  pr: number,
  head: { sha: string; sameAs: string | null },
): MergeApproval {
  const asked = validations
    .filter((v) => v.kind === "merge" && v.pr?.number === pr && v.decision?.outcome !== "superseded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  if (!asked?.pr) return { state: "none" };
  const d = asked.decision;
  if (!d) return { state: "pending", validation: asked };
  if (d.outcome !== "approved") return { state: "changes", validation: asked };
  const approved = asked.pr.headSha;
  if (head.sha !== approved && head.sameAs !== approved) return { state: "stale", validation: asked };
  return { state: "approved", validation: asked, decision: d };
}

/** The newest validation of a ticket the owner decided or still has to: what `armada done` checks. */
export function lastValidation(validations: readonly Validation[], ticket: string): Validation | null {
  return (
    validations
      .filter((v) => v.ticket === ticket && v.kind === "validation" && v.decision?.outcome !== "superseded")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0] ?? null
  );
}
