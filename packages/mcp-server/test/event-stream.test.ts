import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { streamSandboxEvents } from "@armada/core/contract";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { EVENT_PAGE_SIZE, type EventFeed } from "../src/event-feed.ts";
import { createEventStream } from "../src/event-stream.ts";
import { eventFeedWakeKey, runtimeWakes } from "../src/wake-bus.ts";

async function fixture() {
  const authStore = createMemoryAuthStore();
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const sandbox = crypto.randomUUID();
  const owner = generateToken("service");
  authStore.addMembership(userId, { orgId, name: "Example", role: "member" });
  await authStore.insertToken("service", {
    userId,
    orgId,
    hash: await sha256Hex(owner),
    label: "test",
    createdAt: new Date().toISOString(),
  });
  const events: NonNullable<Awaited<ReturnType<ReturnType<EventFeed["owner"]>>>> = [];
  const read = async (cursor: string) =>
    events.filter((row) => BigInt(row.id) > BigInt(cursor)).slice(0, EVENT_PAGE_SIZE);
  const feed: EventFeed = {
    owner: (caller, id) => (caller.userId === userId && id === sandbox ? read : async () => null),
    child: () => async () => null,
  };
  const options: ControlOptions = {
    authStore,
    supabase: { supabaseUrl: "https://example.test", anonKey: "placeholder" },
    encryptionKey: undefined,
    store: {} as ControlOptions["store"],
    eventFeed: feed,
  };
  const request = (query = "", lastEventId?: string, target = sandbox, bearer = owner) =>
    new Request(`https://example.test/api/v1/events?sandbox=${target}${query}`, {
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      },
    });
  const add = (id: bigint) =>
    events.push({
      id: id.toString(),
      sandboxId: sandbox,
      sequence: "19",
      kind: "runtime_event",
      ref: "19",
      createdAt: "2026-11-19T00:00:00Z",
    });
  return { options, request, sandbox, add };
}

const decoder = new TextDecoder();
function frames(chunk: Uint8Array | undefined) {
  return decoder
    .decode(chunk)
    .trimEnd()
    .split("\n\n")
    .map((frame) => {
      const [id, data] = frame.split("\n");
      const value = streamSandboxEvents.output.parse(JSON.parse(data!.slice(6)));
      expect(id).toBe(`id: ${value.id}`);
      return value.id;
    });
}

test("replays after Last-Event-ID across pages and delivers a live commit without waiting for the recheck", async () => {
  const f = await fixture();
  const base = 9007199254740992n;
  for (let offset = 0; offset <= EVENT_PAGE_SIZE + 1; offset++) f.add(base + BigInt(offset));
  const response = await createEventStream({
    now: () => 0,
    wait: async () => {
      throw new Error("Used the fallback despite a wake");
    },
  })(f.request("&cursor=0", base.toString()), f.options);
  expect(response.headers.get("content-type")).toBe(streamSandboxEvents.outputMediaType);
  const reader = response.body!.getReader();
  try {
    expect(frames((await reader.read()).value)).toEqual(
      Array.from({ length: EVENT_PAGE_SIZE }, (_, i) => (base + BigInt(i + 1)).toString()),
    );
    expect(frames((await reader.read()).value)).toEqual([(base + BigInt(EVENT_PAGE_SIZE + 1)).toString()]);
    const live = base + BigInt(EVENT_PAGE_SIZE + 2);
    f.add(live);
    runtimeWakes.notify(eventFeedWakeKey(f.sandbox));
    expect(frames((await reader.read()).value)).toEqual([live.toString()]);
  } finally {
    await reader.cancel();
  }
});

test("rechecks for commits without a local wake and sends an idle heartbeat after fifteen seconds", async () => {
  const f = await fixture();
  let now = 0;
  const response = await createEventStream({
    now: () => now,
    wait: async (ms) => {
      now += ms;
      if (now === 1000) f.add(1n);
    },
  })(f.request(), f.options);
  const reader = response.body!.getReader();
  try {
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    expect(now).toBe(0);
    expect(frames((await reader.read()).value)).toEqual(["1"]);
    expect(now).toBe(1000);
    expect(decoder.decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    expect(now).toBe(16_000);
  } finally {
    await reader.cancel();
  }
});

test("refuses an authenticated caller outside the sandbox scope before sending streaming headers", async () => {
  const f = await fixture();
  const response = await handleControlRequest(f.request("", undefined, crypto.randomUUID()), f.options);
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({ error: { code: "forbidden" } });
});

test("server drain ends an idle feed so the client can reconnect", async () => {
  const f = await fixture();
  const drain = new AbortController();
  const { promise: waiting, resolve: enteredWait } = Promise.withResolvers<void>();
  const response = await createEventStream({
    now: () => 0,
    wait: (_ms, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        enteredWait();
      }),
  })(f.request(), { ...f.options, eventStreamShutdown: drain.signal });
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  await waiting;
  drain.abort();
  expect((await pending).done).toBe(true);
});

test("a drain during authorization sends the retryable drain refusal before streaming", async () => {
  const f = await fixture();
  const drain = new AbortController();
  const { promise: page, resolve } = Promise.withResolvers<[]>();
  const { promise: reading, resolve: enteredRead } = Promise.withResolvers<void>();
  f.options.eventFeed = {
    owner: () => () => {
      enteredRead();
      return page;
    },
    child: () => async () => null,
  };
  const response = handleControlRequest(f.request(), { ...f.options, eventStreamShutdown: drain.signal });
  await reading;
  drain.abort();
  resolve([]);
  const refusal = await response;
  expect(refusal?.status).toBe(503);
  expect(refusal?.headers.get("retry-after")).toBe("5");
  expect(await refusal?.json()).toEqual({ error: "temporarily_unavailable" });
});
