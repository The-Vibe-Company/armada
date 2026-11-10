import {
  GoldenError,
  type Harness,
  type PromptStatus,
  parseGoldenConfig,
  type Sandbox,
  type SandboxStatus,
} from "@armada/core";
import { projectChat, toolSummary } from "./chat.ts";
import type { ChatEvent } from "./events.ts";
import { isActiveStatus } from "./events.ts";
import { describeFailure } from "./failure.ts";
import { formatDuration, readLifecycle } from "./lifecycle.ts";
import { type OutcomeView, outcomeView, type PreservationView, parseTaskOutcome, preservationView } from "./outcome.ts";
import { sandboxRepositoryDir } from "./repository-context.ts";

/**
 * The fleet board (#743, reworked in #801): what needs a decision, and nothing else by default. A row is a work item
 * (an issue or pull request the launch or the outcome names) or, without one, a sandbox. Live agents that need
 * nothing are summarised in a quiet strip; stopped sandboxes are on the board only while they hold something for the
 * operator. Everything here is pure; the page reads the rows as the signed-in user and the events through the server.
 */

/** A failed sandbox, or a stopped one holding an outcome or preserved work, is read for this long after it ended. */
export const ENDED_KEPT_MS = 24 * 60 * 60 * 1000;

/** Under this much time left, a live sandbox's deadline is highlighted and its unfinished work needs the operator. */
export const EXPIRY_WARNING_SECONDS = 30 * 60;

/** How much of the latest agent message the row shows before "Show more". */
export const PREVIEW_CHARS = 180;

/** The most of a message the page carries; the full conversation is one click away. */
export const MESSAGE_MAX_CHARS = 4000;

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
  /** The latest non-empty agent message, at most {@link MESSAGE_MAX_CHARS}. */
  message: string | null;
  /** The latest turn's prompt id: an acknowledgement holds for this turn, not the next. */
  promptId?: string | null;
  /** The latest prompt as sent, for a one-click resend; null when it is too long to carry or has no text. */
  prompt?: { text: string; conversationId: string | null } | null;
  /** The first prompt: the launch names the work item. */
  launch?: string | null;
  /** When the latest turn started, in epoch milliseconds. */
  startedAt?: number | null;
  /** What a running turn is doing: its latest tool call, in a few words. */
  activity?: string | null;
};

export function summarizeEvents(events: readonly ChatEvent[]): TurnSummary {
  const { items, running } = projectChat(events);
  let status: PromptStatus | null = null;
  let reason: string | null = null;
  let message: string | null = null;
  let promptId: string | null = null;
  let prompt: TurnSummary["prompt"] = null;
  let launch: string | null = null;
  let startedAt: number | null = null;
  let activity: string | null = null;
  for (const item of items) {
    if (item.kind === "user") {
      status = item.status;
      reason = item.reason ?? null;
      promptId = item.promptId ?? null;
      const text = item.text.trim();
      prompt = text && text.length <= RESEND_MAX_CHARS ? { text, conversationId: item.conversationId ?? null } : null;
      launch ??= text ? text.slice(0, MESSAGE_MAX_CHARS) : null;
      startedAt = item.at;
      activity = null;
    } else if (item.kind === "assistant" && item.text.trim()) message = item.text.trim();
    else if (item.kind === "tool") {
      const summary = toolSummary(item.tool.input);
      activity = summary ? `${item.tool.name}: ${summary}` : item.tool.name;
    }
  }
  if (running) {
    status = "running";
    reason = null;
  }
  return {
    status,
    reason,
    message: message === null ? null : message.slice(0, MESSAGE_MAX_CHARS),
    promptId,
    prompt,
    launch,
    startedAt,
    activity: running ? activity : null,
  };
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
export function boardState(
  status: SandboxStatus,
  turn: TurnSummary | null,
  recorded: Recorded = { statusReason: null, lifecycleError: null },
  outcome: OutcomeView | null = null,
): BoardState {
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

function interrupted(reason: string | null): BoardState {
  return { kind: "interrupted", label: "Interrupted", failure: null, interruption: reason };
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

/**
 * Why a row needs the operator, in the order the board lists them. `null` needs nothing: a live agent at work or
 * waiting for its first prompt, or an ended sandbox with nothing left in it.
 */
export type Attention = "ready" | "blocked" | "failed" | "interrupted" | "unconcluded" | "expiring";

export const ATTENTION_ORDER: readonly Attention[] = [
  "ready",
  "blocked",
  "failed",
  "interrupted",
  "unconcluded",
  "expiring",
];

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
 * - failed: a real failure, the latest state of its sandbox ({@link boardState});
 * - interrupted: a turn cut short that the same prompt resumes, on a live machine;
 * - unconcluded: a live agent whose turn finished without an outcome, or a sandbox stopped mid-turn whose unpushed
 *   work was preserved;
 * - expiring: a live agent still at work whose deadline is under {@link EXPIRY_WARNING_SECONDS}.
 */
export function attentionOf(
  state: BoardState,
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

/** The issue or pull request a row is about: one line per work item, not per sandbox. */
export type WorkItem = { key: string; label: string; href: string | null };

const GITHUB_ITEM = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/i;
const REPO_ITEM = /(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)\b/;
const NAMED_ITEM = /\b(?:issue|ticket|pr|pull request)\s*#?(\d+)\b/i;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * The work item a launch prompt names first (a GitHub issue or pull request URL, `owner/repo#12`, or "issue #12" in the
 * sandbox's repository), else the pull request its outcome carries. Issues and pull requests share their numbers on
 * GitHub, so one key names either; a number whose repository is unknown names nothing.
 */
export function workItemOf(
  launch: string | null | undefined,
  outcome: { prUrl?: string | undefined; prNumber?: number | undefined } | null,
  repository: string | null,
): WorkItem | null {
  const item = (repo: string | null, number: string): WorkItem | null => {
    // Without its repository a number is ambiguous: the same #12 in two repositories is two work items.
    const owned = repo && OWNER_REPO.test(repo) ? repo : null;
    if (!owned) return null;
    return {
      key: `${owned.toLowerCase()}#${Number(number)}`,
      label: `${owned}#${Number(number)}`,
      href: `https://github.com/${owned}/issues/${Number(number)}`,
    };
  };
  if (launch) {
    // The first reference in the prompt names the work; a link given later as context does not.
    const url = GITHUB_ITEM.exec(launch);
    const ref = REPO_ITEM.exec(launch);
    const named = NAMED_ITEM.exec(launch);
    const found = [
      url && { at: url.index, repo: url[1] ?? null, n: url[2] },
      ref && { at: ref.index, repo: ref[1] ?? null, n: ref[2] },
      named && { at: named.index, repo: repository, n: named[1] },
    ]
      .filter((match): match is { at: number; repo: string; n: string | undefined } =>
        Boolean(match?.repo && OWNER_REPO.test(match.repo)),
      )
      .sort((a, b) => a.at - b.at)[0];
    if (found?.n) return item(found.repo ?? null, found.n);
  }
  const pr = outcome?.prUrl ? GITHUB_ITEM.exec(outcome.prUrl) : null;
  if (pr?.[1] && pr[2]) return item(pr[1], pr[2]);
  if (outcome?.prNumber) return item(repository, String(outcome.prNumber));
  return null;
}

/** The start of a message, cut at a word near the limit; `truncated` says whether there is more to show. */
export function preview(text: string, max = PREVIEW_CHARS): { text: string; truncated: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, truncated: false };
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true };
}

type GoldenRepo = { name: string; branch: string } | { count: number } | null;

function goldenRepository(config: unknown, repositoryDir: string | null): GoldenRepo {
  let repos: { url: string; branch: string; dir: string }[];
  try {
    repos = parseGoldenConfig(config).repos;
  } catch (error) {
    if (error instanceof GoldenError) return null;
    throw error;
  }
  const repo = repositoryDir ? repos.find((item) => item.dir === repositoryDir) : repos.length === 1 ? repos[0] : null;
  if (repo) return { name: repoName(repo.url), branch: repo.branch };
  return repos.length > 1 ? { count: repos.length } : null;
}

/**
 * The repository a row names: the one the sandbox was pointed at, or the golden's only one, as `owner/repo` and its
 * branch. A multi-repository golden without a repository context names how many it has.
 */
export function repositoryLabel(config: unknown, repositoryDir: string | null): string | null {
  const repo = goldenRepository(config, repositoryDir);
  if (!repo) return null;
  return "name" in repo ? `${repo.name} @ ${repo.branch}` : `${repo.count} repositories`;
}

function repoName(url: string): string {
  const match = /([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? url;
}

/** One row of the board, as the page renders it. Plain data: it crosses into the client components. */
export type FleetRow = {
  id: string;
  createdAt: string;
  state: BoardState;
  expiry: ExpiryView | null;
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
  /** What the row needs from the operator, or null. */
  attention: Attention | null;
  workItem: WorkItem | null;
  /** The latest prompt, offered for a one-click resend of an interrupted turn. */
  resend: { text: string; conversationId: string | null } | null;
  /** For a live agent: since when its latest turn (else the sandbox) runs, in epoch milliseconds, and what it does. */
  since: number;
  activity: string | null;
  /** What an acknowledgement names: this sandbox in this state. A later turn or another state is a new key. */
  ackKey: string;
  /** Older sandboxes of the same work item this row replaces. */
  replaced: number;
  /** The viewer acknowledged this row: it is out of "Needs you" and stays in "All". */
  dismissed: boolean;
};

type SandboxRow = Pick<
  Sandbox,
  "id" | "status" | "harness" | "model" | "created_at" | "owner_id" | "provider_sandbox_id"
> &
  Partial<
    Pick<Sandbox, "status_reason" | "task_outcome" | "preservation_note" | "usage_running_since" | "conversation_ids">
  >;

/** Epoch milliseconds before 2001 are not a real turn start (test fixtures and legacy events count from zero). */
const PLAUSIBLE_MS = 978_307_200_000;

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
  const outcome = parseTaskOutcome(sandbox.task_outcome);
  const repo = golden ? goldenRepository(golden.config, sandboxRepositoryDir(sandbox)) : null;
  const state = boardState(
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
  const started = turn?.startedAt ?? null;
  const runningSince = sandbox.usage_running_since ? Date.parse(sandbox.usage_running_since) : Number.NaN;
  return {
    id: sandbox.id,
    createdAt: sandbox.created_at,
    name: sandbox.provider_sandbox_id ?? sandbox.id,
    status: sandbox.status,
    harness: sandbox.harness,
    model: sandbox.model,
    golden: golden?.name ?? null,
    repository: repo ? ("name" in repo ? `${repo.name} @ ${repo.branch}` : `${repo.count} repositories`) : null,
    mine: sandbox.owner_id === viewerId,
    state,
    expiry,
    message: turn?.message ?? null,
    eventsRead: turn !== null,
    preservation,
    attention,
    workItem: workItemOf(
      turn?.launch,
      outcome?.state === "ready" ? outcome : null,
      repo && "name" in repo ? repo.name : null,
    ),
    // A conversation Armada has not recorded is refused on send: the server's latest one is then the right one.
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
    since:
      started !== null && started > PLAUSIBLE_MS
        ? started
        : Number.isNaN(runningSince)
          ? Date.parse(sandbox.created_at)
          : runningSince,
    activity: turn?.activity ?? null,
    ackKey: ackKey(sandbox.id, [
      attention ?? "",
      turn?.promptId ?? "",
      JSON.stringify(outcome),
      state.failure?.title ?? "",
      sandbox.preservation_note ?? "",
    ]),
    replaced: 0,
    dismissed: false,
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

/**
 * One row per work item: the newest sandbox of an issue or pull request replaces the older ones (a relaunch replaces
 * the run it follows, whatever state that run was left in). Rows without a work item stand alone.
 */
export function groupByWorkItem(rows: readonly FleetRow[]): FleetRow[] {
  const newest = new Map<string, FleetRow>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.workItem) continue;
    const key = row.workItem.key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const known = newest.get(key);
    if (!known || row.createdAt > known.createdAt || (row.createdAt === known.createdAt && row.id > known.id))
      newest.set(key, row);
  }
  return rows.flatMap((row) => {
    if (!row.workItem) return [row];
    return newest.get(row.workItem.key) === row ? [{ ...row, replaced: (counts.get(row.workItem.key) ?? 1) - 1 }] : [];
  });
}

/** Live sandboxes are always on the board; an ended one only while it holds something for the operator. */
export function onBoard(row: Pick<FleetRow, "status" | "attention">): boolean {
  return isActiveStatus(row.status) || row.attention !== null;
}

export type Board = {
  /** What needs the operator and is not acknowledged, in the order of {@link ATTENTION_ORDER}. */
  needs: FleetRow[];
  /** Live agents at work that need nothing, the longest running first. */
  working: FleetRow[];
  /** Every row on the board, acknowledged ones included. */
  all: FleetRow[];
};

/**
 * The board from every row read: kept only while it holds something, grouped by work item, acknowledged rows out of
 * "Needs you". Within a group the nearest deadline comes first, then the newest.
 */
export function buildBoard(rows: readonly FleetRow[], acknowledged: ReadonlySet<string>): Board {
  const all = sortBoard(
    groupByWorkItem(rows.filter(onBoard)).map((row) => ({
      ...row,
      dismissed: row.attention !== null && acknowledged.has(row.ackKey),
    })),
  );
  return {
    needs: all.filter((row) => row.attention !== null && !row.dismissed),
    working: all
      .filter((row) => row.attention === null && row.state.kind === "working")
      .sort((a, b) => a.since - b.since),
    all,
  };
}

function rank(row: FleetRow): number {
  if (row.attention !== null && !row.dismissed) return ATTENTION_ORDER.indexOf(row.attention);
  if (row.state.kind === "working") return ATTENTION_ORDER.length;
  return ATTENTION_ORDER.length + 1;
}

export function sortBoard(rows: readonly FleetRow[]): FleetRow[] {
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.expiry?.urgent ? a.expiry.seconds : Number.POSITIVE_INFINITY) -
        (b.expiry?.urgent ? b.expiry.seconds : Number.POSITIVE_INFINITY) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

export type BoardView = "needs-you" | "all";

/** The view named by the URL: "Needs you" unless it asks for every agent. */
export function parseBoardView(value: string | string[] | undefined): BoardView {
  return (Array.isArray(value) ? value[0] : value) === "all" ? "all" : "needs-you";
}

/** How long a live agent has been at it, from `since` to now. */
export function elapsedText(since: number, now: Date): string {
  return formatDuration(Math.max(0, Math.floor((now.getTime() - since) / 1000)));
}

/** The acknowledgement cookie (#801): per browser, and holding only the signed-in viewer's keys. */
export const ACK_COOKIE = "armada-fleet-ack";

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
