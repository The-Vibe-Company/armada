import type { SandboxStatus, TaskOutcome } from "@armada/core";

/**
 * The structured result of a sandbox's latest finished turn (#742/#745) and the work-preservation receipt of a stop
 * (#747), as the dashboard shows them (#768). Both are written by the server; the agent supplies the outcome's text
 * and link, so everything here is validated again before it reaches a page and a link is only ever an https URL.
 */

const SHA = /^[a-f0-9]{40}$/i;

/** The outcome as the database constraint allows it, or null: a malformed value is never shown from a guess. */
export function parseTaskOutcome(value: unknown): TaskOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.state === "blocked") {
    return typeof row.reason === "string" && row.reason.trim() ? { state: "blocked", reason: row.reason.trim() } : null;
  }
  if (row.state !== "ready") return null;
  const outcome: TaskOutcome = { state: "ready" };
  if (row.prNumber !== undefined) {
    if (typeof row.prNumber !== "number" || !Number.isSafeInteger(row.prNumber) || row.prNumber < 1) return null;
    outcome.prNumber = row.prNumber;
  }
  if (row.prUrl !== undefined) {
    if (typeof row.prUrl !== "string" || !row.prUrl) return null;
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
      /** The pull request: its number (or a generic name) and its address when that is a safe https URL. */
      pr: { label: string; href: string | null } | null;
      /** The first seven characters of the reported head commit. */
      sha: string | null;
    }
  | { kind: "blocked"; label: string; reason: string };

export function outcomeView(outcome: TaskOutcome | null | undefined): OutcomeView | null {
  if (!outcome) return null;
  if (outcome.state === "blocked") return { kind: "blocked", label: "Blocked", reason: outcome.reason };
  const href = safeHref(outcome.prUrl);
  const label = outcome.prNumber ? `PR #${outcome.prNumber}` : href ? "Pull request" : null;
  return {
    kind: "ready",
    label: "Ready to merge",
    pr: label ? { label, href } : null,
    sha: outcome.headSha ? outcome.headSha.slice(0, 7).toLowerCase() : null,
  };
}

/** Only an absolute https address becomes a link; anything else (javascript:, data:, relative) stays text-free. */
export function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** The command that retrieves the latest recovery archive; its output is sensitive, so it goes to a private file. */
export function recoveryCommand(sandboxId: string): string {
  return `armada recovery ${sandboxId} > armada-recovery.json`;
}

export type PreservationView =
  | { kind: "preserved"; text: string; command: string | null }
  | { kind: "failed"; text: string; reason: string }
  | { kind: "other"; text: string };

const PRESERVED = /^unpushed work preserved at work_recovery:[0-9a-f-]+\/[0-9a-f-]+$/i;
const NOT_PRESERVED = /^unpushed work could not be preserved \(([a-z0-9_]+)\)$/;

/**
 * The receipt of a stopped sandbox's last preservation attempt, or null when there is none to show (no attempt, or
 * the sandbox is not stopped). Only a viewer who may open the sandbox (its owner or an admin) can retrieve the archive,
 * so only they are given the command.
 */
export function preservationView(
  note: string | null | undefined,
  status: SandboxStatus,
  sandboxId: string,
  canRecover: boolean,
): PreservationView | null {
  if (status !== "stopped" || !note?.trim()) return null;
  if (PRESERVED.test(note.trim()))
    return {
      kind: "preserved",
      text: "Unpushed work preserved",
      command: canRecover ? recoveryCommand(sandboxId) : null,
    };
  const failed = NOT_PRESERVED.exec(note.trim());
  if (failed?.[1])
    return { kind: "failed", text: `Unpushed work could not be preserved (${failed[1]})`, reason: failed[1] };
  return { kind: "other", text: note.trim() };
}
