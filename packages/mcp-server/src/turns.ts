import type { MachineSizeEvidence } from "@armada/core";
import {
  type AgentEvent,
  dedupeEvents,
  type PromptOutcome,
  type Provider,
  promptOutcome,
  reportedTurnUsage,
  type SandboxInfo,
  type SandboxPatch,
  type SandboxStatus,
  type SandboxUsage,
  type TaskOutcome,
  type TurnModelEvidence,
  turnModelEvidence,
} from "@armada/core";
import type { SandboxView, ServerSandboxStore } from "./data.ts";

export const INTERRUPTED_LAUNCH_REASON =
  "Launch interrupted before completion; provider cleanup is retried until confirmed.";
export function isInterruptedLaunch(sandbox: Pick<SandboxView, "status" | "statusReason">): boolean {
  return sandbox.status === "failed" && sandbox.statusReason === INTERRUPTED_LAUNCH_REASON;
}

const EVENT_PAGE_LIMIT = 200;
const EVENT_PAGES = 50;
/** How often `wait` asks the provider again. */
export const WAIT_POLL_MS = 1000;

export interface PromptReport {
  requestedModel?: string | null;
  observedModel?: string | null;
  modelSelectionReason?: TurnModelEvidence["modelSelectionReason"];
  modelSelectionMessage?: string | null;
  promptId: string;
  conversationId: string | null;
  state: PromptOutcome["state"];
  /** Why the turn failed or was interrupted, from the prompt event or the usage-limit or expired-login event. */
  reason: string | null;
}

export interface StatusReport {
  usage?: SandboxUsage | null;
  preservationNote?: string | null;
  taskOutcome?: TaskOutcome | null;
  credentialId?: string | null;
  credentialVersion?: number | null;
  id: string;
  golden: string;
  visibility: SandboxView["visibility"];
  harness: SandboxView["harness"];
  /** Persisted native repository directory; not an access boundary. */
  repositoryDir: string | null;
  machineSize: MachineSizeEvidence | null;
  /** Requested next-send default; not evidence of execution. */
  model: string | null;
  reasoningEffort: string | null;
  /** Armada's status, after this read. */
  status: SandboxStatus;
  /** Why it failed, as recorded. Null unless the status is failed. */
  statusReason: string | null;
  /** The provider's own state name, or null once the sandbox is deleted. */
  providerState: string | null;
  conversationIds: string[];
  expiresAt: string | null;
  /** The turn asked about, or the latest one. Null before the first prompt. */
  prompt: PromptReport | null;
  /** The agent is not working: nothing more will happen until the next send. */
  settled: boolean;
}

/**
 * Reads where a sandbox is and records it. The prompt's status comes from `getPrompt` (events are
 * rewritten in place); a turn boat calls `finished` after a usage limit or an expired login is `failed`.
 * A live machine is `running` while a turn runs, `ready` after one ends, and `failed` only when the machine failed.
 */
export async function readStatus(
  provider: Provider | null,
  store: ServerSandboxStore,
  sandbox: SandboxView,
  options: { promptId?: string; now: Date },
): Promise<StatusReport> {
  // Registration is not readiness. Only the launch owner (or lifecycle recovery
  // after its lease expires) may publish completion; status must remain readable.
  if (
    sandbox.status === "starting" ||
    isInterruptedLaunch(sandbox) ||
    (sandbox.status === "failed" && sandbox.stoppedAt !== null)
  )
    return report(sandbox, sandbox.status, null, null, null);

  if (sandbox.status === "deleted" || provider === null) {
    return report({ ...sandbox, statusReason: null }, "deleted", null, null, null);
  }

  if (store.recordUsage) {
    // Usage is optional telemetry: unavailable/truncated event history must not make status fail.
    try {
      const events = await allEvents(provider, sandbox.providerSandboxId, true, EVENT_PAGES);
      const collected = reportedTurnUsage(events);
      await store.recordUsage(sandbox.id, collected);
      sandbox = { ...sandbox, usage: { computeSeconds: sandbox.usage?.computeSeconds ?? null, ...collected } };
    } catch {
      /* Retain the last complete observation. */
    }
  }
  const info = await provider.get(sandbox.providerSandboxId);
  const target = options.promptId
    ? { promptId: options.promptId, conversationId: null }
    : await latestPrompt(provider, sandbox.providerSandboxId);
  let prompt: PromptReport | null = null;
  if (target) {
    const outcome = await promptOutcome(provider, {
      sandboxId: sandbox.providerSandboxId,
      promptId: target.promptId,
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
    });
    const recorded = await store.readTurnModel?.(sandbox.id, target.promptId);
    let evidence: TurnModelEvidence;
    // Terminal observations survive provider history retention. Never substitute the sandbox default.
    if (recorded?.evidence) evidence = recorded.evidence as TurnModelEvidence;
    else {
      let events: AgentEvent[] = [];
      let complete = false;
      try {
        events = await allEvents(provider, sandbox.providerSandboxId, true, EVENT_PAGES);
        complete = true;
      } catch {
        /* Missing history cannot prove exact-model execution. */
      }
      evidence = turnModelEvidence(events, {
        promptId: target.promptId,
        requestedModel: recorded?.requestedModel ?? null,
        complete,
      });
      if (outcome.state !== "running") await store.recordTurnModelEvidence?.(sandbox.id, target.promptId, evidence);
    }
    const selectionFailed = outcome.state === "finished" && evidence.modelSelectionReason !== null;
    prompt = {
      ...evidence,
      promptId: target.promptId,
      conversationId: target.conversationId,
      state: selectionFailed ? "failed" : outcome.state,
      reason: selectionFailed
        ? evidence.modelSelectionReason
        : outcome.state === "failed" || outcome.state === "interrupted"
          ? (outcome.reason ?? null)
          : null,
    };
  }

  const next = nextStatus(sandbox.status, info, prompt);
  const reason =
    next === "failed"
      ? (failureReason(info) ?? sandbox.statusReason)
      : (next === "stopped" || next === "stopping") && sandbox.statusReason === "expired"
        ? "expired"
        : null;
  if (next !== sandbox.status || reason !== sandbox.statusReason) {
    const patch: SandboxPatch = {
      status: next,
      statusReason: reason,
      ...(sandbox.lifecycleGeneration === undefined ? {} : { expectedGeneration: sandbox.lifecycleGeneration }),
    };
    if (next === "failed" && info.physicalExitConfirmed) {
      patch.stoppedAt = (info.stoppedAt ?? options.now).toISOString();
      patch.usageRuntimeUnknown = !info.stoppedAt;
    } else if (next === "stopped") {
      patch.stoppedAt = (info.stoppedAt ?? options.now).toISOString();
      patch.usageRuntimeUnknown = !info.stoppedAt;
    } else if (sandbox.stoppedAt !== null && next !== "failed") patch.stoppedAt = null;
    await store.update(sandbox.id, patch);
  }
  const refreshed = store.recordUsage ? await store.get(sandbox.id) : null;
  return report(
    { ...sandbox, usage: refreshed?.usage ?? sandbox.usage ?? null, statusReason: reason },
    next,
    info,
    prompt,
    info.expiresAt ?? null,
  );
}

function failureReason(info: SandboxInfo): string | null {
  if (info.state === "failed") return info.error ?? `The machine failed (${info.providerState}).`;
  return null;
}

function nextStatus(current: SandboxStatus, info: SandboxInfo, prompt: PromptReport | null): SandboxStatus {
  if (info.state === "stopped") return current === "failed" && !prompt ? "failed" : "stopped";
  if (info.state === "stopping") return current === "failed" && !prompt ? "failed" : "stopping";
  if (info.state === "failed") return "failed";
  if (current === "stopping") return "stopping";
  if (info.state === "starting") return current === "running" ? "running" : "starting";
  if (!prompt) return current === "starting" ? "ready" : current === "running" ? "running" : current;
  switch (prompt.state) {
    case "running":
      return "running";
    default:
      return "ready";
  }
}

function report(
  sandbox: SandboxView,
  status: SandboxStatus,
  info: SandboxInfo | null,
  prompt: PromptReport | null,
  expiresAt: Date | null,
): StatusReport {
  const machineDown = status === "stopped" || status === "deleted" || status === "failed";
  return {
    usage: sandbox.usage ?? null,
    taskOutcome: sandbox.taskOutcome ?? null,
    id: sandbox.id,
    golden: sandbox.golden,
    visibility: sandbox.visibility,
    harness: sandbox.harness,
    repositoryDir: sandbox.repositoryDir ?? null,
    machineSize: sandbox.machineSize ?? null,
    model: sandbox.model,
    reasoningEffort: sandbox.reasoningEffort,
    credentialId: sandbox.credentialId ?? null,
    credentialVersion: sandbox.credentialVersion ?? null,
    status,
    statusReason: status === "failed" || status === "stopped" || status === "stopping" ? sandbox.statusReason : null,
    providerState: info?.providerState ?? null,
    conversationIds: sandbox.conversationIds,
    preservationNote: [sandbox.preservationNote, info?.stopNote].filter(Boolean).join("; ") || null,
    expiresAt: sandbox.expiresAt ?? (expiresAt ? expiresAt.toISOString() : null),
    prompt,
    settled: machineDown || (prompt ? prompt.state !== "running" : status !== "running" && status !== "starting"),
  };
}

/** The newest turn of the sandbox, from its prompt events. */
export async function latestPrompt(
  provider: Provider,
  sandboxId: string,
  complete = false,
): Promise<{ promptId: string; conversationId: string | null } | null> {
  let latest: AgentEvent | undefined;
  for (const event of await allEvents(provider, sandboxId, complete)) {
    if (event.kind !== "prompt" || !event.promptId) continue;
    if (!latest || event.at >= latest.at) latest = event;
  }
  return latest?.promptId ? { promptId: latest.promptId, conversationId: latest.conversationId ?? null } : null;
}

async function allEvents(
  provider: Provider,
  sandboxId: string,
  complete = false,
  maxPages?: number,
): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; maxPages === undefined ? complete || page < EVENT_PAGES : page < maxPages; page++) {
    const read = await provider.events({ sandboxId, ...(cursor ? { cursor } : {}), limit: EVENT_PAGE_LIMIT });
    all.push(...read.events);
    if (!read.hasMore) break;
    if (!read.cursor || cursors.has(read.cursor) || read.cursor === cursor) {
      if (complete) throw new Error("Cannot prove latest turn: provider event cursor did not advance.");
      break;
    }
    if (complete && maxPages !== undefined && page === maxPages - 1)
      throw new Error("Complete event history exceeds the read budget.");
    cursors.add(read.cursor);
    cursor = read.cursor;
  }
  return dedupeEvents(all);
}

export interface WaitReport extends StatusReport {
  timedOut: boolean;
}

/** Reads the status until the agent settles or the timeout passes. Never longer than `timeoutMs`. */
export async function waitSettled(
  read: () => Promise<StatusReport>,
  options: { timeoutMs: number; now: () => Date; sleep: (ms: number) => Promise<void> },
): Promise<WaitReport> {
  const deadline = options.now().getTime() + options.timeoutMs;
  for (;;) {
    const status = await read();
    if (status.settled) return { ...status, timedOut: false };
    const left = deadline - options.now().getTime();
    if (left <= 0) return { ...status, timedOut: true };
    await options.sleep(Math.min(WAIT_POLL_MS, left));
  }
}
