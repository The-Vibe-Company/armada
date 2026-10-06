import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, askCoordinator, checkInbox } from "../src/inbox.ts";
import { type FleetStore, type HandBackSnapshot, readInbox, serveInbox } from "../src/live.ts";
import { buildStatus } from "../src/status.ts";
import type { ProgramData } from "../src/types.ts";
import { watchInbox } from "../src/watch.ts";
import { claimTicket, Refusal, releaseTicket, reportPhase, type WorkerContext } from "../src/worker.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_TOML, FakeLinear, fakeClock, issue, NOW, tempFleet } from "./support.ts";

const config = parseConfig(DEMO_TOML);
const P = "widgets";
const at = (minutesBeforeNow: number) => new Date(NOW.getTime() - minutesBeforeNow * 60_000);

function setup(live: ReturnType<typeof tempFleet> | null) {
  const linear = new FakeLinear();
  const ctx: WorkerContext = {
    config,
    linear,
    fleet: async () =>
      live ? { fleet: live.fleet, warning: null } : { fleet: null, warning: "not signed in to Armada" },
    readPull: null,
    now: () => NOW,
  };
  return { linear, ctx };
}

async function working(ctx: WorkerContext, linear: FakeLinear, id: string) {
  linear.add(id);
  await claimTicket(ctx, { ticket: id, runtime: "conductor", handle: `ws/${id}` });
  await reportPhase(ctx, { ticket: id, phase: "implementing", message: "plan approved" });
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => {
      if (!(err instanceof Refusal)) throw err;
      return `${err.message}\nNext: ${err.next}`;
    },
  );

const inbox = (db: FleetStore) => readInbox(db, { project: P, silentAfterMinutes: 15, now: NOW });

describe("ask and answer", () => {
  test("a coordinator can resolve Linear follow-up work without reading or writing Linear", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup(live);
    await live.fleet.chore({ ticket: "DEMO-7", kind: "linear-pending", pr: 11, body: "Finish Linear for #11" });
    // The ticket does not exist in FakeLinear: a tracker read here would fail.
    const item = (await live.fleet.ticketItems("DEMO-7"))[0];
    if (!item) throw new Error("missing chore");
    expect((await answerItem(ctx, { target: `#${item.id}`, text: "Completed by hand" })).lines).toEqual([
      `Inbox item #${item.id} resolved.`,
    ]);
    expect((await live.fleet.inboxItem(item.id))?.resolvedAt).toBe(NOW.toISOString());
    expect(linear.writes).toEqual([]);
  });
  test("answering steering requests closes only the request, never approves the plan or acts on Linear", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup(live);
    await live.store.putPlan({ project: P, ticket: "DEMO-7", author: "worker", body: "Original plan", at: NOW });
    const plan = (await live.store.openInboxItems({ project: P, recipient: "coordinator" }))[0];
    if (!plan) throw new Error("missing plan");
    for (const kind of ["merge-request", "release-request", "plan-changes"] as const) {
      const id = await live.store.addRequest({
        project: P,
        ticket: kind === "merge-request" ? null : "DEMO-7",
        kind,
        author: "Synthetic Owner",
        body: "Please handle this request",
        question: kind === "plan-changes" ? plan.id : null,
        profile: null,
        pr: kind === "merge-request" ? 11 : null,
        at: NOW,
      });
      if (id === null) throw new Error("missing request");
      expect((await answerItem(ctx, { target: `#${id}`, text: "Delivered to the coordinator" })).lines).toContain(
        `Inbox item #${id} resolved.`,
      );
      expect((await live.store.getInboxItem(P, id))?.resolvedAt).toBe(NOW.toISOString());
    }
    expect((await live.store.getInboxItem(P, plan.id))?.resolvedAt).toBeNull();
    expect(linear.writes).toEqual([]);
  });

  test("a question blocks the worker, reaches the inbox and the ticket; the answer closes it in both", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    await working(ctx, linear, "DEMO-7");

    const asked = await askCoordinator(ctx, {
      ticket: "DEMO-7",
      question: "Which store keeps the sessions?\nBoth work with the current schema.",
      options: ["SQLite (recommended)", " Redis "],
    });
    const t = linear.get("DEMO-7");
    expect(t.labels.map((l) => l.name)).toEqual(["Conductor", "blocked"]);
    expect(t.comments[0]?.status).toEqual({ phase: "blocked", summary: "question: Which store keeps the sessions?" });
    const body =
      "Which store keeps the sessions?\nBoth work with the current schema.\n\nOptions:\n1. SQLite (recommended)\n2. Redis";
    expect(asked.item).toBe(1);
    expect(await inbox(db)).toEqual([
      {
        id: 1,
        kind: "question",
        ticket: "DEMO-7",
        author: "ws/DEMO-7",
        body,
        createdAt: NOW.toISOString(),
        new: false,
      },
    ]);

    const answered = await answerItem(ctx, { target: "#1", text: "SQLite.\nKeep Redis out of the first slice." });
    expect(t.labels.map((l) => l.name)).toEqual(["Conductor", "blocked"]);
    // The answer is on the ticket, but it is the coordinator's record, not the worker's status.
    const posted = linear.get("DEMO-7").comments[0];
    expect([posted?.status, posted?.excerpt]).toEqual([
      null,
      "Agent status: blocked — answer: SQLite. Keep Redis out of the first slice. Answers question 1.",
    ]);
    expect(answered.lines).toContain("Inbox item #1 resolved.");
    expect(await inbox(db)).toEqual([]);
    expect(await db.getInboxItem(P, 1)).toMatchObject({
      resolvedAt: NOW.toISOString(),
      resolution: "SQLite.\nKeep Redis out of the first slice.",
    });
    expect(await refusal(answerItem(ctx, { target: "1", text: "again" }))).toBe(
      `inbox item #1 was already resolved at ${NOW.toISOString()}\nNext: armada inbox`,
    );

    // The worker resumes where it stood.
    await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "resumed with SQLite" });
    expect(t.labels.map((l) => l.name)).toEqual(["Conductor", "implementing"]);
  });

  test("answering a ticket resolves its open questions; a note is recorded, never left open", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    await working(ctx, linear, "DEMO-7");
    await askCoordinator(ctx, { ticket: "DEMO-7", question: "First?" });
    await askCoordinator(ctx, { ticket: "DEMO-7", question: "Second?" });

    expect((await answerItem(ctx, { target: "demo-7", text: "Both: yes." })).lines).toContain(
      "2 open questions of DEMO-7 resolved.",
    );
    expect(await refusal(answerItem(ctx, { target: "DEMO-7", text: "Yes." }))).toContain(
      "DEMO-7 has no open question or plan in the inbox",
    );

    await answerItem(ctx, { target: "DEMO-7", text: "main moved: rebase before you ship", note: true });
    expect(linear.get("DEMO-7").comments[0]?.excerpt).toStartWith(
      "Agent status: blocked — note: main moved: rebase before you ship",
    );
    expect(await db.getInboxItem(P, 3)).toMatchObject({
      kind: "note",
      recipient: "worker",
      resolution: "delivered through the runtime",
    });
    expect(await inbox(db)).toEqual([]);
    expect(await refusal(answerItem(ctx, { target: "3", text: "x", note: true }))).toContain("a note goes to a ticket");
    await db.putHandBack({ project: P, ticket: "DEMO-7", author: null, body: "handed back", at: NOW });
    expect(await refusal(answerItem(ctx, { target: "4", text: "ok" }))).toBe(
      "inbox item #4 is a hand-back: armada merge resolves it once the pull request is merged\nNext: armada merge <pr> --ticket DEMO-7 --dry-run",
    );
  });

  test.each(["merged", "closed", "open", "unknown", "completed", "canceled"] as const)(
    "answer resolves only a confirmed stale hand-back (%s)",
    async (state) => {
      const live = tempFleet();
      const { linear, ctx } = setup(live);
      linear.add("DEMO-7", { statusType: state === "completed" || state === "canceled" ? state : "started" });
      await live.store.putHandBack({
        project: P,
        ticket: "DEMO-7",
        author: null,
        body: "Agent status: ready-to-merge — PR #9, head abc",
        at: NOW,
      });
      const reads: number[] = [];
      ctx.readPull = async (number) => {
        reads.push(number);
        return {
          number,
          repo: "acme/widgets",
          url: "https://github.com/acme/widgets/pull/9",
          title: "Synthetic PR",
          state: state === "merged" || state === "closed" ? state : "open",
        };
      };
      if (state === "unknown") ctx.readPull = null;
      if (state === "open" || state === "unknown") {
        expect(await refusal(answerItem(ctx, { target: "1", text: "already handled" }))).toContain(
          "Next: armada merge 9 --ticket DEMO-7 --dry-run",
        );
        expect((await live.store.getInboxItem(P, 1))?.resolvedAt).toBeNull();
      } else {
        expect((await answerItem(ctx, { target: "1", text: "already handled" })).lines).toContain(
          "Inbox item #1 resolved.",
        );
        expect(await live.store.getInboxItem(P, 1)).toMatchObject({
          resolution: "already handled",
          resolvedAt: NOW.toISOString(),
        });
        if (state === "completed" || state === "canceled") expect(reads).toEqual([]);
      }
      expect(linear.writes).toEqual([]);
      expect(await live.store.openInboxItems({ project: P, recipient: "worker" })).toEqual([]);
    },
  );

  test("without Armada a question still blocks the ticket; an item id cannot be answered, a ticket can", async () => {
    const { linear, ctx } = setup(null);
    await working(ctx, linear, "DEMO-7");
    const asked = await askCoordinator(ctx, { ticket: "DEMO-7", question: "Which store?" });
    expect([asked.item, linear.get("DEMO-7").comments[0]?.status?.phase]).toEqual([null, "blocked"]);
    expect(await refusal(answerItem(ctx, { target: "4", text: "SQLite" }))).toContain("answer by ticket instead");
    const out = await answerItem(ctx, { target: "DEMO-7", text: "SQLite" });
    expect([out.lines[0], out.warnings]).toEqual(["Answer posted on DEMO-7 (blocked).", ["not signed in to Armada"]]);
  });

  test("releasing a ticket resolves its open questions", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    await working(ctx, linear, "DEMO-7");
    await askCoordinator(ctx, { ticket: "DEMO-7", question: "Which store?" });
    await releaseTicket(ctx, { ticket: "DEMO-7", reason: "wrong ticket" });
    expect(await inbox(db)).toEqual([]);
  });
});

describe("the coordinator's inbox", () => {
  test("inbox and status ignore a completed merge's stale handle and agree on live work", async () => {
    const db = memoryFleet();
    const program: ProgramData = {
      rootId: "DEMO-1",
      fetchedAt: at(10).toISOString(),
      issues: [
        issue("DEMO-1"),
        issue("DEMO-2", { parentId: "DEMO-1", statusType: "completed" }),
        issue("DEMO-3", { parentId: "DEMO-1", statusType: "canceled" }),
        issue("DEMO-4", { parentId: "DEMO-1", statusType: "started", agentPhase: "implementing" }),
        issue("DEMO-5", { parentId: "DEMO-1", statusType: "started", agentPhase: "implementing" }),
        issue("DEMO-6", { parentId: "DEMO-1", statusType: "started", agentPhase: "ready-to-merge" }),
        issue("DEMO-7", { parentId: "DEMO-1" }),
        issue("DEMO-8", { parentId: "DEMO-1", statusType: "started", agentPhase: "implementing" }),
        issue("DEMO-9", { parentId: "DEMO-1", statusType: "started", agentPhase: "implementing" }),
      ],
      comments: [],
      warnings: [],
    };
    // The merge updated Linear, but a network failure left the runtime handle open.
    // A later report can also hide the merge in the latest-event reading.
    for (const ticket of ["DEMO-2", "DEMO-3", "DEMO-4", "DEMO-5", "DEMO-6", "DEMO-7"])
      await db.saveRuntimeHandle({
        project: P,
        ticket,
        runtime: "Conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: at(20),
      });
    await db.recordEvent({ project: P, ticket: "DEMO-2", kind: "report", phase: "ready-to-merge", at: at(5) });
    await db.recordEvent({ project: P, ticket: "DEMO-5", kind: "release", at: at(5) });
    await db.releaseRuntimeHandle(P, "DEMO-5", at(5));
    await db.recordEvent({ project: P, ticket: "DEMO-6", kind: "merge", phase: "merged", at: at(5) });
    await db.recordEvent({ project: P, ticket: "DEMO-7", kind: "claim", phase: "planning", at: at(5) });
    // A replacement claim must survive an older merge in the same reading.
    await db.recordEvent({ project: P, ticket: "DEMO-9", kind: "merge", phase: "merged", at: at(5) });
    await db.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-9",
      runtime: "Conductor",
      handle: "ws/new-claim",
      branch: null,
      at: at(3),
    });
    const snapshot: HandBackSnapshot = {
      repository: "acme/widgets",
      issues: program.issues,
      prs: [],
      flight: { program, forge: null, after: program.fetchedAt },
    };
    const query = { coordinator: null, silentAfterMinutes: 15, etag: null };
    const before = await serveInbox(db, P, query, NOW);
    expect(before?.inFlight).toContain("DEMO-2");
    const read = await serveInbox(db, P, { ...query, etag: before?.etag ?? null }, NOW, null, snapshot);
    const events = await db.latestEvents(P);
    const handles = Object.fromEntries((await db.openRuntimeHandles(P)).map((h) => [h.ticket, h]));
    const status = buildStatus({
      config,
      program,
      forge: null,
      live: { after: program.fetchedAt, events, handles },
      now: NOW,
    });
    expect(read?.inFlight).toEqual(status.inFlight.map((t) => t.id).sort());
    expect(read?.inFlight).toEqual(["DEMO-4", "DEMO-7", "DEMO-8", "DEMO-9"]);
    expect(read?.items.some((entry) => ["DEMO-2", "DEMO-3", "DEMO-5", "DEMO-6"].includes(entry.ticket ?? ""))).toBe(
      false,
    );
    expect((await db.getRuntimeHandle(P, "DEMO-2"))?.releasedAt).toBeNull();
    expect(await serveInbox(db, P, { ...query, etag: read?.etag ?? null }, NOW, null, snapshot)).toBeNull();
    const own = await serveInbox(db, P, { ...query, coordinator: "ws/DEMO-4" }, NOW, null, snapshot);
    expect(own?.inFlight).toEqual(["DEMO-7", "DEMO-8", "DEMO-9"]);
  });

  test("closed tickets cannot return through pending launches; fresh launches and uncached claims stay followed", async () => {
    const db = memoryFleet();
    const program: ProgramData = {
      rootId: "DEMO-1",
      fetchedAt: at(10).toISOString(),
      issues: [
        issue("DEMO-1"),
        issue("DEMO-2", { parentId: "DEMO-1", statusType: "completed" }),
        issue("DEMO-3", { parentId: "DEMO-1", statusType: "canceled" }),
      ],
      comments: [],
      warnings: [],
    };
    for (const [ticket, minutes] of [
      ["DEMO-2", 5],
      ["DEMO-3", 30],
      ["DEMO-4", 5],
    ] as const)
      db.launches.push({
        project: P,
        ticket,
        launchedAt: at(minutes).toISOString(),
        tokenUsedAt: null,
        runtime: null,
        handle: null,
        endedAt: null,
      });
    await db.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-5",
      runtime: "Conductor",
      handle: "ws/uncached",
      branch: null,
      at: at(2),
    });
    const snapshot: HandBackSnapshot = {
      repository: "acme/widgets",
      issues: program.issues,
      prs: [],
      flight: { program, forge: null, after: program.fetchedAt },
    };
    const read = await serveInbox(
      db,
      P,
      { coordinator: null, silentAfterMinutes: 15, etag: null },
      NOW,
      null,
      snapshot,
    );
    expect(read).toMatchObject({ inFlight: ["DEMO-4", "DEMO-5"], items: [] });
  });

  test("watch finishes after the last ticket closes even when its handle remains open", async () => {
    const live = tempFleet();
    await live.store.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-2",
      runtime: "Conductor",
      handle: "ws/stale",
      branch: null,
      at: at(30),
    });
    const program: ProgramData = {
      rootId: "DEMO-1",
      fetchedAt: at(10).toISOString(),
      issues: [issue("DEMO-1"), issue("DEMO-2", { parentId: "DEMO-1", statusType: "completed" })],
      comments: [],
      warnings: [],
    };
    const snapshot: HandBackSnapshot = {
      repository: "acme/widgets",
      issues: program.issues,
      prs: [],
      flight: { program, forge: null, after: program.fetchedAt },
    };
    const idleStore: FleetStore = {
      ...live.store,
      latestEvents: async () => {
        throw new Error("idle project must not read event history");
      },
      lastAnsweredAt: async () => {
        throw new Error("idle project must not read answer history");
      },
    };
    const report = await watchInbox(
      { ...live.fleet, inbox: (q) => serveInbox(idleStore, P, q, NOW, null, snapshot) },
      {
        project: P,
        coordinator: null,
        silentAfterMinutes: 15,
        now: () => NOW,
        seen: [],
        sleep: async () => {
          throw new Error("nothing remains to watch");
        },
      },
    );
    expect(report).toMatchObject({ outcome: "nothing", inFlight: [], items: [] });
  });

  test("an inbox read heals merged and completed hand-backs using only its project snapshot", async () => {
    const db = memoryFleet();
    for (const [project, ticket, body] of [
      [P, "DEMO-7", "Agent status: ready-to-merge — PR #9, head abc"],
      [P, "DEMO-8", "handed back"],
      [P, "DEMO-9", "PR #10"],
      [P, "DEMO-10", "PR #11"],
      [P, "DEMO-11", "PR #12"],
      [P, "DEMO-12", "PR #13"],
      ["gadgets", "GAD-1", "PR #9"],
    ] as const)
      await db.putHandBack({ project, ticket, body, author: null, at: NOW });
    const snapshot: HandBackSnapshot = {
      repository: "acme/widgets",
      issues: [
        { id: "DEMO-8", statusType: "completed" },
        { id: "DEMO-10", statusType: "canceled" },
      ],
      prs: [
        { repo: "acme/widgets", number: 9, state: "merged" },
        { repo: "acme/widgets", number: 10, state: "open" },
        { repo: "acme/widgets", number: 11, state: "closed" },
        { repo: "acme/gadgets", number: 12, state: "merged" },
      ],
    };
    const options = { project: P, silentAfterMinutes: 15, now: NOW };
    expect((await readInbox(db, options)).map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await readInbox(db, { ...options, snapshot })).map((i) => i.id)).toEqual([3, 4, 5, 6]);
    for (const id of [1, 2])
      expect(await db.getInboxItem(P, id)).toMatchObject({
        resolution: "resolved: PR merged",
        resolvedAt: NOW.toISOString(),
      });
    expect((await db.getInboxItem("gadgets", 7))?.resolvedAt).toBeNull();
    expect((await readInbox(db, { ...options, snapshot })).map((i) => i.id)).toEqual([3, 4, 5, 6]);
  });

  test("only the reading coordinator's exact nonempty handle is excluded from silence, not open items", async () => {
    const db = memoryFleet();
    for (const [ticket, handle] of [
      ["DEMO-1", "ws-1/s-1"],
      ["DEMO-2", "ws-1/s-2"],
      ["DEMO-3", "ws-2/s-1"],
    ] as const) {
      await db.saveRuntimeHandle({ project: P, ticket, runtime: "Conductor", handle, branch: null, at: at(40) });
    }
    await db.recordEvent({ project: P, ticket: "DEMO-1", kind: "report", phase: "implementing", at: at(30) });
    const options = { project: P, silentAfterMinutes: 15, now: NOW };
    for (const coordinator of [undefined, null, "", "unrelated"])
      expect((await readInbox(db, { ...options, coordinator })).map((entry) => entry.ticket)).toEqual([
        "DEMO-2",
        "DEMO-3",
        "DEMO-1",
      ]);
    expect((await readInbox(db, { ...options, coordinator: "ws-1/s-1" })).map((entry) => entry.ticket)).toEqual([
      "DEMO-2",
      "DEMO-3",
    ]);

    for (const kind of ["question", "answer-request", "launch-request", "hand-back"] as const)
      await db.addInboxItem({
        project: P,
        ticket: "DEMO-1",
        kind,
        recipient: "coordinator",
        author: "ws-1/s-1",
        body: kind,
        at: NOW,
      });
    expect((await readInbox(db, { ...options, coordinator: "ws-1/s-1" })).map((entry) => entry.kind)).toEqual([
      "silent",
      "silent",
      "question",
      "answer-request",
      "launch-request",
      "hand-back",
    ]);
  });

  test("open items and silent workers, oldest first; waiting and released workers are not silent", async () => {
    const db = memoryFleet();
    const hold = async (ticket: string, phase: string, minutesAgo: number, kind: "report" | "release" = "report") => {
      await db.saveRuntimeHandle({
        project: P,
        ticket,
        runtime: "Conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: at(90),
      });
      await db.recordEvent({ project: P, ticket, kind, phase, at: at(minutesAgo) });
    };
    await hold("DEMO-1", "implementing", 40); // silent since 40 min
    await hold("DEMO-2", "awaiting-approval", 60); // waits on the coordinator: not silent
    await hold("DEMO-3", "shipping", 5); // reported recently
    await hold("DEMO-4", "implementing", 50, "release"); // gone
    await hold("DEMO-5", "implementing", 20); // silent, but its question says why
    await db.addInboxItem({
      project: P,
      ticket: "DEMO-5",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "Which?",
      at: at(20),
    });
    await db.putHandBack({
      project: P,
      ticket: "DEMO-6",
      author: null,
      body: "Agent status: ready-to-merge — PR #9",
      at: at(55),
    });
    await db.addInboxItem({
      project: P,
      ticket: "DEMO-9",
      kind: "question",
      recipient: "worker",
      author: null,
      body: "for a worker",
      at: at(70),
    });
    await db.addInboxItem({
      project: "gadgets",
      ticket: "GAD-1",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "other project",
      at: at(80),
    });
    // Blocked, but its question was answered 30 min ago and it never reported since.
    await hold("DEMO-8", "blocked", 60);
    const q = await db.addInboxItem({
      project: P,
      ticket: "DEMO-8",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "Which?",
      at: at(60),
    });
    await db.resolveInboxItem({ project: P, id: q, resolution: "SQLite", at: at(30) });

    const items = await inbox(db);
    expect(items.map((e) => [e.id, e.kind, e.ticket, e.createdAt])).toEqual([
      [2, "hand-back", "DEMO-6", at(55).toISOString()],
      [null, "silent", "DEMO-1", at(40).toISOString()],
      [null, "silent", "DEMO-8", at(30).toISOString()],
      [1, "question", "DEMO-5", at(20).toISOString()],
    ]);
    expect(items[2]?.body).toStartWith("no report for 30 min since its question was answered (phase blocked");
    expect(items[1]?.body).toStartWith("no report for 40 min (phase implementing, Conductor ws/DEMO-1)");
  });

  test("a worker launched that never claimed is in flight at once, and not started after not_started_minutes", async () => {
    const db = memoryFleet();
    const launch = (ticket: string, minutesAgo: number, more: Partial<(typeof db.launches)[number]> = {}) =>
      db.launches.push({
        project: P,
        ticket,
        launchedAt: at(minutesAgo).toISOString(),
        tokenUsedAt: null,
        runtime: null,
        handle: null,
        endedAt: null,
        ...more,
      });
    launch("DEMO-1", 25); // its token never used
    launch("DEMO-2", 20, { tokenUsedAt: at(18).toISOString(), handle: "ws-2/s-2" }); // signed in, no claim
    launch("DEMO-3", 5); // launched just now
    launch("DEMO-4", 30); // claimed since
    await db.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-4",
      runtime: "conductor",
      handle: "ws-4",
      branch: null,
      at: at(10),
    });
    await db.recordEvent({ project: P, ticket: "DEMO-4", kind: "claim", phase: "planning", at: at(10) });
    launch("DEMO-5", 30, { endedAt: at(2).toISOString() }); // revoked
    launch("DEMO-6", 40); // launched again just now: the newest launch counts
    launch("DEMO-6", 3);
    launch("DEMO-7", 25 * 60, { tokenUsedAt: at(25 * 60 - 1).toISOString() }); // older than a day
    launch("GAD-1", 30, { project: "gadgets" });
    // A worker at work, briefed again to read its prompt: that launch starts nobody.
    await db.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-8",
      runtime: "conductor",
      handle: "ws-8",
      branch: null,
      at: at(120),
    });
    await db.recordEvent({ project: P, ticket: "DEMO-8", kind: "report", phase: "implementing", at: at(5) });
    launch("DEMO-8", 30);

    const read = await serveInbox(db, P, { coordinator: null, silentAfterMinutes: 15, etag: null }, NOW);
    expect(read?.items.map((e) => [e.id, e.kind, e.ticket, e.author, e.createdAt])).toEqual([
      [null, "not-started", "DEMO-1", null, at(25).toISOString()],
      [null, "not-started", "DEMO-2", "ws-2/s-2", at(20).toISOString()],
    ]);
    expect(read?.items[0]?.body).toBe(
      "launched 25 min ago and never claimed; its launch token was never used: the worker never reached its `armada login` line (an install that failed, a prompt cut short). Check its session with the runtime guide's status section; launch it again with armada brief DEMO-1 --prompt, or revoke it with armada launch revoke DEMO-1",
    );
    expect(read?.items[1]?.body).toStartWith(
      "launched 20 min ago and never claimed; the worker signed in with its launch token at 09:42 UTC, then stopped before `armada claim` (session ws-2/s-2). Check",
    );
    // A watch started after a launch waits for its claim; past not_started_minutes, the entry carries it.
    expect(read?.inFlight).toEqual(["DEMO-3", "DEMO-4", "DEMO-6", "DEMO-8"]);
    // `not_started_minutes` sets when a launch shows.
    const later = await readInbox(db, { project: P, silentAfterMinutes: 15, notStartedMinutes: 22, now: NOW });
    expect(later.map((e) => e.ticket)).toEqual(["DEMO-1"]);
  });

  test("--wait asks Armada every 15 s, answered 304 while nothing changed, until a new question or the timeout", async () => {
    const clock = fakeClock();
    const live = tempFleet({ clock });
    const db = live.store;
    await db.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-3",
      runtime: "Conductor",
      handle: "ws-coordinator/session",
      branch: null,
      at: at(14),
    });
    await db.addInboxItem({
      project: P,
      ticket: "DEMO-1",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "old",
      at: at(30),
    });
    let sleeps = 0;
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (++sleeps === 3)
        await db.addInboxItem({
          project: P,
          ticket: "DEMO-2",
          kind: "question",
          recipient: "coordinator",
          author: null,
          body: "new",
          at: clock.now(),
        });
    };
    const options = { project: P, coordinator: "ws-coordinator/session", silentAfterMinutes: 15, now: clock.now };

    const got = await checkInbox(live.fleet, { ...options, wait: { timeoutMs: 300_000, sleep } });
    expect(got.items.map((e) => [e.body, e.new])).toEqual([
      ["old", false],
      ["new", true],
    ]);
    // A first read, two unchanged answers (304, no body), then the new question at the third ask.
    expect([got.wait, clock.now().getTime() - NOW.getTime(), live.statuses]).toEqual([
      { timeoutSeconds: 300, timedOut: false },
      45_000,
      [200, 304, 304, 200],
    ]);

    live.statuses.length = 0;
    const idle = await checkInbox(live.fleet, { ...options, wait: { timeoutMs: 40_000, sleep: clock.sleep } });
    expect([idle.wait?.timedOut, idle.items.some((e) => e.new), clock.now().getTime() - NOW.getTime()]).toEqual([
      true,
      false,
      85_000,
    ]);
    // 15 + 15 + 10 s: every ask unchanged.
    expect(live.statuses).toEqual([200, 304, 304, 304]);
    expect(await db.lastCoordinatorSeen(P)).toBe(new Date(NOW.getTime() + 85_000).toISOString());
    expect(db.presence.get(P)?.handle).toBe("ws-coordinator/session");
  });

  test("without --wait the inbox is read once", async () => {
    const live = tempFleet();
    const got = await checkInbox(live.fleet, { project: P, silentAfterMinutes: 15, now: () => NOW });
    expect([got.items, got.wait, live.calls]).toEqual([[], null, ["inbox"]]);
  });
});
