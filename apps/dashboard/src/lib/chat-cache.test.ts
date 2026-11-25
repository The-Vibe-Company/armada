import { describe, expect, test } from "bun:test";
import { type ChatCacheEntry, createChatCache } from "./chat-cache.ts";
import { initialChatHistory } from "./events.ts";

const entry = (id: string, updatedAt = 1000) =>
  ({
    history: {
      ...initialChatHistory,
      events: [{ id, at: 1, kind: "message", text: id, partial: false, tools: [] }],
      cursor: `c-${id}`,
      loaded: true,
    },
    status: "ready",
    statusMessage: null,
    hasLiveStatus: true,
    idlePaused: false,
    turnModel: null,
    updatedAt,
  }) satisfies ChatCacheEntry;

describe("chat-cache", () => {
  test("evicts least recently used entry at capacity and scopes keys by org", () => {
    const cache = createChatCache(2);
    cache.set("org-a", "sb-1", entry("e1"));
    cache.set("org-a", "sb-2", entry("e2"));
    expect(cache.get("org-a", "sb-1")?.history.cursor).toBe("c-e1");
    cache.set("org-b", "sb-1", entry("e3"));
    expect(cache.size).toBe(2);
    expect(cache.get("org-a", "sb-2")).toBeUndefined();
    expect(cache.get("org-a", "sb-1")?.history.cursor).toBe("c-e1");
    expect(cache.get("org-b", "sb-1")?.history.cursor).toBe("c-e3");
  });

  test("warms from history, deduplicates within TTL, and aborts/discards in-flight warms on clear", async () => {
    const cache = createChatCache(12);
    let now = 1_000;
    let fetches = 0;
    const warmFetch = (async () => {
      fetches += 1;
      return Response.json({
        status: "ready",
        statusMessage: null,
        configured: true,
        cursor: "ar1_sb-1_1",
        hasMore: false,
        backward: true,
        prompt: { state: "finished", conversationId: "c1" },
        events: [{ id: "m1", at: 5, kind: "message", text: "cached reply", partial: false, tools: [] }],
      });
    }) as unknown as typeof fetch;

    await cache.warm("org-a", "sb-1", { fetchImpl: warmFetch, now: () => now });
    now = 5_000;
    await cache.warm("org-a", "sb-1", { fetchImpl: warmFetch, now: () => now });
    expect(fetches).toBe(1);
    expect(cache.get("org-a", "sb-1")?.history.events).toHaveLength(1);

    let resolveFetch!: (response: Response) => void;
    let aborted = false;
    const deferredFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch;

    const pending = cache.warm("org-a", "sb-2", { fetchImpl: deferredFetch, now: () => now });
    cache.clear();
    expect(aborted).toBe(true);
    expect(cache.size).toBe(0);
    resolveFetch(Response.json({ status: "ready", configured: true, cursor: "c2", hasMore: false, events: [] }));
    await pending;
    expect(cache.get("org-a", "sb-2")).toBeUndefined();
  });
});
