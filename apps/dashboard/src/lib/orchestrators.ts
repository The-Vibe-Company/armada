import {
  type AgentEvent,
  HARNESSES,
  type Harness,
  isSandboxProvider,
  LaunchError,
  ORCHESTRATOR_CONTRACT_VERSION,
  ORCHESTRATOR_DEFAULTS,
  type Orchestrator,
  type OrchestratorContinuity,
  type OrchestratorCreate,
  type OrchestratorDelegation,
  type OrchestratorDetail,
  type OrchestratorOperation,
  type OrchestratorState,
  type OrchestratorWaitLease,
  resolveModelChoice,
} from "@armada/core";
import { parseEventPage } from "./events.ts";

/**
 * The dashboard's reading of the orchestrator v1 wire contract (`@armada/core` `orchestrator.ts`, #647). Everything
 * here is pure: it parses what the Armada server answers, never trusting its shape, and says what the person can do.
 * The server owns every decision (fences, limits, continuity, authority); this only avoids offering what it would refuse.
 */

/** An answer in another contract version: refused explicitly, never read as if it were v1. */
export class OrchestratorContractError extends Error {
  override readonly name = "OrchestratorContractError";
}

const STATES: readonly OrchestratorState[] = ["creating", "ready", "stopping", "stopped", "resuming", "blocked"];
const CONTINUITIES: readonly OrchestratorContinuity[] = ["not_started", "native", "unverified", "lost"];
const OPERATION_KINDS: readonly OrchestratorOperation["kind"][] = ["create", "message", "steer", "stop", "resume"];
const OPERATION_STATES: readonly OrchestratorOperation["state"][] = ["pending", "succeeded", "failed", "uncertain"];
const WAIT_KINDS: readonly OrchestratorWaitLease["kind"][] = ["ci", "child", "external", "task"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const strOrNull = (value: unknown): value is string | null => value === null || str(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const oneOf = <T>(values: readonly T[], value: unknown): value is T => values.includes(value as T);

function checkVersion(value: Record<string, unknown>): void {
  if (value.version !== ORCHESTRATOR_CONTRACT_VERSION)
    throw new OrchestratorContractError(
      `The Armada server answered orchestrator contract version ${String(value.version)}; this dashboard reads version ${ORCHESTRATOR_CONTRACT_VERSION}. Reload the page.`,
    );
}

function parseConfiguration(value: unknown): OrchestratorCreate | null {
  if (!isRecord(value)) return null;
  const {
    orgId,
    name,
    goldenId,
    provider,
    harness,
    repo,
    model,
    reasoningEffort,
    modelAccountId,
    idleSeconds,
    maxActiveChildren,
  } = value;
  if (!str(orgId) || !str(name) || !str(goldenId) || !str(model) || !str(modelAccountId)) return null;
  if (!isSandboxProvider(provider) || !oneOf(HARNESSES, harness)) return null;
  if (repo !== undefined && !str(repo)) return null;
  if (reasoningEffort !== undefined && !str(reasoningEffort)) return null;
  // Fields the contract does not define (such as the withdrawn daily start quota) are ignored, never shown.
  for (const limit of [idleSeconds, maxActiveChildren]) if (limit !== undefined && !count(limit)) return null;
  return {
    version: ORCHESTRATOR_CONTRACT_VERSION,
    orgId,
    name,
    goldenId,
    provider,
    harness,
    model,
    modelAccountId,
    ...(repo === undefined ? {} : { repo }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(idleSeconds === undefined ? {} : { idleSeconds: idleSeconds as number }),
    ...(maxActiveChildren === undefined ? {} : { maxActiveChildren: maxActiveChildren as number }),
  };
}

/** One orchestrator, or null when the answer does not hold one. A different contract version throws. */
export function parseOrchestrator(value: unknown): Orchestrator | null {
  if (!isRecord(value)) return null;
  checkVersion(value);
  const configuration = parseConfiguration(value.configuration);
  if (
    !configuration ||
    !str(value.id) ||
    !str(value.ownerId) ||
    !oneOf(STATES, value.state) ||
    !count(value.revision) ||
    !strOrNull(value.sandboxId) ||
    !strOrNull(value.conversationId) ||
    !oneOf(CONTINUITIES, value.continuity) ||
    !str(value.createdAt) ||
    !str(value.updatedAt) ||
    !str(value.lastActivityAt) ||
    !strOrNull(value.idleDeadline) ||
    typeof value.skillRevision !== "string" ||
    !strOrNull(value.blockedReason)
  )
    return null;
  return {
    version: ORCHESTRATOR_CONTRACT_VERSION,
    id: value.id,
    ownerId: value.ownerId,
    configuration,
    state: value.state,
    revision: value.revision,
    sandboxId: value.sandboxId,
    conversationId: value.conversationId,
    continuity: value.continuity,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastActivityAt: value.lastActivityAt,
    idleDeadline: value.idleDeadline,
    skillRevision: value.skillRevision,
    blockedReason: value.blockedReason,
  };
}

export function parseOperation(value: unknown): OrchestratorOperation | null {
  if (!isRecord(value)) return null;
  checkVersion(value);
  if (
    !str(value.id) ||
    !str(value.orchestratorId) ||
    !oneOf(OPERATION_KINDS, value.kind) ||
    !oneOf(OPERATION_STATES, value.state) ||
    !count(value.revision) ||
    !strOrNull(value.errorCode)
  )
    return null;
  return {
    version: ORCHESTRATOR_CONTRACT_VERSION,
    id: value.id,
    orchestratorId: value.orchestratorId,
    kind: value.kind,
    state: value.state,
    revision: value.revision,
    errorCode: value.errorCode,
  };
}

function parseWait(value: unknown): OrchestratorWaitLease | null {
  if (!isRecord(value)) return null;
  const { id, orchestratorId, kind, reference, reason, expiresAt, deadline } = value;
  if (!str(id) || !str(orchestratorId) || !oneOf(WAIT_KINDS, kind) || !str(reference)) return null;
  if (typeof reason !== "string" || !str(expiresAt) || !str(deadline)) return null;
  return { id, orchestratorId, kind, reference, reason, expiresAt, deadline };
}

/** The grant's metadata only: the contract carries no token, and nothing here would show one. */
function parseDelegation(value: unknown): OrchestratorDelegation | null {
  if (!isRecord(value)) return null;
  const { id, orchestratorId, ownerId, orgId, scopes, expiresAt, revokedAt, childPolicy } = value;
  if (!str(id) || !str(orchestratorId) || !str(ownerId) || !str(orgId) || !str(expiresAt)) return null;
  if (!strOrNull(revokedAt) || childPolicy !== "owned_children" || !Array.isArray(scopes)) return null;
  const known = ["worker:launch", "worker:read", "worker:message", "worker:stop"] as const;
  return {
    id,
    orchestratorId,
    ownerId,
    orgId,
    scopes: scopes.filter((scope): scope is (typeof known)[number] => oneOf(known, scope)),
    expiresAt,
    revokedAt,
    childPolicy,
  };
}

export type OrchestratorListView = { items: Orchestrator[]; cursor: string | null; unreadable: number };

/** `GET /orchestrators`: the viewer's own orchestrators of `orgId`. A row of another org is dropped, never shown. */
export function parseOrchestratorList(value: unknown, orgId: string): OrchestratorListView {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new OrchestratorContractError("The Armada server sent no orchestrator list.");
  checkVersion(value);
  const items: Orchestrator[] = [];
  let unreadable = 0;
  for (const raw of value.items) {
    const item = parseOrchestrator(raw);
    if (item && item.configuration.orgId === orgId) items.push(item);
    else if (!item) unreadable += 1;
  }
  return { items, cursor: str(value.cursor) ? value.cursor : null, unreadable };
}

/** `GET /orchestrators/:id`. Operations, waits and children of another orchestrator are dropped. */
export function parseOrchestratorDetail(value: unknown, id: string): OrchestratorDetail {
  if (!isRecord(value)) throw new OrchestratorContractError("The Armada server sent no orchestrator.");
  checkVersion(value);
  const orchestrator = parseOrchestrator(value.orchestrator);
  if (!orchestrator || orchestrator.id !== id)
    throw new OrchestratorContractError("The Armada server sent an unexpected orchestrator.");
  const operations = (Array.isArray(value.operations) ? value.operations : [])
    .map(parseOperation)
    .filter((operation): operation is OrchestratorOperation => operation?.orchestratorId === id);
  const waits = (Array.isArray(value.waits) ? value.waits : [])
    .map(parseWait)
    .filter((wait): wait is OrchestratorWaitLease => wait?.orchestratorId === id);
  const delegation = parseDelegation(value.delegation);
  const children = Array.isArray(value.childSandboxIds) ? value.childSandboxIds.filter(str) : [];
  return {
    version: ORCHESTRATOR_CONTRACT_VERSION,
    orchestrator,
    operations,
    waits,
    delegation: delegation?.orchestratorId === id ? delegation : null,
    childSandboxIds: [...new Set(children)],
  };
}

/**
 * An event as the chat reads it. Kinds this dashboard does not know are kept (as `unknown`, with their name) for the
 * technical view, as the contract asks of newer servers' events: they are never silently dropped.
 */
export type OrchestratorFeedEvent = { id: string; at: string; revision: number } & (
  | { kind: "agent"; event: AgentEvent }
  | { kind: "state"; state: OrchestratorState; continuity: OrchestratorContinuity }
  | { kind: "operation"; operation: OrchestratorOperation }
  | { kind: "wait"; lease: OrchestratorWaitLease; status: "active" | "released" | "expired" }
  | { kind: "child"; sandboxId: string; operationId: string }
  | { kind: "unknown"; type: string }
);

export type OrchestratorFeedPage = { events: OrchestratorFeedEvent[]; cursor: string | null; hasMore: boolean };

/** `GET /orchestrators/:id/events`. Events of another orchestrator are dropped; malformed ones too. */
export function parseOrchestratorEventPage(value: unknown, id: string): OrchestratorFeedPage {
  if (!isRecord(value) || !Array.isArray(value.events))
    throw new OrchestratorContractError("The Armada server sent no event page.");
  checkVersion(value);
  const events = value.events.flatMap((raw): OrchestratorFeedEvent[] => {
    if (!isRecord(raw) || !str(raw.id) || raw.orchestratorId !== id || !str(raw.at) || !count(raw.revision)) return [];
    const base = { id: raw.id, at: raw.at, revision: raw.revision };
    switch (raw.kind) {
      case "agent": {
        const [event] = parseEventPage({ events: [raw.event] }).events;
        return event ? [{ ...base, kind: "agent", event }] : [];
      }
      case "state":
        return oneOf(STATES, raw.state) && oneOf(CONTINUITIES, raw.continuity)
          ? [{ ...base, kind: "state", state: raw.state, continuity: raw.continuity }]
          : [];
      case "operation": {
        const operation = parseOperation(raw.operation);
        return operation?.orchestratorId === id ? [{ ...base, kind: "operation", operation }] : [];
      }
      case "wait": {
        const lease = parseWait(raw.lease);
        return lease?.orchestratorId === id && oneOf(["active", "released", "expired"] as const, raw.status)
          ? [{ ...base, kind: "wait", lease, status: raw.status }]
          : [];
      }
      case "child":
        return str(raw.sandboxId) && str(raw.operationId)
          ? [{ ...base, kind: "child", sandboxId: raw.sandboxId, operationId: raw.operationId }]
          : [];
      default:
        return [{ ...base, kind: "unknown", type: typeof raw.kind === "string" ? raw.kind.slice(0, 60) : "event" }];
    }
  });
  return { events, cursor: str(value.cursor) ? value.cursor : null, hasMore: value.hasMore === true };
}

/** Adds a page to the events shown, in first-arrival order; an event read again keeps its place. */
export function mergeFeed(
  shown: readonly OrchestratorFeedEvent[],
  incoming: readonly OrchestratorFeedEvent[],
): OrchestratorFeedEvent[] {
  const index = new Map(shown.map((event, position) => [event.id, position]));
  const merged = [...shown];
  for (const event of incoming) {
    const position = index.get(event.id);
    if (position === undefined) {
      index.set(event.id, merged.length);
      merged.push(event);
    } else merged[position] = event;
  }
  return merged;
}

/** The agent's own events, for the chat projection the sandbox page uses. */
export function agentEventsOf(events: readonly OrchestratorFeedEvent[]): AgentEvent[] {
  return events.flatMap((event) => (event.kind === "agent" ? [event.event] : []));
}

/** Child sandboxes, from the detail and from the events that recorded them, oldest first and once each. */
export function childrenOf(detail: OrchestratorDetail | null, events: readonly OrchestratorFeedEvent[]): string[] {
  const ids = [...(detail?.childSandboxIds ?? [])];
  for (const event of events) if (event.kind === "child" && !ids.includes(event.sandboxId)) ids.push(event.sandboxId);
  return ids;
}

/** Waits the agent registered and the server still holds, soonest expiry first. */
export function activeWaits(detail: OrchestratorDetail | null): OrchestratorWaitLease[] {
  return [...(detail?.waits ?? [])].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

/** Operations that failed or whose outcome the server is still reconciling, newest first. */
export function troubledOperations(detail: OrchestratorDetail | null): OrchestratorOperation[] {
  return [...(detail?.operations ?? [])]
    .filter((operation) => operation.state === "failed" || operation.state === "uncertain")
    .sort((a, b) => b.revision - a.revision);
}

export const STATE_LABELS: Record<OrchestratorState, string> = {
  creating: "Starting",
  ready: "Ready",
  stopping: "Stopping",
  stopped: "Stopped",
  resuming: "Resuming",
  blocked: "Needs attention",
};

export const CONTINUITY_LABELS: Record<OrchestratorContinuity, string> = {
  not_started: "No conversation yet",
  native: "Native conversation kept",
  unverified: "Conversation not verified",
  lost: "Conversation lost",
};

export type Command = "message" | "steer" | "stop" | "resume";

export type OrchestratorControls = {
  /** What may be asked now. The server checks again under its revision fence. */
  can: Record<Command, boolean>;
  /** An operation of this orchestrator is still pending: its kind. */
  pending: OrchestratorOperation["kind"] | null;
  /** One sentence for the composer when it takes no message. */
  composerNote: string | null;
  /** A quiet notice above the conversation, when the state needs one. */
  notice: { tone: "warning" | "danger" | "info"; title: string; text: string } | null;
};

/**
 * What the person may do with an orchestrator in this state. `running` is whether a turn of its conversation is
 * queued or running, as the chat projection reads it. A lost conversation is never offered as resumable: a new
 * conversation is a new orchestrator.
 */
export function orchestratorControls(detail: OrchestratorDetail, running: boolean): OrchestratorControls {
  const { orchestrator } = detail;
  // The server refuses every new command while any operation is pending or unsettled (#662): none is offered then.
  const open = detail.operations.find((operation) => operation.state === "pending" || operation.state === "uncertain");
  const pending = open?.kind ?? null;
  const lost = orchestrator.continuity === "lost";
  const ready = orchestrator.state === "ready" && !lost && !open;
  const can = {
    message: ready,
    steer: ready && running,
    stop: (orchestrator.state === "ready" || orchestrator.state === "blocked") && !open,
    // Resume continues the same native conversation, so only a verified one is resumable.
    resume: orchestrator.state === "stopped" && orchestrator.continuity === "native" && !open,
  };
  return { can, pending, composerNote: composerNote(orchestrator, can, open), notice: notice(orchestrator) };
}

function composerNote(
  orchestrator: Orchestrator,
  can: OrchestratorControls["can"],
  open: OrchestratorOperation | undefined,
): string | null {
  if (can.message) return null;
  if (orchestrator.continuity === "lost") return "This conversation cannot continue.";
  if (open?.state === "uncertain") return `Armada is settling the last ${open.kind}; nothing is repeated meanwhile.`;
  if (open) return `Waiting for the ${open.kind} to finish.`;
  if (orchestrator.state === "stopped")
    return can.resume
      ? "Stopped. Resume it to continue the same conversation."
      : "Stopped. Armada cannot resume a conversation it could not verify.";
  if (orchestrator.state === "blocked") return "It takes no message until the problem above is solved.";
  return `${STATE_LABELS[orchestrator.state]}…`;
}

function notice(orchestrator: Orchestrator): OrchestratorControls["notice"] {
  if (orchestrator.continuity === "lost")
    return {
      tone: "danger",
      title: "The conversation was lost",
      text: "Its saved native state is gone, so it cannot resume as the same conversation. Create a new orchestrator to start over.",
    };
  if (orchestrator.state === "blocked")
    return {
      tone: "danger",
      title: "Needs attention",
      text: orchestrator.blockedReason ?? "Armada stopped admitting work until this is reconciled.",
    };
  if (orchestrator.continuity === "unverified")
    return {
      tone: "warning",
      title: "Conversation not verified",
      text: "Armada could not prove the saved conversation is intact, so it will not continue it as if it were.",
    };
  return null;
}

const IDLE_PRESETS_MINUTES = [15, 30, 60, 120, 240, 480, 720, 1440] as const;

/** The inactivity periods offered, within the server's bounds; the default first in the label only. */
export function idleChoices(): { seconds: number; label: string }[] {
  return IDLE_PRESETS_MINUTES.map((minutes) => minutes * 60)
    .filter(
      (seconds) => seconds >= ORCHESTRATOR_DEFAULTS.minIdleSeconds && seconds <= ORCHESTRATOR_DEFAULTS.maxIdleSeconds,
    )
    .map((seconds) => ({
      seconds,
      label: `${formatDuration(seconds)}${seconds === ORCHESTRATOR_DEFAULTS.idleSeconds ? " (default)" : ""}`,
    }));
}

/** "15 min", "1 hour", "2 hours", "1 day". */
export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** How far ahead `iso` is at `now`: "in 12 min", "in 2 hours". Null when past or not a date. */
export function timeUntil(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at <= now) return null;
  return `in ${formatDuration(Math.max(60, at - now) / 1000)}`;
}

/** Named model accounts, as `creds/list` reports them once the server has them (#603). */
export type ModelAccount = { id: string; name: string; harness: Harness; scope: "user" | "org"; isDefault: boolean };

const ACCOUNT_HARNESS: Readonly<Record<string, Harness>> = {
  claude_oauth: "claude",
  anthropic: "claude",
  openai: "codex",
  codex_auth: "codex",
};

/**
 * The model accounts the viewer may name for `orgId`: theirs and the org's, each with an id (only named accounts have
 * one), usable now (not revoked or expired at `now`). Only ids and names are read; a credential value never is.
 */
export function parseModelAccounts(value: unknown, orgId: string, now: number): ModelAccount[] {
  if (!isRecord(value)) return [];
  const accounts: ModelAccount[] = [];
  const read = (rows: unknown, scope: "user" | "org") => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!isRecord(row) || !str(row.id) || typeof row.kind !== "string") continue;
      const harness = ACCOUNT_HARNESS[row.kind];
      if (!harness) continue;
      if (row.status !== undefined && row.status !== "active") continue;
      if (str(row.expiresAt) && Date.parse(row.expiresAt) <= now) continue;
      const label = str(row.name) ? row.name.trim().slice(0, 120) : row.kind;
      accounts.push({ id: row.id, name: label, harness, scope, isDefault: row.isDefault === true });
    }
  };
  read(value.user, "user");
  if (Array.isArray(value.orgs))
    for (const org of value.orgs) if (isRecord(org) && org.id === orgId) read(org.credentials, "org");
  return accounts;
}

export type CreateFields = {
  org: string;
  name: string;
  golden: string;
  provider: string;
  harness: string;
  model: string;
  otherModel: string;
  reasoningEffort: string;
  account: string;
  repo: string;
  idleSeconds: string;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * `OrchestratorCreate` from the create form, checked against what the page offered: the golden's provider and
 * repositories, the accounts of the chosen harness. Limits the person did not choose are omitted, so the server's
 * defaults apply and are what it stores.
 */
export function orchestratorCreateRequest(
  fields: CreateFields,
  offered: { provider: string; repositories: readonly string[]; accounts: readonly ModelAccount[] },
): Parsed<OrchestratorCreate> {
  const name = fields.name.trim();
  if (name.length < 1 || name.length > 120) return { ok: false, error: "Give it a name of 1 to 120 characters." };
  const harness = HARNESSES.find((candidate) => candidate === fields.harness);
  if (!harness) return { ok: false, error: "Choose Claude Code or Codex." };
  if (
    !str(fields.org) ||
    !str(fields.golden) ||
    !isSandboxProvider(fields.provider) ||
    fields.provider !== offered.provider
  )
    return { ok: false, error: "That golden is not available. Reload and try again." };
  const account = offered.accounts.find((candidate) => candidate.id === fields.account);
  if (!account || account.harness !== harness)
    return { ok: false, error: `Choose a ${harness === "claude" ? "Claude" : "Codex"} model account.` };
  const repo = fields.repo.trim();
  if (repo && !offered.repositories.includes(repo))
    return { ok: false, error: "That repository is not part of this golden. Reload and try again." };
  const idle = fields.idleSeconds.trim() === "" ? ORCHESTRATOR_DEFAULTS.idleSeconds : Number(fields.idleSeconds);
  if (
    !Number.isSafeInteger(idle) ||
    idle < ORCHESTRATOR_DEFAULTS.minIdleSeconds ||
    idle > ORCHESTRATOR_DEFAULTS.maxIdleSeconds
  )
    return { ok: false, error: "Choose an inactivity period between 15 minutes and 24 hours." };
  let choice: { model: string; reasoningEffort: string };
  try {
    const model = (fields.model === "other" ? fields.otherModel : fields.model).trim() || undefined;
    choice = resolveModelChoice(harness, { model, reasoningEffort: fields.reasoningEffort.trim() || undefined });
  } catch (error) {
    if (error instanceof LaunchError) return { ok: false, error: error.message };
    throw error;
  }
  return {
    ok: true,
    value: {
      version: ORCHESTRATOR_CONTRACT_VERSION,
      orgId: fields.org,
      name,
      goldenId: fields.golden,
      provider: fields.provider,
      harness,
      ...(repo ? { repo } : {}),
      model: choice.model,
      reasoningEffort: choice.reasoningEffort,
      modelAccountId: account.id,
      ...(idle === ORCHESTRATOR_DEFAULTS.idleSeconds ? {} : { idleSeconds: idle }),
    },
  };
}

/** `Idempotency-Key`: 1 to 128 printable ASCII characters. */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
}

/** An opaque Armada id, safe in a path segment. */
export function isOrchestratorId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/** One request as sent: repeating it after an unknown outcome must send exactly this again. */
export type Attempt = { command: Command; text: string; expectedRevision: number; key: string };

/**
 * The request to send for `command` and `text`. After an unknown outcome the same request is sent again, with its
 * original revision and key, even if the page has since read a newer revision (possibly the request's own effect):
 * the server then answers the original receipt instead of applying it twice. Anything else is a new request.
 */
export function attemptFor(
  unsettled: Attempt | null,
  command: Command,
  text: string,
  revision: number,
  newKey: () => string,
): Attempt {
  if (unsettled && unsettled.command === command && unsettled.text === text) return unsettled;
  return { command, text, expectedRevision: revision, key: newKey() };
}

/** What stays to be repeated after an answer: only an attempt whose outcome is unknown. */
export function unsettledAfter(attempt: Attempt, result: { ok: boolean; failure?: string }): Attempt | null {
  return !result.ok && result.failure === "uncertain" ? attempt : null;
}

/**
 * What stays to be repeated after a command's answer and the re-read that follows it. Besides an unknown outcome, a
 * refused one (conflict) is kept while an operation of the same kind is pending or unsettled: it may be this very
 * request, applied before its answer could be recorded, and its key then returns that receipt instead of acting twice.
 */
export function unsettledAfterReread(
  attempt: Attempt,
  result: { ok: boolean; failure?: string },
  reread: Pick<OrchestratorDetail, "operations"> | null,
): Attempt | null {
  const unsettled = unsettledAfter(attempt, result);
  if (unsettled || result.ok || result.failure !== "stale" || !reread) return unsettled;
  const open = reread.operations.some(
    (operation) =>
      operation.kind === attempt.command && (operation.state === "pending" || operation.state === "uncertain"),
  );
  return open ? attempt : null;
}
