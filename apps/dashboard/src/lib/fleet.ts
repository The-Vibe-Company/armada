import {
  GoldenError,
  type Harness,
  type PromptStatus,
  parseGoldenConfig,
  type Sandbox,
  type SandboxStatus,
} from "@armada/core";
import { projectChat } from "./chat.ts";
import type { ChatEvent } from "./events.ts";
import { isActiveStatus } from "./events.ts";
import { describeFailure } from "./failure.ts";
import { formatDuration, readLifecycle } from "./lifecycle.ts";
import { type OutcomeView, outcomeView, type PreservationView, parseTaskOutcome, preservationView } from "./outcome.ts";
import { sandboxRepositoryDir } from "./repository-context.ts";

/**
 * The fleet board (#743): one row per sandbox the viewer may open, ordered so that what needs the operator comes
 * first. Everything here is pure; the page reads the rows as the signed-in user and the events through the server.
 */

/** A stopped or failed sandbox stays on the board this long after it ended, then only the Sandboxes list shows it. */
export const ENDED_KEPT_MS = 24 * 60 * 60 * 1000;

/** Under this much time left, a live sandbox's deadline is highlighted and it moves up the board. */
export const EXPIRY_WARNING_SECONDS = 30 * 60;

/** How much of the latest agent message the row shows before "Show more". */
export const PREVIEW_CHARS = 180;

/** The most of a message the page carries; the full conversation is one click away. */
export const MESSAGE_MAX_CHARS = 4000;

/** What the events say about the agent's work: its latest turn and the latest thing it said. */
export type TurnSummary = {
  /** The latest turn's status, or `running` while any conversation has a turn in flight. Null before the first. */
  status: PromptStatus | null;
  /** Why the latest turn failed, as the server reported it. */
  reason: string | null;
  /** The latest non-empty agent message, at most {@link MESSAGE_MAX_CHARS}. */
  message: string | null;
};

export function summarizeEvents(events: readonly ChatEvent[]): TurnSummary {
  const { items, running } = projectChat(events);
  let status: PromptStatus | null = null;
  let reason: string | null = null;
  let message: string | null = null;
  for (const item of items) {
    if (item.kind === "user") {
      status = item.status;
      reason = item.reason ?? null;
    } else if (item.kind === "assistant" && item.text.trim()) message = item.text.trim();
  }
  if (running) {
    status = "running";
    reason = null;
  }
  return { status, reason, message: message === null ? null : message.slice(0, MESSAGE_MAX_CHARS) };
}

/**
 * The state column. `kind` orders and colours the row; `label` is what it reads. The structured outcome the agent
 * reported for its latest finished turn (#742) refines that turn into `ready` (to merge) or `blocked`.
 */
export type BoardStateKind =
  | "failed"
  | "blocked"
  | "ready"
  | "finished"
  | "interrupted"
  | "idle"
  | "working"
  | "stopped";

export type BoardState = {
  kind: BoardStateKind;
  label: string;
  /** For a failure: the known explanation's title and hint, or the reason as reported. */
  failure: { title: string; hint: string | null; fix: { href: string; label: string } | null } | null;
  /** For `ready` and `blocked`: the reported outcome (its pull request and commit, or its reason). */
  outcome?: OutcomeView | null;
};

/**
 * The sandbox's status says whether the machine is up; the latest turn says what the agent is doing on it. A failed
 * machine or turn is failed; a live machine whose turn ended waits for the operator; a stopped one is out of the way.
 * Without the events (the server unreachable) a live machine is shown from its status alone. A failed sandbox is
 * explained by its failed turn, else the reason the server recorded on the sandbox, else its last lifecycle error.
 *
 * A reported outcome (ready to merge, or blocked) stands for the latest finished turn, on a live or a stopped machine:
 * the server clears it when a new turn starts, so a turn in flight or a failed one still wins over it.
 */
export function boardState(
  status: SandboxStatus,
  turn: TurnSummary | null,
  recorded: { statusReason: string | null; lifecycleError: string | null } = {
    statusReason: null,
    lifecycleError: null,
  },
  outcome: OutcomeView | null = null,
): BoardState {
  if (status === "failed")
    return failed(
      (turn?.status === "failed" ? turn.reason : null) ?? recorded.statusReason ?? recorded.lifecycleError,
      "Sandbox failed",
    );
  if (status === "stopping") return { kind: "stopped", label: "Stopping", failure: null };
  if (status === "starting") return { kind: "working", label: "Starting", failure: null };
  const settled = turn?.status !== "queued" && turn?.status !== "running" && turn?.status !== "failed";
  if (outcome && settled && status !== "deleted")
    return { kind: outcome.kind, label: outcome.label, failure: null, outcome };
  if (status === "stopped" || status === "deleted") return { kind: "stopped", label: "Stopped", failure: null };
  switch (turn?.status ?? null) {
    case "queued":
      return { kind: "working", label: "Queued", failure: null };
    case "running":
      return { kind: "working", label: "Working", failure: null };
    case "failed":
      return failed(turn?.reason ?? null, "Turn failed");
    case "finished":
      return { kind: "finished", label: "Finished", failure: null };
    case "interrupted":
      return { kind: "interrupted", label: "Interrupted", failure: null };
    default:
      // No turn read: `running` means the server saw one in flight; `ready` means the agent waits for a prompt.
      return status === "running"
        ? { kind: "working", label: "Working", failure: null }
        : { kind: "idle", label: turn ? "Waiting for a prompt" : "Ready", failure: null };
  }
}

function failed(reason: string | null, fallback: string): BoardState {
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

/** A row as the board orders it. */
export type Rankable = { id: string; createdAt: string; state: BoardState; expiry: ExpiryView | null };

/**
 * What needs the operator first: failures, then blocked agents, then work ready to merge, then agents that finished
 * and wait (finished, interrupted, idle), then sandboxes about to expire, then those still working, and stopped ones
 * last. Within a group the nearest deadline comes first, then the newest sandbox.
 */
export function attentionRank(row: Rankable): number {
  switch (row.state.kind) {
    case "failed":
      return 0;
    case "blocked":
      return 1;
    case "ready":
      return 2;
    case "finished":
    case "interrupted":
    case "idle":
      return 3;
    case "working":
      return row.expiry?.urgent ? 4 : 5;
    case "stopped":
      return 6;
  }
}

/** The board's "Needs me" segment: failed, blocked, ready to merge, or about to expire. */
export function needsOperator(row: Rankable): boolean {
  return (
    row.state.kind === "failed" ||
    row.state.kind === "blocked" ||
    row.state.kind === "ready" ||
    row.expiry?.urgent === true
  );
}

export type BoardView = "all" | "needs-me";

/** The segment named by the URL; anything else is the whole board. */
export function parseBoardView(value: string | string[] | undefined): BoardView {
  return (Array.isArray(value) ? value[0] : value) === "needs-me" ? "needs-me" : "all";
}

export function sortBoard<T extends Rankable>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      attentionRank(a) - attentionRank(b) ||
      (a.expiry?.seconds ?? Number.POSITIVE_INFINITY) - (b.expiry?.seconds ?? Number.POSITIVE_INFINITY) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Whether a sandbox belongs on the board: every live one, and a stopped or failed one for a day after it ended. A
 * failed sandbox records no failure time: its stop, else Armada's last observation of it, else its launch stands in.
 */
export function onBoard(
  row: { status: SandboxStatus; stoppedAt: string | null; lastObservedAt?: string | null; createdAt: string },
  now: Date,
): boolean {
  if (isActiveStatus(row.status)) return true;
  if (row.status !== "stopped" && row.status !== "failed") return false;
  const ended = row.status === "stopped" ? row.stoppedAt : (row.stoppedAt ?? row.lastObservedAt ?? row.createdAt);
  const at = ended ? Date.parse(ended) : Number.NaN;
  return !Number.isNaN(at) && now.getTime() - at < ENDED_KEPT_MS;
}

/** The start of a message, cut at a word near the limit; `truncated` says whether there is more to show. */
export function preview(text: string, max = PREVIEW_CHARS): { text: string; truncated: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, truncated: false };
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true };
}

/**
 * The repository a row names: the one the sandbox was pointed at, or the golden's only one, as `owner/repo` and its
 * branch. A multi-repository golden without a repository context names how many it has.
 */
export function repositoryLabel(config: unknown, repositoryDir: string | null): string | null {
  let repos: { url: string; branch: string; dir: string }[];
  try {
    repos = parseGoldenConfig(config).repos;
  } catch (error) {
    if (error instanceof GoldenError) return null;
    throw error;
  }
  const repo = repositoryDir ? repos.find((item) => item.dir === repositoryDir) : repos.length === 1 ? repos[0] : null;
  if (repo) return `${repoName(repo.url)} @ ${repo.branch}`;
  return repos.length > 1 ? `${repos.length} repositories` : null;
}

function repoName(url: string): string {
  const match = /([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? url;
}

/** One row of the board, as the page renders it. Plain data: it crosses into the client components. */
export type FleetRow = Rankable & {
  name: string;
  status: SandboxStatus;
  harness: Harness;
  model: string | null;
  golden: string | null;
  repository: string | null;
  mine: boolean;
  /** The latest agent message, or null when there is none or the events could not be read. */
  message: string | null;
  /** The events were read: the state and message come from them, not from the status alone. */
  eventsRead: boolean;
  /** A stopped sandbox's work-preservation receipt (#747). */
  preservation: PreservationView | null;
};

type SandboxRow = Pick<
  Sandbox,
  "id" | "status" | "harness" | "model" | "created_at" | "owner_id" | "provider_sandbox_id"
> &
  Partial<Pick<Sandbox, "status_reason" | "task_outcome" | "preservation_note">>;

/**
 * A row from the sandbox, its golden (if still readable) and what its events say (null when they were not read). The
 * board reads only sandboxes the viewer may open, so the recovery command is always theirs to run.
 */
export function fleetRow(
  sandbox: SandboxRow,
  golden: { name: string; config: unknown } | null,
  turn: TurnSummary | null,
  viewerId: string,
  now: Date,
): FleetRow {
  const lifecycle = readLifecycle(sandbox);
  return {
    id: sandbox.id,
    createdAt: sandbox.created_at,
    name: sandbox.provider_sandbox_id ?? sandbox.id,
    status: sandbox.status,
    harness: sandbox.harness,
    model: sandbox.model,
    golden: golden?.name ?? null,
    repository: golden ? repositoryLabel(golden.config, sandboxRepositoryDir(sandbox)) : null,
    mine: sandbox.owner_id === viewerId,
    state: boardState(
      sandbox.status,
      turn,
      { statusReason: sandbox.status_reason ?? null, lifecycleError: lifecycle.lifecycleError },
      outcomeView(parseTaskOutcome(sandbox.task_outcome)),
    ),
    expiry: expiryView(sandbox.status, lifecycle.expiresAt, now),
    message: turn?.message ?? null,
    eventsRead: turn !== null,
    preservation: preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true),
  };
}
