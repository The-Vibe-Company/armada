import type { MachineSizeEvidence } from "@armada/core";
import {
  type AgentEvent,
  dedupeEvents,
  type PromptOutcome,
  type Provider,
  promptOutcome,
  type SandboxInfo,
  type SandboxPatch,
  type SandboxStatus,
} from "@armada/core";
import type { SandboxView, ServerSandboxStore } from "./data.ts";

const EVENT_PAGE_LIMIT = 200;
const EVENT_PAGES = 50;
/** How often `wait` asks the provider again. */
export const WAIT_POLL_MS = 1000;

export interface PromptReport {
  promptId: string;
  conversationId: string | null;
  state: PromptOutcome["state"];
  /** Why the turn failed, from the prompt event or the usage-limit or expired-login event. */
  reason: string | null;
}

export interface StatusReport {
  credentialId?: string | null;
  credentialVersion?: number | null;
  id: string;
  golden: string;
  visibility: SandboxView["visibility"];
  harness: SandboxView["harness"];
  /** Persisted native repository directory; not an access boundary. */
  repositoryDir: string | null;
  machineSize: MachineSizeEvidence | null;
  /** What its turns run with. Null for a sandbox launched before the choice was recorded. */
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
 * A live machine is `running` while a turn runs, `ready` after one ends, and `failed` when it failed.
 */
export async function readStatus(
  provider: Provider | null,
  store: ServerSandboxStore,
  sandbox: SandboxView,
  options: { promptId?: string; now: Date },
): Promise<StatusReport> {
  if (sandbox.status === "deleted" || provider === null) {
    return report({ ...sandbox, statusReason: null }, "deleted", null, null, null);
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
    prompt = {
      promptId: target.promptId,
      conversationId: target.conversationId,
      state: outcome.state,
      reason: outcome.state === "failed" ? outcome.reason : null,
    };
  }

  const next = nextStatus(sandbox.status, info, prompt);
  const reason = next === "failed" ? (failureReason(info, prompt) ?? sandbox.statusReason) : null;
  if (next !== sandbox.status || reason !== sandbox.statusReason) {
    const patch: SandboxPatch = {
      status: next,
      statusReason: reason,
      ...(sandbox.lifecycleGeneration === undefined ? {} : { expectedGeneration: sandbox.lifecycleGeneration }),
    };
    if (next === "failed" && info.physicalExitConfirmed) patch.stoppedAt = options.now.toISOString();
    else if (next === "stopped") patch.stoppedAt = (info.stoppedAt ?? options.now).toISOString();
    else if (sandbox.stoppedAt !== null && next !== "failed") patch.stoppedAt = null;
    await store.update(sandbox.id, patch);
  }
  return report({ ...sandbox, statusReason: reason }, next, info, prompt, info.expiresAt ?? null);
}

function failureReason(info: SandboxInfo, prompt: PromptReport | null): string | null {
  if (prompt?.state === "failed" && prompt.reason) return prompt.reason;
  if (info.state === "failed") return info.error ?? `The machine failed (${info.providerState}).`;
  return null;
}

function nextStatus(current: SandboxStatus, info: SandboxInfo, prompt: PromptReport | null): SandboxStatus {
  if (info.state === "stopped") return current === "failed" ? "failed" : "stopped";
  if (info.state === "stopping") return current === "failed" ? "failed" : "stopping";
  if (info.state === "failed") return "failed";
  if (info.state === "starting") return current === "running" ? "running" : "starting";
  if (!prompt) return current === "starting" ? "ready" : current === "running" ? "running" : current;
  switch (prompt.state) {
    case "running":
      return "running";
    case "failed":
      return "failed";
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
    statusReason: status === "failed" ? sandbox.statusReason : null,
    providerState: info?.providerState ?? null,
    conversationIds: sandbox.conversationIds,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    prompt,
    settled: machineDown || (prompt ? prompt.state !== "running" : status !== "running" && status !== "starting"),
  };
}

/** The newest turn of the sandbox, from its prompt events. */
export async function latestPrompt(
  provider: Provider,
  sandboxId: string,
): Promise<{ promptId: string; conversationId: string | null } | null> {
  let latest: AgentEvent | undefined;
  for (const event of await allEvents(provider, sandboxId)) {
    if (event.kind !== "prompt" || !event.promptId) continue;
    if (!latest || event.at >= latest.at) latest = event;
  }
  return latest?.promptId ? { promptId: latest.promptId, conversationId: latest.conversationId ?? null } : null;
}

async function allEvents(provider: Provider, sandboxId: string): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < EVENT_PAGES; page++) {
    const read = await provider.events({ sandboxId, ...(cursor ? { cursor } : {}), limit: EVENT_PAGE_LIMIT });
    all.push(...read.events);
    if (!read.hasMore || !read.cursor || read.cursor === cursor) break;
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
