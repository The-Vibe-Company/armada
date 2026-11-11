import type { PromptStatus, Sandbox, SandboxStatus } from "@armada/core";
import { projectChat } from "./chat.ts";
import { type ChatEvent, isActiveStatus } from "./events.ts";
import { describeFailure } from "./failure.ts";
import { formatDuration, readLifecycle } from "./lifecycle.ts";
import { type OutcomeView, outcomeView, type PreservationView, parseTaskOutcome, preservationView } from "./outcome.ts";

/** Existing attention and recovery semantics, now shown on the authorized sandbox detail rather than a separate board. */
/** Under this much time left, a live sandbox's deadline is highlighted and its unfinished work needs the operator. */
export const EXPIRY_WARNING_SECONDS = 30 * 60;

/** A prompt longer than this is not carried to the page for a one-click resend: it is resent from its conversation. */
export const RESEND_MAX_CHARS = 16_000;

/** What a one-click "Continue" sends to an agent that finished without reporting an outcome. */
export const CONTINUE_PROMPT =
  "Continue where you stopped. When the work is done or you need a decision, report the outcome (ready to merge or blocked).";

/** What the events say about the agent's work. */
export type TurnSummary = {
  /** The latest turn's status, or `running` while any conversation has a turn in flight. Null before the first. */
  status: PromptStatus | null;
  /** Why the latest turn failed, as the server reported it. */
  reason: string | null;
  /** The latest turn's prompt id: an acknowledgement holds for this turn, not the next. */
  promptId?: string | null;
  /** The latest prompt as sent, for a one-click resend; null when it is too long to carry or has no text. */
  prompt?: { text: string; conversationId: string | null } | null;
};

export function summarizeEvents(events: readonly ChatEvent[]): TurnSummary {
  const { items, running } = projectChat(events);
  let status: PromptStatus | null = null;
  let reason: string | null = null;
  let promptId: string | null = null;
  let prompt: TurnSummary["prompt"] = null;
  for (const item of items) {
    if (item.kind === "user") {
      status = item.status;
      reason = item.reason ?? null;
      promptId = item.promptId ?? null;
      const text = item.text.trim();
      prompt = text && text.length <= RESEND_MAX_CHARS ? { text, conversationId: item.conversationId ?? null } : null;
    }
  }
  if (running) {
    status = "running";
    reason = null;
  }
  return {
    status,
    reason,
    promptId,
    prompt,
  };
}

/**
 * The state column. `kind` orders and colours the row; `label` is what it reads. The structured outcome the agent
 * reported for its latest finished turn (#742) refines that turn into `ready` (to merge) or `blocked`.
 */
export type AttentionStateKind =
  | "failed"
  | "blocked"
  | "ready"
  | "finished"
  | "interrupted"
  | "idle"
  | "working"
  | "stopped";

export type AttentionState = {
  kind: AttentionStateKind;
  label: string;
  /** For a failure: the known explanation's title and hint, or the reason as reported. */
  failure: { title: string; hint: string | null; fix: { href: string; label: string } | null } | null;
  /** For an interruption: what interrupted the turn, as reported. Never shown as an error. */
  interruption?: string | null;
  /** For `ready` and `blocked`: the reported outcome (its pull request and commit, or its reason). */
  outcome?: OutcomeView | null;
};

/**
 * Reasons that say the turn was cut short by something outside the agent's work, and that sending the same prompt
 * again continues it: the box moved to another machine, the provider restarted, the turn was interrupted.
 */
const RECOVERABLE = [
  /moved to a new machine/i,
  /send it again/i,
  /\binterrupted\b/i,
  /\b(?:provider|harness|runtime|machine|box|server) (?:was )?restart(?:ed|ing)?\b/i,
];

export function isRecoverableReason(reason: string | null | undefined): boolean {
  return Boolean(reason && RECOVERABLE.some((pattern) => pattern.test(reason)));
}

/** What is recorded on the sandbox row itself, beside its status. */
export type Recorded = {
  statusReason: string | null;
  lifecycleError: string | null;
};

/**
 * The sandbox's status says whether the machine is up; the latest turn says what the agent is doing on it.
 *
 * A failure is shown as an error only while it is the latest state: a failed turn followed by one that finished is
 * history, not a failure; a reason that only says the turn was cut short (the box moved, a restart, an interrupted
 * launch) reads as an interruption to resend, never as an error. A failed sandbox cannot run another turn, and the
 * server records a stop on it by itself once the machine is gone, so it stays a failure until the viewer acknowledges
 * it or a newer run of the same work item replaces it.
 *
 * A reported outcome (ready to merge, or blocked) stands for the latest finished turn, on a live or a stopped machine:
 * the server clears it when a new turn starts, so a turn in flight or a failed one still wins over it.
 */
export function attentionState(
  status: SandboxStatus,
  turn: TurnSummary | null,
  recorded: Recorded = { statusReason: null, lifecycleError: null },
  outcome: OutcomeView | null = null,
): AttentionState {
  const settled = turn?.status !== "queued" && turn?.status !== "running" && turn?.status !== "failed";
  if (status === "failed") {
    const reason = (turn?.status === "failed" ? turn.reason : null) ?? recorded.statusReason ?? recorded.lifecycleError;
    const state = isRecoverableReason(reason) ? interrupted(reason) : failed(reason, "Sandbox failed");
    // The machine died after the agent reported its outcome: the pull request it names is still there to merge.
    return outcome && turn?.status === "finished" ? { ...state, outcome } : state;
  }
  if (status === "stopping") return { kind: "stopped", label: "Stopping", failure: null };
  if (status === "starting") return { kind: "working", label: "Starting", failure: null };
  if (outcome && settled && status !== "deleted")
    return { kind: outcome.kind, label: outcome.label, failure: null, outcome };
  if (status === "stopped" || status === "deleted") return { kind: "stopped", label: "Stopped", failure: null };
  switch (turn?.status ?? null) {
    case "queued":
      return { kind: "working", label: "Queued", failure: null };
    case "running":
      return { kind: "working", label: "Working", failure: null };
    case "failed":
      return isRecoverableReason(turn?.reason)
        ? interrupted(turn?.reason ?? null)
        : failed(turn?.reason ?? null, "Turn failed");
    case "finished":
      return { kind: "finished", label: "Finished", failure: null };
    case "interrupted":
      return interrupted(null);
    default:
      // No turn read: `running` means the server saw one in flight; `ready` means the agent waits for a prompt.
      return status === "running"
        ? { kind: "working", label: "Working", failure: null }
        : { kind: "idle", label: turn ? "Waiting for a prompt" : "Ready", failure: null };
  }
}

function interrupted(reason: string | null): AttentionState {
  return { kind: "interrupted", label: "Interrupted", failure: null, interruption: reason };
}

function failed(reason: string | null, fallback: string): AttentionState {
  const help = describeFailure(reason);
  return {
    kind: "failed",
    label: "Failed",
    failure: help
      ? { title: help.title, hint: help.hint, fix: help.fix ?? null }
      : { title: reason ?? fallback, hint: null, fix: null },
  };
}

/** The time left before the deadline Armada holds a live sandbox to. */
export type ExpiryView = { text: string; urgent: boolean; seconds: number };

export function expiryView(status: SandboxStatus, expiresAt: string | null, now: Date): ExpiryView | null {
  if (!isActiveStatus(status) || !expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return null;
  const seconds = Math.floor((deadline - now.getTime()) / 1000);
  if (seconds <= 0) return { text: "Past deadline", urgent: true, seconds };
  return { text: `${formatDuration(seconds)} left`, urgent: seconds < EXPIRY_WARNING_SECONDS, seconds };
}

/**
 * Why a row needs the operator, in the order the board lists them. `null` needs nothing: a live agent at work or
 * waiting for its first prompt, or an ended sandbox with nothing left in it.
 */
export type Attention = "ready" | "blocked" | "failed" | "interrupted" | "unconcluded" | "expiring";

export const ATTENTION_TITLES: Record<Attention, string> = {
  ready: "Ready to merge",
  blocked: "Blocked",
  failed: "Failed",
  interrupted: "Interrupted",
  unconcluded: "Finished without an outcome",
  expiring: "Expiring with unfinished work",
};

/**
 * - ready, blocked: the agent reported it (#742), on a live or a stopped machine;
 * - failed: a real failure, the latest state of its sandbox ({@link attentionState});
 * - interrupted: a turn cut short that the same prompt resumes, on a live machine;
 * - unconcluded: a live agent whose turn finished without an outcome, or a sandbox stopped mid-turn whose unpushed
 *   work was preserved;
 * - expiring: a live agent still at work whose deadline is under {@link EXPIRY_WARNING_SECONDS}.
 */
export function attentionOf(
  state: AttentionState,
  status: SandboxStatus,
  turn: TurnSummary | null,
  expiry: ExpiryView | null,
  preservation: PreservationView | null,
): Attention | null {
  switch (state.kind) {
    case "ready":
    case "blocked":
    case "failed":
      return state.kind;
    case "interrupted":
      // An ended sandbox cannot be resent to: it needs the operator only for the work it preserved.
      if (isActiveStatus(status)) return "interrupted";
      return preservation?.kind === "preserved" ? "unconcluded" : null;
    case "finished":
      return "unconcluded";
    case "stopped": {
      // Unread events cannot show the turn concluded: preserved work then still needs a look.
      const midTurn = turn === null || (turn.status !== "finished" && turn.status !== null);
      return preservation?.kind === "preserved" && midTurn ? "unconcluded" : null;
    }
    case "working":
      return expiry?.urgent ? "expiring" : null;
    case "idle":
      return null;
  }
}

/** The label a row's badge reads for what it needs. */
export function attentionLabel(attention: Attention, status: SandboxStatus): string {
  if (attention === "unconcluded") return isActiveStatus(status) ? "No outcome reported" : "Stopped mid-work";
  if (attention === "interrupted") return "Interrupted — resend";
  if (attention === "expiring") return "Expiring soon";
  return ATTENTION_TITLES[attention];
}

export function sandboxAttention(
  sandbox: Pick<Sandbox, "id" | "status"> &
    Partial<
      Pick<
        Sandbox,
        "status_reason" | "task_outcome" | "preservation_note" | "conversation_ids" | "expires_at" | "lifecycle_error"
      >
    >,
  turn: TurnSummary | null,
  now: Date,
) {
  const lifecycle = readLifecycle(sandbox);
  const outcome = parseTaskOutcome(sandbox.task_outcome);
  const state = attentionState(
    sandbox.status,
    turn,
    {
      statusReason: sandbox.status_reason ?? null,
      lifecycleError: lifecycle.lifecycleError,
    },
    outcomeView(outcome),
  );
  const expiry = expiryView(sandbox.status, lifecycle.expiresAt, now);
  const preservation = preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true);
  const attention = attentionOf(state, sandbox.status, turn, expiry, preservation);
  return {
    state,
    expiry,
    attention,
    ackKey: ackKey(sandbox.id, [
      attention ?? "",
      turn?.promptId ?? "",
      JSON.stringify(outcome),
      state.failure?.title ?? "",
      sandbox.preservation_note ?? "",
    ]),
    resend:
      attention === "interrupted" && turn?.prompt
        ? {
            text: turn.prompt.text,
            conversationId:
              turn.prompt.conversationId && sandbox.conversation_ids?.includes(turn.prompt.conversationId)
                ? turn.prompt.conversationId
                : null,
          }
        : null,
  };
}

/** `<sandbox id>.<8 hex>`: the sandbox and a short fingerprint of the state an acknowledgement covers. */
export function ackKey(sandboxId: string, parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of parts.join("\u0000")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${sandboxId}.${hash.toString(16).padStart(8, "0")}`;
}

/** The acknowledgement cookie (#801): per browser, and holding only the signed-in viewer's keys. */
export const ACK_COOKIE = "armada-fleet-ack";

/** Set on the legacy path when sandbox views write preferences, so a later import cannot replace newer choices. */
export const ACK_MIGRATION_COOKIE = "armada-sandbox-attention-migrated";

/** The most acknowledgements the cookie keeps, the newest last: each is 45 bytes, well under a cookie's 4 KB. */
export const ACK_MAX = 60;

const ACK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}$/i;

export function isAckKey(value: unknown): value is string {
  return typeof value === "string" && ACK.test(value);
}

/** The keys the viewer acknowledged; a cookie written for someone else on this browser holds none for them. */
export function readAcks(value: string | undefined, viewerId: string): string[] {
  if (!value) return [];
  const [owner, list = ""] = value.split("|");
  if (owner !== viewerId) return [];
  return list.split(",").filter(isAckKey);
}

/** The cookie with `key` acknowledged (or no longer, with `remove`), the oldest dropped past {@link ACK_MAX}. */
export function writeAcks(value: string | undefined, viewerId: string, key: string, remove = false): string {
  const keys = readAcks(value, viewerId).filter((known) => known !== key);
  if (!remove) keys.push(key);
  return `${viewerId}|${keys.slice(-ACK_MAX).join(",")}`;
}
