import { isRecord, type SandboxStatus } from "@armada/core";
import { applyChatPage, type ChatHistory, initialChatHistory, isSuccessfulPage, parseEventPage } from "./events.ts";

export const CHAT_CACHE_LIMIT = 12;
const WARM_TTL_MS = 10_000;

export type ChatTurnModel = {
  rateLimit?: { waiting: boolean; message: string; retryCount: number; totalWaitMs: number } | null;
  state?: string;
  conversationId?: string | null;
  requestedModel?: string | null;
  observedModel?: string | null;
  modelSelectionReason?: string | null;
  modelSelectionMessage?: string | null;
};

export type ChatCacheEntry = {
  history: ChatHistory;
  status: SandboxStatus;
  statusMessage: string | null;
  hasLiveStatus: boolean;
  idlePaused: boolean;
  turnModel: ChatTurnModel | null;
  updatedAt: number;
};

export function chatCacheKey(orgId: string, sandboxId: string) {
  return `${orgId}:${sandboxId}`;
}

export function createChatCache(limit = CHAT_CACHE_LIMIT) {
  const entries = new Map<string, ChatCacheEntry>();
  const drafts = new Map<string, string>();
  const inFlight = new Map<string, AbortController>();
  let epoch = 0;

  function get(orgId: string, sandboxId: string) {
    const key = chatCacheKey(orgId, sandboxId);
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  function set(orgId: string, sandboxId: string, entry: ChatCacheEntry) {
    const key = chatCacheKey(orgId, sandboxId);
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  }

  function getDraft(orgId: string, sandboxId: string) {
    const key = chatCacheKey(orgId, sandboxId);
    const draft = drafts.get(key);
    if (draft === undefined) return "";
    drafts.delete(key);
    drafts.set(key, draft);
    return draft;
  }

  function setDraft(orgId: string, sandboxId: string, draft: string) {
    const key = chatCacheKey(orgId, sandboxId);
    drafts.delete(key);
    if (!draft) return;
    drafts.set(key, draft);
    while (drafts.size > limit) {
      const oldest = drafts.keys().next().value;
      if (oldest !== undefined) drafts.delete(oldest);
    }
  }

  function remove(orgId: string, sandboxId: string) {
    const key = chatCacheKey(orgId, sandboxId);
    inFlight.get(key)?.abort();
    inFlight.delete(key);
    entries.delete(key);
    drafts.delete(key);
  }

  function clear() {
    epoch += 1;
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    entries.clear();
    drafts.clear();
  }

  async function warm(orgId: string, sandboxId: string, options?: { fetchImpl?: typeof fetch; now?: () => number }) {
    const now = options?.now ?? Date.now;
    const fetchImpl = options?.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    if (!orgId || !sandboxId || !fetchImpl) return;
    const key = chatCacheKey(orgId, sandboxId);
    const startedAt = now();
    const cached = entries.get(key);
    if ((cached && startedAt - cached.updatedAt < WARM_TTL_MS) || inFlight.has(key)) return;

    const startEpoch = epoch;
    const controller = new AbortController();
    inFlight.set(key, controller);
    try {
      const response = await fetchImpl(`/api/sandboxes/${sandboxId}/history`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || controller.signal.aborted || startEpoch !== epoch) return;
      const body: unknown = await response.json();
      if (controller.signal.aborted || startEpoch !== epoch || !isSuccessfulPage(body)) return;
      const existing = entries.get(key);
      if (existing && existing.updatedAt >= startedAt) return;
      const page = parseEventPage(body);
      const history = applyChatPage(initialChatHistory, page, body.backward === true ? "latest" : "forward");
      if (!history) return;
      const statusMessage = typeof body.statusMessage === "string" ? body.statusMessage : null;
      set(orgId, sandboxId, {
        history,
        status: body.status as SandboxStatus,
        statusMessage,
        hasLiveStatus: true,
        idlePaused: statusMessage === "Paused — wakes on your next message",
        turnModel: isRecord(body.prompt) ? (body.prompt as ChatTurnModel) : null,
        updatedAt: now(),
      });
    } catch {
      return;
    } finally {
      if (inFlight.get(key) === controller) inFlight.delete(key);
    }
  }

  return {
    get,
    set,
    getDraft,
    setDraft,
    delete: remove,
    clear,
    warm,
    get size() {
      return entries.size;
    },
  };
}

const defaultCache = createChatCache();
export const getChatCache = defaultCache.get;
export const setChatCache = defaultCache.set;
export const getChatDraft = defaultCache.getDraft;
export const setChatDraft = defaultCache.setDraft;
export const deleteChatCache = defaultCache.delete;
export const clearChatCache = defaultCache.clear;
export const warmChatCache = defaultCache.warm;
