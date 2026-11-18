import type { SandboxPullRequest, SandboxStatus, TaskOutcome } from "@armada/core";

/**
 * The structured result of a sandbox's latest finished turn (#742/#745) and the work-preservation receipt of a stop
 * (#747), as the dashboard shows them (#768). Both are written by the server; the agent supplies the outcome's text
 * and link, so everything here is validated again before it reaches a page, and a link only ever leads to GitHub.
 */

const SHA = /^[a-f0-9]{40}$/i;
const READY_KEYS = new Set(["state", "prNumber", "prUrl", "headSha"]);
const BLOCKED_KEYS = new Set(["state", "reason"]);

/**
 * The outcome as the database constraint allows it (lengths in characters, as Postgres counts), or null: a malformed
 * value is never shown from a guess.
 */
export function parseTaskOutcome(value: unknown): TaskOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (row.state === "blocked") {
    if (keys.some((key) => !BLOCKED_KEYS.has(key)) || typeof row.reason !== "string") return null;
    const reason = row.reason.trim();
    return reason && [...reason].length <= 1000 ? { state: "blocked", reason } : null;
  }
  if (row.state !== "ready" || keys.some((key) => !READY_KEYS.has(key))) return null;
  const outcome: TaskOutcome = { state: "ready" };
  if (row.prNumber !== undefined) {
    if (typeof row.prNumber !== "number" || !Number.isSafeInteger(row.prNumber) || row.prNumber < 1) return null;
    outcome.prNumber = row.prNumber;
  }
  if (row.prUrl !== undefined) {
    if (typeof row.prUrl !== "string" || !row.prUrl || [...row.prUrl].length > 2048) return null;
    outcome.prUrl = row.prUrl;
  }
  if (row.headSha !== undefined) {
    if (typeof row.headSha !== "string" || !SHA.test(row.headSha)) return null;
    outcome.headSha = row.headSha;
  }
  return outcome;
}

export type OutcomeView =
  | {
      kind: "ready";
      label: string;
      /** The pull request: its number (or a generic name) and its address when that is a GitHub https URL. */
      pr: { label: string; href: string | null } | null;
      /** The first seven characters of the reported head commit. */
      sha: string | null;
      /** GitHub confirms the reported pull request merged: nothing is left to merge, so it reads "Merged". */
      merged: boolean;
    }
  | { kind: "blocked"; label: string; reason: string };

/**
 * The outcome as shown. A "ready" outcome names a pull request the agent reported; when the sandbox's confirmed pull
 * requests (#2612) say GitHub merged that same pull request, the view reads "Merged" rather than asking to merge it.
 */
export function outcomeView(
  outcome: TaskOutcome | null | undefined,
  pullRequests: readonly SandboxPullRequest[] | null | undefined = null,
): OutcomeView | null {
  if (!outcome) return null;
  if (outcome.state === "blocked") return { kind: "blocked", label: "Blocked", reason: outcome.reason };
  const href = safeHref(outcome.prUrl);
  const label = outcome.prNumber ? `PR #${outcome.prNumber}` : href ? "Pull request" : null;
  const merged = reportedPullRequest(outcome, pullRequests)?.state === "merged";
  return {
    kind: "ready",
    label: merged ? "Merged" : "Ready to merge",
    pr: label ? { label, href } : null,
    sha: outcome.headSha ? outcome.headSha.slice(0, 7).toLowerCase() : null,
    merged,
  };
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/;

/**
 * The confirmed pull request a "ready" outcome names, matched on the repository and number of its GitHub link. A
 * number without a link does not say which repository it belongs to, so it matches nothing: the outcome keeps asking
 * to merge rather than borrowing the state of another repository's pull request. Null as well when the link and the
 * number disagree.
 */
export function reportedPullRequest(
  outcome: TaskOutcome | null | undefined,
  pullRequests: readonly SandboxPullRequest[] | null | undefined,
): SandboxPullRequest | null {
  if (outcome?.state !== "ready" || !outcome.prUrl || !pullRequests?.length) return null;
  const link = PR_URL.exec(outcome.prUrl);
  if (!link?.[1]) return null;
  const number = Number(link[2]);
  if (outcome.prNumber !== undefined && outcome.prNumber !== number) return null;
  const repository = link[1].toLowerCase();
  return pullRequests.find((pr) => pr.number === number && pr.repository.toLowerCase() === repository) ?? null;
}

/**
 * The agent writes the address, so only an https address on github.com becomes a link: a prompt-injected agent cannot
 * label another site "PR #12", and javascript:, data: or relative addresses are never links.
 */
export function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * The outcome a list row or conversation header shows. Failure describes the machine, not the completed work:
 * retain its reported outcome alongside the failure. The server clears outcomes when a new turn starts.
 * Deleted, starting and stopping sandboxes do not show earlier outcomes.
 */
export function settledOutcome(
  status: SandboxStatus,
  outcome: TaskOutcome | null | undefined,
  pullRequests: readonly SandboxPullRequest[] | null | undefined = null,
): OutcomeView | null {
  return status === "deleted" || status === "starting" || status === "stopping"
    ? null
    : outcomeView(outcome, pullRequests);
}

/** The command that retrieves the latest recovery archive; its output is sensitive, so it goes to a private file. */
export function recoveryCommand(sandboxId: string): string {
  return `armada recovery ${sandboxId} > armada-recovery.json`;
}

export type PreservationView =
  | { kind: "preserved"; text: string; command: string | null }
  | { kind: "failed"; text: string; reason: string }
  | { kind: "unknown"; text: string; reason: string }
  | { kind: "other"; text: string };

const PRESERVED = /^unpushed work preserved at work_recovery:[0-9a-f-]+\/[0-9a-f-]+$/i;
const UNKNOWN_PRESERVATION = /^could not check for unpushed work \(([a-z0-9_]+)\)(?:\. .+)?$/;
const NOT_PRESERVED = /^unpushed work could not be preserved \(([a-z0-9_]+)\)(?:\. .+)?$/;

/**
 * The receipt of an ended sandbox's last preservation attempt, or null when there is none to show (no attempt, or the
 * sandbox is not stopped or failed; stopping a failed sandbox preserves its work and keeps it failed). Only a viewer
 * who may open the sandbox (its owner or an admin) can retrieve the archive, so only they are given the command.
 */
export function preservationView(
  note: string | null | undefined,
  status: SandboxStatus,
  sandboxId: string,
  canRecover: boolean,
): PreservationView | null {
  if ((status !== "stopped" && status !== "failed") || !note?.trim()) return null;
  if (PRESERVED.test(note.trim()))
    return {
      kind: "preserved",
      text: "Unpushed work preserved",
      command: canRecover ? recoveryCommand(sandboxId) : null,
    };
  const unknown = UNKNOWN_PRESERVATION.exec(note.trim());
  if (unknown?.[1]) return { kind: "unknown", text: note.trim().replace(/^could/, "Could"), reason: unknown[1] };
  const failed = NOT_PRESERVED.exec(note.trim());
  if (failed?.[1]) return { kind: "failed", text: note.trim().replace(/^unpushed/, "Unpushed"), reason: failed[1] };
  return { kind: "other", text: note.trim() };
}
