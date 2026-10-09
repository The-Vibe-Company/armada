import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { entryKey, eventCursor, inboxTag } from "../src/live.ts";
import {
  coordinatorHabits,
  EMPTY_WATCH_STATE,
  followFleet,
  rearm,
  releaseEntry,
  stopHookDecision,
  stopHookState,
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
      "Armada (armada.example.test) unreachable: fetch failed (POST fleet/inbox); still watching, next try in 30 s",
    ]);
    // 200, 304, 503, (network), 304, then the hand-back.
    expect(live.statuses).toEqual([200, 304, 503, 304, 200]);
    // 15 s, 15 s, then 15 + 30 s of backing off, then 15 s.
    expect(clock.now().getTime() - NOW.getTime()).toBe(90_000);
    expect(reads).toEqual([["DEMO-2"], ["DEMO-2"]]);
  });

  for (const name of ["default", "front"]) {
    test(`${name} watch lists another owner's plan but waits for its own question`, async () => {
      const live = tempFleet();
      await live.store.saveRuntimeHandle({
        project: P,
        ticket: "DEMO-2",
        coordinator: "back",
        runtime: "conductor",
        handle: "ws/DEMO-2",
        branch: null,
        at: NOW,
      });
      await live.store.addInboxItem({
        project: P,
        ticket: "DEMO-2",
        kind: "plan",
        recipient: "coordinator",
        author: "ws/DEMO-2",
        body: "Review the plan",
        at: NOW,
      });
      let sleeps = 0;
      const { o } = options(live, {
        coordinatorName: name,
        scope: "all",
        release: () => null,
        sleep: async (ms) => {
          await live.clock.sleep(ms);
          if (++sleeps === 1) {
            await live.store.saveRuntimeHandle({
              project: P,
              ticket: "DEMO-3",
              coordinator: name,
              runtime: "conductor",
              handle: "ws/DEMO-3",
              branch: null,
              at: live.clock.now(),
            });
            await live.store.addInboxItem({
              project: P,
              ticket: "DEMO-3",
              kind: "question",
              recipient: "coordinator",
              author: "ws/DEMO-3",
              body: "Which table?",
              at: live.clock.now(),
            });
          }
        },
      });
      const got = await watchInbox(live.fleet, o);
      expect(sleeps).toBe(1);
      expect(got.items).toMatchObject([
        { kind: "plan", owner: "back" },
        { kind: "question", owner: name, new: true },
      ]);
    });
  }

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
    expect(got.items.map((e) => [e.id, e.kind, e.new])).toEqual([[shown?.items[0]?.id ?? 0, "hand-back", true]]);
    expect(got.items[0]?.body).toContain(`head ${"b".repeat(40)}`);
    expect(live.clock.now().getTime() - NOW.getTime()).toBe(60_000);
    // Unchanged reads in between were answered 304.
    expect(live.statuses).toEqual([200, 200, 304, 304, 304, 200]);
  });

  test("a required upgrade ends the watch, after the open items", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    await handBack(live, "DEMO-2");
    const shown = await live.fleet.inbox({ coordinator: COORDINATOR, silentAfterMinutes: 15, etag: null });
    let latest: string | null = null;
    let sleeps = 0;
    const { o } = options(live, {
      seen: (shown?.items ?? []).map(entryKey),
      // The server names 0.2.4 from its second answer on.
      release: () => (latest ? releaseEntry("0.2.3", latest, live.clock.now()) : null),
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++sleeps === 2) latest = "0.2.4";
      },
    });
    const got = await watchInbox(live.fleet, o);
    expect(got.items.map((e) => [e.kind, e.ticket, e.new])).toEqual([
      ["hand-back", "DEMO-2", false],
      ["version", null, true],
    ]);
    const version = got.items[1];
    expect(version && entryKey(version)).toContain("version:0.2.4@");
    expect(version?.body).toContain("https://github.com/The-Vibe-Company/armada/releases/tag/v0.2.4");
    expect(version?.body).toContain("npm install -g @the-vibe-company/armada@0.2.4");
    expect(version?.body).toContain("armada upgrade");
    expect(version?.body).not.toContain("armada init");
    // Woken on the first read after the release, not before.
    expect(live.clock.now().getTime() - NOW.getTime()).toBe(30_000);
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
      "1 worker in flight (DEMO-2) — armada watch is running (pid 4242); starting another waits for its result.",
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

describe("stop hook state", () => {
  const receipt = { at: NOW.toISOString(), project: P, why: "blocked" };
  const installed = "/home/coordinator/.claude/settings.json";
  const state = (o: Partial<Parameters<typeof stopHookState>[0]> = {}) =>
    stopHookState({ env: {}, sessionId: "s", hookRun: null, installedIn: null, ...o });

  test("receipts distinguish a loaded hook from installation and identity failures", () => {
    for (const why of [
      "blocked",
      "no worker in flight at the last read",
      "armada watch is running (pid 42)",
      "no worker in flight at the last read; armada watch is running (pid 42)",
    ]) {
      expect(state({ hookRun: { ...receipt, why } })).toMatchObject({ state: "on", fix: null });
    }
    for (const why of [
      "the coordinator's checkout is /old, not this one",
      "the last watch was refused: signed out",
      "could not read the coordinator's local hook state or project",
    ]) {
      expect(state({ hookRun: { ...receipt, why }, installedIn: installed })).toMatchObject({ state: "off", why });
    }
    expect(state({ installedIn: installed })).toEqual({
      state: "installed",
      why: installed,
      fix: "it confirms at your next turn end",
    });
    expect(state().fix).toContain("~/.claude/settings.json");
    expect(state({ sessionId: null, hookRun: receipt }).state).toBe("off");
    expect(state({ hookRun: { ...receipt, at: "bad time" } }).state).toBe("off");
  });

  test("explicit opt-out and worker identity override a successful receipt", () => {
    for (const value of ["off", "0", "FALSE"]) {
      expect(state({ env: { ARMADA_STOP_HOOK: value }, hookRun: receipt })).toMatchObject({
        state: "off",
        why: "off by choice",
      });
    }
    expect(state({ env: { ARMADA_TICKET: "DEMO-2" }, hookRun: receipt }).why).toBe("this is a worker session");
  });
});

describe("follow", () => {
  test("question then hand-back keep the stream running, acknowledge after print and restart without repeats", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    let step = 0;
    const saved: { seen: string[]; cursor: string; eventIds: number[] }[] = [];
    const o = options(live, {
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++step === 1) await live.fleet.ask({ ticket: "DEMO-2", body: "Which table?" });
        if (step === 2) await handBack(live, "DEMO-2");
      },
    }).o;
    const stream = followFleet(live.fleet, {
      ...o,
      until: new Date(NOW.getTime() + 60000),
      onPrinted: async (s) => {
        saved.push(s);
      },
    });
    expect((await stream.next()).value).toMatchObject({ kind: "question", new: true });
    expect(saved).toHaveLength(0);
    expect((await stream.next()).value).toMatchObject({ kind: "hand-back", new: true });
    expect(saved).toHaveLength(1);
    expect((await stream.next()).done).toBe(true);
    expect(step).toBe(4);
    const state = saved.at(-1);
    if (!state) throw new Error("no printed state saved");
    const restarted = followFleet(live.fleet, { ...o, ...state, until: new Date(live.clock.now().getTime() + 15000) });
    expect((await restarted.next()).done).toBe(true);
    expect(live.statuses).toContain(304);
  });

  test("look-back finds a late commit once, pages forward and respects ticket/kind filters", async () => {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    let step = 0;
    const stream = followFleet(live.fleet, {
      ...options(live).o,
      kinds: ["report"],
      tickets: ["DEMO-2"],
      cursor: eventCursor(0, NOW.toISOString()),
      until: new Date(NOW.getTime() + 45000),
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++step === 1) {
          for (let i = 0; i < 205; i++)
            await live.store.recordEvent({
              project: P,
              ticket: "DEMO-2",
              kind: "report",
              message: `event ${i}`,
              at: live.clock.now(),
            });
          await live.store.recordEvent({ project: P, ticket: "DEMO-3", kind: "report", at: live.clock.now() });
          await live.store.recordEvent({ project: P, ticket: "DEMO-2", kind: "heartbeat", at: live.clock.now() });
        }
        if (step === 2)
          await live.store.recordEvent({
            project: P,
            ticket: "DEMO-2",
            kind: "report",
            message: "late",
            at: new Date(NOW.getTime() + 10000),
          });
      },
    });
    const lines = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toHaveLength(206);
    expect(lines.at(-1)?.body).toBe("late");
    expect(new Set(lines.map((l) => l.id)).size).toBe(206);
    expect(lines.at(-1)?.cursor).toBe(lines.at(-2)?.cursor);
  });
});

test("follow state alarms can recur after clearing and idle never ends an unbounded follow", async () => {
  const live = tempFleet();
  const alarm = {
    id: null,
    kind: "silent" as const,
    ticket: "DEMO-2",
    author: null,
    body: "worker silent",
    createdAt: NOW.toISOString(),
    new: false,
  };
  let reads = 0;
  const stream = followFleet(
    {
      ...live.fleet,
      inbox: async () => ({
        items: ++reads === 2 ? [] : [alarm],
        inFlight: ["DEMO-2"],
        etag: String(reads),
        warnings: [],
      }),
    },
    { ...options(live).o, until: new Date(NOW.getTime() + 45000) },
  );
  expect((await stream.next()).value).toMatchObject({ kind: "silent" });
  expect((await stream.next()).value).toMatchObject({ kind: "silent", new: true });
  expect((await stream.next()).done).toBe(true);

  const abort = new AbortController();
  let idles = 0;
  const pending = followFleet(live.fleet, {
    ...options(live).o,
    signal: abort.signal,
    onIdle: () => {
      idles++;
    },
    sleep: async (ms) => {
      expect(ms).toBe(60000);
      abort.abort(new Error("test stopped"));
    },
  }).next();
  await expect(pending).rejects.toThrow("test stopped");
  expect(idles).toBe(1);
});

test("handover filters ordinary reports on the server and returns304 between handovers", async () => {
  const live = tempFleet();
  await holding(live, "DEMO-2");
  let step = 0;
  const lines = [];
  for await (const line of followFleet(live.fleet, {
    ...options(live).o,
    kinds: ["handover"],
    until: new Date(NOW.getTime() + 60000),
    sleep: async (ms) => {
      await live.clock.sleep(ms);
      if (++step === 1)
        await live.store.recordEvent({
          project: P,
          ticket: "DEMO-2",
          kind: "report",
          phase: "implementing",
          at: live.clock.now(),
        });
      if (step === 3)
        await live.store.recordEvent({
          project: P,
          ticket: "DEMO-2",
          kind: "report",
          phase: "ready-to-merge",
          at: live.clock.now(),
        });
    },
  }))
    lines.push(line);
  expect(lines.map((l) => l.kind)).toEqual(["handover"]);
  expect(live.statuses.filter((s) => s === 200)).toHaveLength(2); // initial inbox and the handover
});

test("follow retains the highest500 identities through late commits and further bursts", async () => {
  const live = tempFleet();
  await holding(live, "DEMO-2");
  let step = 0;
  const lines = [];
  for await (const line of followFleet(live.fleet, {
    ...options(live).o,
    kinds: ["report"],
    until: new Date(NOW.getTime() + 75000),
    sleep: async (ms) => {
      await live.clock.sleep(ms);
      if (++step === 1)
        for (let i = 0; i < 1000; i++)
          await live.store.recordEvent({
            project: P,
            ticket: "DEMO-2",
            kind: "report",
            message: String(i),
            at: live.clock.now(),
          });
      if (step === 2)
        await live.store.recordEvent({
          project: P,
          ticket: "DEMO-2",
          kind: "report",
          message: "late",
          at: new Date(NOW.getTime() + 10000),
        });
      if (step === 3)
        for (let i = 0; i < 251; i++)
          await live.store.recordEvent({
            project: P,
            ticket: "DEMO-2",
            kind: "report",
            message: `more ${i}`,
            at: live.clock.now(),
          });
    },
  }))
    lines.push(line);
  expect(lines).toHaveLength(1252);
  expect(new Set(lines.map((l) => l.id)).size).toBe(1252);
  expect(lines.filter((l) => l.body === "late")).toHaveLength(1);
  expect(live.statuses.slice(-2)).toEqual([304, 304]);
});

test("cross-machine resume recovers higher IDs with older timestamps and later commits without a cache", async () => {
  const live = tempFleet();
  await holding(live, "DEMO-2");
  await live.store.recordEvent({
    project: P,
    ticket: "DEMO-2",
    kind: "report",
    at: new Date(NOW.getTime() + 20000),
    message: "printed",
  });
  const cursor = eventCursor(2, new Date(NOW.getTime() + 20000).toISOString());
  await live.store.recordEvent({
    project: P,
    ticket: "DEMO-2",
    kind: "report",
    at: new Date(NOW.getTime() + 10000),
    message: "late before resume",
  });
  let step = 0;
  const lines = [];
  for await (const line of followFleet(live.fleet, {
    ...options(live).o,
    cursor,
    kinds: ["report"],
    until: new Date(NOW.getTime() + 45000),
    sleep: async (ms) => {
      await live.clock.sleep(ms);
      if (++step === 1)
        await live.store.recordEvent({
          project: P,
          ticket: "DEMO-2",
          kind: "report",
          at: new Date(NOW.getTime() + 15000),
          message: "late after resume",
        });
    },
  }))
    lines.push(line);
  expect(lines.map((l) => l.body)).toEqual(["late before resume", "late after resume"]);
  expect(lines.every((l) => l.cursor === cursor)).toBe(true);
  expect(live.statuses.slice(-2)).toEqual([304, 304]);
});

test("a kill during historical baseline seeding resumes the seed without replaying old lines", async () => {
  const live = tempFleet();
  await holding(live, "DEMO-2");
  for (let i = 0; i < 205; i++)
    await live.store.recordEvent({
      project: P,
      ticket: "DEMO-2",
      kind: "report",
      message: `old ${i}`,
      at: new Date(NOW.getTime() - 1000),
    });
  let checkpoint:
    | { seen: string[]; cursor: string; eventIds: number[]; baselinePending: boolean; freshStart: boolean }
    | undefined;
  const cursor = eventCursor(0, NOW.toISOString());
  const first = followFleet(live.fleet, {
    ...options(live).o,
    cursor,
    freshStart: true,
    kinds: ["report"],
    onPrinted: async (state) => {
      checkpoint = state;
      throw new Error("killed while seeding");
    },
  });
  await expect(first.next()).rejects.toThrow("killed while seeding");
  if (!checkpoint) throw new Error("no baseline checkpoint");
  expect(checkpoint.baselinePending).toBe(true);
  const restarted = followFleet(live.fleet, {
    ...options(live).o,
    ...checkpoint,
    kinds: ["report"],
    until: new Date(NOW.getTime() + 15000),
  });
  expect((await restarted.next()).done).toBe(true);
});

test("follow includes a stopped session by default and when filtered, without repeating it", async () => {
  for (const kinds of [undefined, ["stopped"]] as const) {
    const live = tempFleet();
    await holding(live, "DEMO-2");
    await live.fleet.observeRuntime({
      ticket: "DEMO-2",
      handle: "ws/DEMO-2",
      claimedAt: NOW.toISOString(),
      state: "idle",
    });
    live.clock.advance(5 * 60_000 + 1);
    const lines = [];
    for await (const line of followFleet(live.fleet, {
      ...options(live).o,
      ...(kinds ? { kinds } : {}),
      until: new Date(live.clock.now().getTime() + 45_000),
    }))
      lines.push(line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "stopped",
      ticket: "DEMO-2",
      body: expect.stringContaining("its session is idle and it did not hand back"),
    });
  }
});

test("follow shows initial and new holds until cleared, by default and when filtered", async () => {
  for (const kinds of [undefined, ["hold"]] as const) {
    const live = tempFleet();
    const first = await live.fleet.openHold({ kind: "manual", reason: "initial pause" });
    let step = 0;
    let laterId = 0;
    const lines = [];
    for await (const line of followFleet(live.fleet, {
      ...options(live).o,
      ...(kinds ? { kinds } : {}),
      until: new Date(NOW.getTime() + 180_000),
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++step === 1) await live.fleet.clearHold({ id: first.id, reason: "verified first fix" });
        if (step === 2) laterId = (await live.fleet.openHold({ kind: "manual", reason: "new pause" })).id;
        if (step === 3) await live.fleet.clearHold({ id: laterId, reason: "verified next fix" });
      },
    }))
      lines.push(line);
    expect(lines.map((line) => [line.kind, line.new])).toEqual([
      ["hold", false],
      ["hold", true],
    ]);
    expect(lines[0]?.body).toContain(`initial pause (manual, hold #${first.id})`);
    expect(lines[1]?.body).toContain(`new pause (manual, hold #${laterId})`);
    expect(await live.fleet.holds()).toEqual([]);
  }
});

test("external job liveness keeps worker ownership accurate in rearm and the stop hook", () => {
  expect(rearm({ inFlight: [], openJobs: [12], open: 0, running: null }).line).toBe(
    "1 open job (12) — keep watching: armada watch",
  );
  expect(rearm({ inFlight: [], openJobs: [12], open: 0, running: null, slots: { taken: 0, max: 2 } }).line).toBe(
    "1 open job (12) — keep watching: armada watch · 0 of 2 workers in flight",
  );
  const state = { ...EMPTY_WATCH_STATE, root: "/synthetic", inFlight: [], openJobs: [12] };
  const decision = stopHookDecision({ project: "widgets", root: "/synthetic", state, watching: null, env: {} });
  expect(decision.block).toBe(true);
  if (decision.block) expect(decision.reason).toContain("open job");
});

test("follow sees coalesced deploy notice updates through inbox ETags, by default and filtered", async () => {
  for (const kinds of [undefined, ["deploy"]] as const) {
    const live = tempFleet();
    const sha = "a".repeat(40),
      next = "b".repeat(40);
    const failure = { target: "api", sha, state: "timeout" as const, detail: "build output", pauseOnFailure: true };
    await live.fleet.recordDeploy(failure);
    let step = 0;
    const lines = [];
    for await (const line of followFleet(live.fleet, {
      ...options(live).o,
      ...(kinds ? { kinds } : {}),
      until: new Date(NOW.getTime() + 150_000),
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (++step === 1) await live.fleet.recordDeploy({ ...failure, sha: next, detail: "new build output" });
      },
    }))
      lines.push(line);
    expect(lines.map((line) => [line.kind, line.new])).toEqual([
      ["deploy", false],
      ["deploy", true],
    ]);
    expect(lines[0]?.body).toContain(sha);
    expect(lines[1]?.body).toContain(next);
    expect(lines[1]?.body).toContain("new build output");
    expect(await live.store.openInboxItems({ project: P, recipient: "coordinator" })).toHaveLength(1);
  }
});

test("coordinator habits match Bash results, ignore backgrounds and tolerate unknown transcript lines", () => {
  const line = (type: string, timestamp: string, content: unknown[]) =>
    JSON.stringify({ type, timestamp, message: { content } });
  const use = (id: string, command: string, background = false) =>
    line("assistant", "2026-01-01T10:00:00Z", [
      { type: "tool_use", id, name: "Bash", input: { command, run_in_background: background } },
    ]);
  const result = (id: string, timestamp = "2026-01-01T10:00:01Z") =>
    line("user", timestamp, [{ type: "tool_result", tool_use_id: id, content: "synthetic output" }]);
  const lines = [
    "not JSON",
    "null",
    JSON.stringify({ type: "worker", command: "git commit" }),
    use("long", "bun run verify"),
    result("long", "2026-01-01T10:01:05Z"),
    use("merge", "gh pr merge 12 --squash"),
    result("merge"),
    use("wrapped", "armada launch DEMO-2 | tail -5"),
    result("wrapped"),
    use("code", "git commit -m 'fix(cli): repair'"),
    result("code"),
    use("background", "armada watch", true),
    result("background", "2026-01-01T10:05:00Z"),
    use("short", "armada status"),
    result("short", "2026-01-01T10:01:00Z"),
    use("unfinished", "gh pr merge 13"),
  ];
  expect(coordinatorHabits(lines, {})).toEqual([
    { rule: "foreground", command: "bun run verify", seconds: 65 },
    { rule: "raw-merge", command: "gh pr merge 12 --squash", pr: 12 },
    { rule: "wrapped", command: "armada launch DEMO-2 | tail -5" },
    { rule: "own-code", command: "git commit -m 'fix(cli): repair'" },
  ]);
  expect(coordinatorHabits(lines, { since: "2026-01-01T10:06:00Z" })).toEqual([]);
  for (const command of [
    "armada status | grep ready",
    "armada inbox | head -1",
    "armada status > /dev/null",
    "armada watch 2>&1 | cat",
    "armada launch DEMO-3 || true",
  ]) {
    expect(coordinatorHabits([use("w", command), result("w")], {})).toEqual([{ rule: "wrapped", command }]);
  }
  for (const command of [
    "printf '%s\\n' 'git commit'",
    "echo 'gh pr merge 12'",
    "rg 'armada status | tail'",
    "cat <<'EOF'\ngit commit\ngh pr merge 12\narmada status | tail\nEOF",
    "cat <<EOF\n EOF \ngh pr merge 12\nEOF",
    "cat <<123\ngh pr merge 12\n123",
    "cat <<-EOF\n\t EOF\ngh pr merge 12\n\tEOF",
    "echo \\\ngh pr merge 12",
    "echo done # gh pr merge 12",
  ]) {
    expect(coordinatorHabits([use("example", command), result("example")], {})).toEqual([]);
  }
  expect(coordinatorHabits([use("real", "echo 'gh pr merge 12'; gh pr merge 14"), result("real")], {})).toEqual([
    { rule: "raw-merge", command: "echo 'gh pr merge 12'; gh pr merge 14", pr: 14 },
  ]);
  expect(coordinatorHabits([use("pr", "gh pr create --title fix"), result("pr")], {})).toEqual([
    { rule: "own-code", command: "gh pr create --title fix" },
  ]);
  for (const command of ["cat <<-123\n\tdata\n\t123\ngh pr merge 14", "g\\\nh pr merge 14"]) {
    expect(coordinatorHabits([use("real", command), result("real")], {})).toEqual([
      { rule: "raw-merge", command, pr: 14 },
    ]);
  }
  for (const run_in_background of ["true", null, 1, {}]) {
    const unknown = line("assistant", "2026-01-01T10:00:00Z", [
      { type: "tool_use", id: "unknown", name: "Bash", input: { command: "gh pr merge 12", run_in_background } },
    ]);
    expect(coordinatorHabits([unknown, result("unknown", "2026-01-01T10:01:01Z")])).toEqual([]);
  }
});

test("waiting launches keep watch alive without inflating its workers or releasing the stop hook", async () => {
  const live = tempFleet();
  await live.store.addRequest({
    project: P,
    ticket: "DEMO-9",
    kind: "launch-request",
    author: "Ada",
    body: "waiting",
    question: null,
    profile: null,
    deferred: true,
    at: live.clock.now(),
  });
  const { o } = options(live, { until: new Date(live.clock.now().getTime() + 30_000) });
  const report = await watchInbox(live.fleet, o);
  expect(report.outcome).toBe("timeout");
  expect(report.inFlight).toEqual([]);
  expect(report.waiting).toEqual(["DEMO-9"]);
  const state = { ...EMPTY_WATCH_STATE, root: "/work", inFlight: [], waiting: report.waiting };
  expect(stopHookDecision({ project: P, root: "/work", state, watching: null, env: {} }).block).toBe(true);
  const combined = stopHookDecision({
    project: P,
    root: "/work",
    state,
    watching: null,
    env: {},
    habits: [{ rule: "own-code", command: "git commit -m fix" }],
  });
  expect(combined.block && combined.reason).toContain("waiting to launch");
  expect(combined.block && combined.reason).toContain("cut a ticket and launch a worker");
  expect(
    rearm({
      inFlight: ["DEMO-2", "DEMO-3", "DEMO-4"],
      slots: { taken: 3, max: 10 },
      waiting: 2,
      open: 0,
      running: null,
    }).line,
  ).toContain("3 of 10 workers in flight (DEMO-2, DEMO-3, DEMO-4) · 2 waiting to launch");
});

test("waiting-only re-arm omits an empty worker ticket list", () => {
  expect(rearm({ inFlight: [], slots: { taken: 0, max: 1 }, waiting: 1, open: 0, running: null }).line).toBe(
    "0 of 1 workers in flight · 1 waiting to launch — keep watching: armada watch",
  );
});
