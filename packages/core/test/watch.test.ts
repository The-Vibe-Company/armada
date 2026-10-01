import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { entryKey, inboxTag } from "../src/live.ts";
import {
  EMPTY_WATCH_STATE,
  rearm,
  stopHookDecision,
  transientFailure,
  type WatchState,
  watchInbox,
} from "../src/watch.ts";
import { fakeClock, NOW, tempFleet } from "./support.ts";

const P = "widgets";
const COORDINATOR = "ws-coordinator/session";

async function holding(live: ReturnType<typeof tempFleet>, ticket: string, handle = `ws/${ticket}`) {
  await live.store.saveRuntimeHandle({
    project: P,
    ticket,
    runtime: "conductor",
    handle,
    branch: null,
    at: live.clock.now(),
  });
  await live.store.recordEvent({ project: P, ticket, kind: "claim", phase: "planning", at: live.clock.now() });
}

const handBack = (live: ReturnType<typeof tempFleet>, ticket: string) =>
  live.store.putHandBack({
    project: P,
    ticket,
    author: null,
    body: `Agent status: ready-to-merge — PR #1`,
    at: live.clock.now(),
  });

function options(live: ReturnType<typeof tempFleet>, over: Partial<Parameters<typeof watchInbox>[1]> = {}) {
  const retries: string[] = [];
  return {
    retries,
    o: {
      project: P,
      coordinator: COORDINATOR,
      silentAfterMinutes: 15,
      seen: [] as string[],
      now: live.clock.now,
      sleep: live.clock.sleep,
      onRetry: (m: string) => retries.push(m),
      ...over,
    },
  };
}

describe("the inbox read names the workers in flight", () => {
  test("the coordinator's own session is not a worker, and a new worker changes the etag", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    await holding(live, "DEMO-1", COORDINATOR);
    const first = await live.fleet.inbox({ coordinator: COORDINATOR, silentAfterMinutes: 15, etag: null });
    expect([first?.items, first?.inFlight]).toEqual([[], ["DEMO-2"]]);
    expect(first?.etag).toBe(inboxTag([], ["DEMO-2"]));
    // An empty fleet keeps the etag of an inbox read before this field existed.
    expect(inboxTag([])).not.toBe(first?.etag);

    expect(
      await live.fleet.inbox({ coordinator: COORDINATOR, silentAfterMinutes: 15, etag: first?.etag ?? null }),
    ).toBe(null);
    await holding(live, "DEMO-3");
    const next = await live.fleet.inbox({
      coordinator: COORDINATOR,
      silentAfterMinutes: 15,
      etag: first?.etag ?? null,
    });
    expect(next?.inFlight).toEqual(["DEMO-2", "DEMO-3"]);
  });
});

describe("armada watch", () => {
  test("waits through unchanged reads, a 5xx and a network failure, and returns on a new hand-back", async () => {
    let asks = 0;
    const clock = fakeClock();
    const live = tempFleet({
      clock,
      fail: (op) => {
        if (op !== "inbox") return null;
        asks++;
        if (asks === 3) return Response.json({ error: "database waking up" }, { status: 503 });
        if (asks === 4) return new TypeError("fetch failed");
        return null;
      },
    });
    await holding(live, "DEMO-2");
    const reads: (string[] | null)[] = [];
    const { o, retries } = options(live, {
      onRead: async (r) => {
        reads.push(r.inFlight);
      },
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (asks === 5) await handBack(live, "DEMO-2");
      },
    });

    const got = await watchInbox(live.fleet, o);
    expect(got.outcome).toBe("items");
    expect(got.items.map((e) => [e.kind, e.ticket, e.new])).toEqual([["hand-back", "DEMO-2", true]]);
    expect(got.inFlight).toEqual(["DEMO-2"]);
    expect(retries).toEqual([
      "Armada refused: database waking up; still watching, next try in 15 s",
      "Armada (armada.example.test) unreachable: fetch failed; still watching, next try in 30 s",
    ]);
    // 200, 304, 503, (network), 304, then the hand-back.
    expect(live.statuses).toEqual([200, 304, 503, 304, 200]);
    // 15 s, 15 s, then 15 + 30 s of backing off, then 15 s.
    expect(clock.now().getTime() - NOW.getTime()).toBe(90_000);
    expect(reads).toEqual([["DEMO-2"], ["DEMO-2"]]);
  });

  test("an item already shown to the coordinator does not wake it; a new one does", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    await holding(live, "DEMO-3");
    await handBack(live, "DEMO-2");
    const shown = await live.fleet.inbox({ coordinator: COORDINATOR, silentAfterMinutes: 15, etag: null });
    let sleeps = 0;
    const { o } = options(live, {
      seen: (shown?.items ?? []).map(entryKey),
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++sleeps === 4)
          await live.store.addInboxItem({
            project: P,
            ticket: "DEMO-3",
            kind: "question",
            recipient: "coordinator",
            author: "ws/DEMO-3",
            body: "Which table?",
            at: live.clock.now(),
          });
      },
    });
    const got = await watchInbox(live.fleet, o);
    expect(got.items.map((e) => [e.kind, e.ticket, e.new])).toEqual([
      ["hand-back", "DEMO-2", false],
      ["question", "DEMO-3", true],
    ]);
    expect(live.clock.now().getTime() - NOW.getTime()).toBe(60_000);
  });

  test("a hand-back already shown wakes the watch again when handed back on a new head, not on the same one", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    const handBackOn = (head: string) =>
      live.store.putHandBack({
        project: P,
        ticket: "DEMO-2",
        author: null,
        body: `Agent status: ready-to-merge — PR #1, head ${head}, CI green`,
        at: live.clock.now(),
      });
    await handBackOn("a".repeat(40));
    const shown = await live.fleet.inbox({ coordinator: COORDINATOR, silentAfterMinutes: 15, etag: null });
    let sleeps = 0;
    const { o } = options(live, {
      seen: (shown?.items ?? []).map(entryKey),
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        sleeps++;
        // The same head again (a repeated report) changes nothing; main merged in, a new head does.
        if (sleeps === 2) await handBackOn("a".repeat(40));
        if (sleeps === 4) await handBackOn("b".repeat(40));
      },
    });
    const got = await watchInbox(live.fleet, o);
    expect(got.items.map((e) => [e.id, e.kind, e.new])).toEqual([[shown?.items[0]?.id, "hand-back", true]]);
    expect(got.items[0]?.body).toContain(`head ${"b".repeat(40)}`);
    expect(live.clock.now().getTime() - NOW.getTime()).toBe(60_000);
    // Unchanged reads in between were answered 304.
    expect(live.statuses).toEqual([200, 200, 304, 304, 304, 200]);
  });

  test("with no worker in flight and nothing open, there is nothing to watch", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-1", COORDINATOR);
    const got = await watchInbox(live.fleet, options(live).o);
    expect([got.outcome, got.items, got.inFlight, live.statuses]).toEqual(["nothing", [], [], [200]]);
  });

  test("when the last worker is merged, the next read says so and the watch ends", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    let sleeps = 0;
    const { o } = options(live, {
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++sleeps === 2) await live.store.releaseRuntimeHandle(P, "DEMO-2", live.clock.now());
      },
    });
    const got = await watchInbox(live.fleet, o);
    expect([got.outcome, got.inFlight, live.statuses]).toEqual(["nothing", [], [200, 304, 200]]);
  });

  test("open items with no worker in flight are watched, slowly", async () => {
    const live = tempFleet();
    await handBack(live, "DEMO-2");
    const waits: number[] = [];
    let sleeps = 0;
    const shown = await live.fleet.inbox({ coordinator: COORDINATOR, silentAfterMinutes: 15, etag: null });
    const { o } = options(live, {
      seen: (shown?.items ?? []).map(entryKey),
      sleep: async (ms) => {
        waits.push(ms);
        await live.clock.sleep(ms);
        if (++sleeps === 2)
          await live.store.resolveInboxItems({
            project: P,
            ticket: "DEMO-2",
            kind: "hand-back",
            resolution: "merged",
            at: live.clock.now(),
          });
      },
    });
    const got = await watchInbox(live.fleet, o);
    expect([got.outcome, waits]).toEqual(["nothing", [60_000, 60_000]]);
  });

  test("a refusal ends the watch", async () => {
    const live = tempFleet({
      fail: () => Response.json({ error: "this sign-in was revoked" }, { status: 401 }),
    });
    await expect(watchInbox(live.fleet, options(live).o)).rejects.toThrow("this sign-in was revoked");
  });
});

describe("what the watch waits out", () => {
  test("Armada unreachable or failing, not a refusal or an answer it cannot read", () => {
    const api = (message: string, status: number | null = null) => new ArmadaApiError(message, null, false, status);
    expect(
      [
        api("Armada (a.test) unreachable: fetch failed"),
        api("Armada (a.test) answered HTTP 502 without JSON: is https://a.test an Armada?"),
        api("Armada refused: HTTP 503", 503),
        api("Armada refused: slow down", 429),
        api("not signed in to Armada", 401),
        api("Armada refused: the project belongs to another organization", 403),
        api("Armada (a.test) answered HTTP 200 without JSON: is https://a.test an Armada?"),
        api("Armada (a.test) answered fleet/inbox in a shape this CLI does not know"),
        new TypeError("x is undefined"),
      ].map(transientFailure),
    ).toEqual([true, true, true, true, false, false, false, false, false]);
  });
});

describe("the re-arm line", () => {
  test("says whether to start watching again", () => {
    expect(rearm({ inFlight: ["DEMO-2", "DEMO-3"], open: 0, running: null }).line).toBe(
      "2 workers in flight (DEMO-2, DEMO-3) — keep watching: armada watch",
    );
    expect(rearm({ inFlight: ["DEMO-2"], open: 1, running: null, act: true }).line).toBe(
      "1 worker in flight (DEMO-2) — act on the items above, then keep watching: armada watch",
    );
    expect(rearm({ inFlight: ["DEMO-2"], open: 0, running: 4242 }).line).toBe(
      "1 worker in flight (DEMO-2) — armada watch is already running (pid 4242).",
    );
    expect(rearm({ inFlight: [], open: 2, running: null }).line).toBe(
      "No worker in flight, 2 items open — keep watching: armada watch",
    );
    expect(rearm({ inFlight: [], open: 0, running: null }).line).toBe(
      "No worker in flight and nothing open — nothing to watch.",
    );
    expect(rearm({ inFlight: null, open: 0, running: null }).line).toBe(
      "While a worker is in flight, keep watching: armada watch",
    );
  });
});

describe("the stop hook", () => {
  const ROOT = "/work/widgets";
  const state = (over: Partial<WatchState> = {}): WatchState => ({
    ...EMPTY_WATCH_STATE,
    root: ROOT,
    inFlight: ["DEMO-2"],
    readAt: NOW.toISOString(),
    ...over,
  });
  const decide = (s: WatchState | null, over: Partial<Parameters<typeof stopHookDecision>[0]> = {}) =>
    stopHookDecision({ project: P, root: ROOT, state: s, watching: null, env: {}, ...over });

  test("blocks the coordinator's checkout while a worker is in flight and no watch runs", () => {
    const d = decide(state());
    expect(d.block).toBe(true);
    if (d.block) {
      expect(d.reason).toContain("1 worker in flight on widgets (DEMO-2) and no armada watch is running");
      expect(d.reason).toContain("Start `armada watch` in the background now");
      expect(d.reason).toContain("ARMADA_STOP_HOOK=off turns this hook off");
    }
  });

  test("allows otherwise", () => {
    const why = (d: ReturnType<typeof decide>) => (d.block ? "blocked" : d.why);
    expect(why(decide(state(), { watching: 4242 }))).toBe("armada watch is running (pid 4242)");
    expect(why(decide(state({ inFlight: [] })))).toBe("no worker in flight at the last read");
    expect(why(decide(state({ inFlight: null })))).toBe("no worker in flight at the last read");
    expect(why(decide(state(), { root: "/work/widgets-worker" }))).toBe(
      "the coordinator's checkout is /work/widgets, not this one",
    );
    expect(why(decide(null))).toBe("armada watch never ran for widgets on this machine");
    expect(why(decide(state({ root: null })))).toBe("armada watch never ran for widgets on this machine");
    expect(why(decide(state({ stopped: "signed out" })))).toBe("the last watch was refused: signed out");
    expect(why(decide(state(), { env: { ARMADA_STOP_HOOK: "off" } }))).toBe("ARMADA_STOP_HOOK=off");
    expect(decide(state(), { env: { ARMADA_STOP_HOOK: "on" } }).block).toBe(true);
  });
});
