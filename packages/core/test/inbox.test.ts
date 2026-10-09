import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, askCoordinator, checkInbox } from "../src/inbox.ts";
import {
  entryKey,
  type FleetStore,
  type HandBackSnapshot,
  inboxTag,
  readInbox,
  reconcileHandles,
  recordAck,
  recordMerge,
  recordReport,
  serveInbox,
} from "../src/live.ts";

import { buildStatus } from "../src/status.ts";
import type { ProgramData } from "../src/types.ts";
import { watchInbox } from "../src/watch.ts";
import { claimTicket, Refusal, reportPhase, type WorkerContext } from "../src/worker.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_TOML, FakeLinear, fakeClock, issue, NOW, tempFleet } from "./support.ts";

const config = parseConfig(DEMO_TOML);
const P = "widgets";
const PLAN = "Build the parser\n\n1. Add validation.\n2. Test malformed input.";
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

test("a stored merge unblocks another coordinator's pending work once, until launch or 24 hours", async () => {
  const live = tempFleet();
  const db = live.store;
  const blocker = issue("DEMO-2", { parentId: "DEMO-1" });
  const dependent = (id: string, over = {}) =>
    issue(id, {
      parentId: "DEMO-1",
      labels: [config.tracker.readyLabel],
      blockedBy: [{ id: blocker.id, statusType: "backlog" }],
      ...over,
    });
  const program: ProgramData = {
    rootId: "DEMO-1",
    fetchedAt: at(30).toISOString(),
    comments: [],
    warnings: [],
    issues: [
      issue("DEMO-1"),
      blocker,
      dependent("DEMO-3"),
      // The existing ready list includes frontier tickets without a ready label.
      dependent("DEMO-4", { labels: [] }),
      dependent("DEMO-5", { labels: [config.tracker.parkedLabel] }),
      dependent("DEMO-6", {
        blockedBy: [
          { id: blocker.id, statusType: "backlog" },
          { id: "OUT-1", statusType: "backlog" },
        ],
      }),
    ],
  };
  const snapshot: HandBackSnapshot = {
    repository: config.github.repository,
    config,
    issues: program.issues,
    prs: [],
    flight: { program, forge: null, after: program.fetchedAt },
  };
  await db.addRequest({
    project: P,
    ticket: "DEMO-3",
    kind: "launch-request",
    coordinator: "front",
    author: "owner",
    body: "Launch when ready",
    deferred: true,
    question: null,
    profile: null,
    at: at(20),
  });
  await live.fleet.merge({
    ticket: blocker.id,
    number: 2,
    url: "https://github.com/acme/widgets/pull/2",
    mergeCommit: "a".repeat(40),
    headSha: "b".repeat(40),
  });
  // A later report must not hide the merge, and stale snapshots must not wake the watch.
  await db.recordEvent({ project: P, ticket: blocker.id, kind: "report", phase: "shipping", at: NOW });
  const read = (name: string, now = NOW) =>
    readInbox(db, {
      project: P,
      coordinatorName: name,
      snapshot,
      silentAfterMinutes: 15,
      now,
    });
  expect(await read("front")).toEqual([]);
  blocker.statusType = "completed";
  const unblocked = (await read("front")).filter((e) => e.kind === "unblocked");
  expect(unblocked.map((e) => [e.ticket, e.owner, e.body, entryKey(e)])).toEqual([
    ["DEMO-3", "front", "DEMO-3 unblocked by DEMO-2 (merged by default)", "unblocked:DEMO-3@DEMO-2"],
    ["DEMO-4", null, "DEMO-4 unblocked by DEMO-2 (merged by default)", "unblocked:DEMO-4@DEMO-2"],
  ]);
  expect((await read("default")).filter((e) => e.kind === "unblocked").map((e) => e.ticket)).toEqual(["DEMO-4"]);
  const clock = fakeClock();
  const fleet = {
    ...live.fleet,
    inbox: (q: Parameters<typeof live.fleet.inbox>[0]) => serveInbox(db, P, q, clock.now(), null, snapshot),
  };
  const options = {
    project: P,
    coordinatorName: "front",
    coordinator: null,
    silentAfterMinutes: 15,
    now: clock.now,
    sleep: clock.sleep,
    seen: [] as string[],
  };
  const first = await watchInbox(fleet, options);
  expect(first.outcome).toBe("items");
  expect(first.items.filter((e) => e.kind === "unblocked" && e.new).map(entryKey)).toEqual(unblocked.map(entryKey));
  expect(
    (await watchInbox(fleet, { ...options, seen: first.items.map(entryKey), until: new Date(NOW.getTime() + 60_000) }))
      .outcome,
  ).toBe("timeout");
  expect(
    (await read("front", new Date(NOW.getTime() + 24 * 60 * 60_000))).filter((e) => e.kind === "unblocked"),
  ).toEqual([]);
  await db.saveRuntimeHandle({
    project: P,
    ticket: "DEMO-3",
    coordinator: "front",
    runtime: "Conductor",
    handle: "ws/front",
    branch: null,
    at: NOW,
  });
  await db.recordEvent({ project: P, ticket: "DEMO-3", kind: "claim", at: NOW });
  expect((await read("front")).filter((e) => e.kind === "unblocked").map((e) => e.ticket)).toEqual(["DEMO-4"]);
  await db.releaseRuntimeHandle(P, "DEMO-3", NOW);
  await db.recordEvent({ project: P, ticket: "DEMO-3", kind: "release", at: NOW });
  expect((await read("front")).filter((e) => e.kind === "unblocked").map((e) => e.ticket)).toEqual(["DEMO-4"]);
  db.launches.push({
    project: P,
    ticket: "DEMO-4",
    coordinator: "front",
    launchedAt: NOW.toISOString(),
    tokenUsedAt: null,
    tokenExpiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    runtime: "Conductor",
    handle: "ws/unclaimed",
    endedAt: null,
  });
  expect((await read("front")).filter((e) => e.kind === "unblocked")).toEqual([]);
  // Revocation/expiry does not resurrect an already-cleared merge notification.
  const launch = db.launches[0];
  if (!launch) throw new Error("missing launch");
  launch.endedAt = NOW.toISOString();
  expect((await read("front")).filter((e) => e.kind === "unblocked")).toEqual([]);
  const firstBlocker = issue("DEMO-9", { parentId: "DEMO-1", statusType: "completed" });
  const lastBlocker = issue("DEMO-7", { parentId: "DEMO-1", statusType: "completed" });
  const tied = dependent("DEMO-8", {
    blockedBy: [
      { id: firstBlocker.id, statusType: "completed" },
      { id: lastBlocker.id, statusType: "completed" },
    ],
  });
  program.issues.push(firstBlocker, lastBlocker, tied);
  // The clock is identical; event order, rather than ticket order, selects the last blocker.
  for (const ticket of [firstBlocker.id, lastBlocker.id])
    await live.fleet.merge({
      ticket,
      number: 3,
      url: `https://github.com/acme/widgets/pull/${ticket}`,
      mergeCommit: "c".repeat(40),
      headSha: "d".repeat(40),
    });
  expect((await read("front")).filter((e) => e.kind === "unblocked").map(entryKey)).toEqual([
    "unblocked:DEMO-8@DEMO-7",
  ]);
  // A reopened blocker claim newer than the closed snapshot must prevent a stale wake.
  program.fetchedAt = new Date(NOW.getTime() + 60_000).toISOString();
  if (!snapshot.flight) throw new Error("missing flight snapshot");
  snapshot.flight.after = program.fetchedAt;
  const reclaimedAt = new Date(NOW.getTime() + 2 * 60_000);
  await db.saveRuntimeHandle({
    project: P,
    ticket: lastBlocker.id,
    coordinator: "default",
    runtime: "Conductor",
    handle: "ws/reopened-blocker",
    branch: null,
    at: reclaimedAt,
  });
  await db.recordEvent({ project: P, ticket: lastBlocker.id, kind: "claim", phase: "planning", at: reclaimedAt });
  expect((await read("front", new Date(NOW.getTime() + 3 * 60_000))).filter((e) => e.kind === "unblocked")).toEqual([]);
  expect((await db.getRuntimeHandle(P, lastBlocker.id))?.releasedAt).toBeNull();
});

test("mine resolves ticket ownership before filtering entries, flight and ETags", async () => {
  const store = memoryFleet();
  for (const [ticket, coordinator] of [
    ["DEMO-7", "front"],
    ["DEMO-8", "default"],
    ["DEMO-9", null],
  ] as const) {
    await store.saveRuntimeHandle({
      project: P,
      ticket,
      coordinator,
      runtime: "conductor",
      handle: `ws/${ticket}`,
      branch: null,
      at: at(40),
    });
    await store.putHandBack({ project: P, ticket, coordinator: "other", author: null, body: "PR #7", at: NOW });
  }
  // The newest pending launch wins, regardless of returned order; an open
  // session (even an unowned one) wins over a pending launch and item column.
  for (const [ticket, coordinator, launchedAt] of [
    ["DEMO-10", "front", at(1)],
    ["DEMO-10", "default", at(2)],
    ["DEMO-9", "default", at(1)],
  ] as const)
    store.launches.push({
      project: P,
      ticket,
      coordinator,
      launchedAt: launchedAt.toISOString(),
      tokenUsedAt: null,
      runtime: null,
      handle: null,
      endedAt: null,
    });
  await store.putPlan({ project: P, ticket: "DEMO-10", coordinator: "default", author: null, body: "Plan", at: NOW });
  await store.addInboxItem({
    project: P,
    ticket: null,
    coordinator: "default",
    kind: "merge-request",
    recipient: "coordinator",
    author: null,
    body: "Please merge",
    at: NOW,
  });
  await store.addInboxItem({
    project: P,
    ticket: "DEMO-11",
    coordinator: "default",
    kind: "note",
    recipient: "coordinator",
    author: null,
    body: "Owned by the item",
    at: NOW,
  });
  const read = (scope: "mine" | "all", coordinatorName = "front", etag: string | null = null) =>
    serveInbox(store, P, { scope, coordinatorName, coordinator: null, silentAfterMinutes: 15, etag }, NOW);
  const mine = await read("mine");
  const all = await read("all");
  expect(mine?.items.filter((entry) => entry.id !== null).map((entry) => [entry.ticket, entry.owner])).toEqual([
    ["DEMO-7", "front"],
    ["DEMO-9", null],
    ["DEMO-10", "front"],
    [null, null],
  ]);
  expect(mine?.inFlight).toEqual(["DEMO-10", "DEMO-7"]);
  expect(mine?.items.some((entry) => entry.kind === "silent" && entry.ticket === "DEMO-9")).toBe(true);
  expect(all?.inFlight).toEqual(["DEMO-10", "DEMO-7", "DEMO-8", "DEMO-9"]);
  expect(all?.ownedInFlight).toEqual(mine?.inFlight);
  expect(mine?.etag).not.toBe(all?.etag);
  expect((await read("mine", "default"))?.etag).not.toBe(mine?.etag);
  await store.putHandBack({ project: P, ticket: "DEMO-8", author: null, body: "PR #8 updated", at: NOW });
  expect(await read("mine", "front", mine?.etag)).toBeNull();
  // Taking the unowned silent worker removes its alarm for other roles.
  expect(await store.transferTickets({ project: P, tickets: ["DEMO-9"], to: "default", at: NOW })).toBe(true);
  const taken = await read("mine", "front", mine?.etag);
  expect(taken?.items.some((entry) => entry.ticket === "DEMO-9")).toBe(false);
});

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
        owner: "default",
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
    expect((await db.getRuntimeHandle(P, "DEMO-2"))?.releasedAt).toBe(NOW.toISOString());
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

  test("--wait asks Armada every 15 s, answered 304 while nothing changed, until a new question or plan or the timeout", async () => {
    const empty = tempFleet();
    const once = await checkInbox(empty.fleet, { project: P, silentAfterMinutes: 15, now: () => NOW });
    expect([once.items, once.wait, empty.calls]).toEqual([[], null, ["inbox"]]);

    for (const [kind, body] of [
      ["question", "new"],
      ["plan", PLAN],
    ] as const) {
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
            kind,
            recipient: "coordinator",
            author: kind === "plan" ? "ws-2" : null,
            body,
            at: clock.now(),
          });
      };
      const options = { project: P, coordinator: "ws-coordinator/session", silentAfterMinutes: 15, now: clock.now };

      const got = await checkInbox(live.fleet, { ...options, wait: { timeoutMs: 300_000, sleep } });
      expect(got.items.map((e) => [e.body, e.new])).toEqual([
        ["old", false],
        [body, true],
      ]);
      expect(got.items[1]).toMatchObject({ kind, body, new: true });
      // A first read, two unchanged answers (304, no body), then the question or plan alone at the third ask.
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
    }
  });
});

describe("silence allowances and repeated alarms", () => {
  test("claim grace, activity resets, CI allowance and doubling levels share stable inbox keys", async () => {
    for (const row of [
      { age: 10, report: false, kind: null },
      { age: 29, report: false, kind: null },
      { age: 31, report: false, kind: "silent", level: 0 },
      { age: 16, report: true, kind: "silent", level: 0 },
      { age: 31, report: true, kind: "silent", level: 1 },
      { age: 61, report: true, kind: "silent", level: 2 },
      { age: 44, report: true, ci: true, state: "working", kind: null },
      { age: 46, report: true, ci: true, state: "working", kind: "silent", level: 0 },
      { age: 6, report: true, ci: true, state: "idle", kind: "stopped" },
      { age: 31, report: false, heartbeat: true, kind: null },
      { age: 16, report: false, heartbeat: "claim", kind: "silent", level: 0 },
    ] as const) {
      const db = memoryFleet();
      await db.saveRuntimeHandle({
        project: P,
        ticket: "DEMO-70",
        runtime: "Conductor",
        handle: "ws/s",
        branch: null,
        at: at(row.age),
      });
      if (row.report)
        await db.recordEvent({
          project: P,
          ticket: "DEMO-70",
          kind: "report",
          phase: "ci" in row ? "shipping" : "implementing",
          shippingStage: "ci" in row ? "ci" : null,
          at: at(row.age),
        });
      if ("state" in row && row.state)
        await db.observeRuntime({
          project: P,
          ticket: "DEMO-70",
          handle: "ws/s",
          claimedAt: at(row.age).toISOString(),
          state: row.state,
          at: NOW,
        });
      if ("heartbeat" in row)
        await db.recordHeartbeat({
          project: P,
          ticket: "DEMO-70",
          handle: "ws/s",
          at: at(row.heartbeat === "claim" ? row.age : 1),
        });
      const q = { coordinator: null, silentAfterMinutes: 15, etag: null };
      const read = await serveInbox(db, P, q, NOW);
      if (!read) throw new Error("first inbox read missing");
      expect(read.items[0]?.kind ?? null).toBe(row.kind);
      if ("level" in row) {
        const item = read.items[0];
        if (!item) throw new Error("silent entry missing");
        expect(entryKey(item)).toBe(`silent:DEMO-70:${row.level}`);
      }
      if (row.kind === "stopped") expect(read?.items[0]?.body).toContain("its turn ended while waiting for CI");
      expect(await serveInbox(db, P, { ...q, etag: read.etag }, new Date(NOW.getTime() + 60_000))).toBeNull();
    }
  });

  test("fresh closed and externally merged readings release only the claim they describe", async () => {
    const db = memoryFleet();
    for (const ticket of ["DEMO-71", "DEMO-72", "DEMO-73", "DEMO-74"])
      await db.saveRuntimeHandle({
        project: P,
        ticket,
        runtime: "Conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: at(ticket === "DEMO-74" ? 1 : 40),
      });
    await db.putHandBack({ project: P, ticket: "DEMO-73", author: "ws/DEMO-73", body: "PR #73, head abc", at: at(30) });
    const program: ProgramData = {
      rootId: "DEMO-0",
      fetchedAt: at(5).toISOString(),
      comments: [],
      warnings: [],
      issues: [
        issue("DEMO-0"),
        issue("DEMO-71", { parentId: "DEMO-0", statusType: "completed" }),
        issue("DEMO-72", { parentId: "DEMO-0", statusType: "canceled" }),
        issue("DEMO-73", { parentId: "DEMO-0", agentPhase: "ready-to-merge" }),
        issue("DEMO-74", { parentId: "DEMO-0", statusType: "completed" }),
      ],
    };
    const snapshot: HandBackSnapshot = {
      repository: "acme/widgets",
      issues: program.issues,
      prs: [{ repo: "acme/widgets", number: 73, state: "merged" }],
      flight: { program, forge: null, after: at(5).toISOString() },
    };
    const q = { coordinator: null, silentAfterMinutes: 15, etag: null };
    await serveInbox(db, P, q, NOW, null, { ...snapshot, prs: [], flight: undefined });
    expect((await db.openRuntimeHandles(P)).length).toBe(4);
    const read = await serveInbox(db, P, q, NOW, null, snapshot);
    expect((await db.openRuntimeHandles(P)).map((h) => h.ticket)).toEqual(["DEMO-74"]);
    expect(read?.inFlight).not.toContain("DEMO-73");
    expect(read?.items.some((i) => ["DEMO-71", "DEMO-72", "DEMO-73"].includes(i.ticket ?? ""))).toBe(false);
    expect((await db.latestEvents(P))["DEMO-73"]?.message).toBe("PR #73 merged outside armada merge");
  });
});

test("watch wakes again at each doubling of an unresolved silence", async () => {
  const db = memoryFleet();
  await db.saveRuntimeHandle({
    project: P,
    ticket: "DEMO-80",
    runtime: "Conductor",
    handle: "ws/s",
    branch: null,
    at: at(16),
  });
  await db.recordEvent({ project: P, ticket: "DEMO-80", kind: "report", phase: "implementing", at: at(16) });
  const clock = fakeClock(NOW);
  const fleet = { inbox: (q: Parameters<typeof serveInbox>[2]) => serveInbox(db, P, q, clock.now()) } as Parameters<
    typeof watchInbox
  >[0];
  const seen: string[] = [];
  for (const level of [0, 1, 2]) {
    const report = await watchInbox(fleet, {
      project: P,
      coordinator: null,
      silentAfterMinutes: 15,
      seen,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 60_000,
    });
    expect(report.outcome).toBe("items");
    const entry = report.items.find((i) => i.new);
    if (!entry) throw new Error("new silence missing");
    expect(entryKey(entry)).toBe(`silent:DEMO-80:${level}`);
    seen.push(entryKey(entry));
  }
});

test("retained old Linear and merged PR evidence cannot release a replacement generation", async () => {
  const db = memoryFleet();
  for (const ticket of ["DEMO-91", "DEMO-92"])
    await db.saveRuntimeHandle({
      project: P,
      ticket,
      runtime: "Conductor",
      handle: `ws/${ticket}`,
      branch: null,
      at: at(20),
    });
  const program: ProgramData = {
    rootId: "DEMO-0",
    fetchedAt: at(15).toISOString(),
    readStartedAt: at(40).toISOString(),
    comments: [],
    warnings: [],
    issues: [
      issue("DEMO-0"),
      issue("DEMO-91", { parentId: "DEMO-0", statusType: "completed" }),
      issue("DEMO-92", {
        parentId: "DEMO-0",
        agentPhase: "shipping",
        prs: [
          {
            repo: "acme/widgets",
            number: 92,
            state: "merged",
            title: "Old PR",
            url: "https://github.com/acme/widgets/pull/92",
            mergedAt: at(30).toISOString(),
          },
        ],
      }),
    ],
  };
  const snapshot: HandBackSnapshot = {
    repository: "acme/widgets",
    issues: program.issues,
    prs: [{ repo: "acme/widgets", number: 92, state: "merged" }],
    flight: { program, forge: null, after: at(10).toISOString() },
  };
  const read = await serveInbox(db, P, { coordinator: null, silentAfterMinutes: 15, etag: null }, NOW, null, snapshot);
  expect((await db.openRuntimeHandles(P)).map((h) => h.ticket)).toEqual(["DEMO-91", "DEMO-92"]);
  expect(read?.inFlight).toContain("DEMO-91");
  // The legacy retained program has a finish time older than the forge-only refresh too.
  delete program.readStartedAt;
  await serveInbox(db, P, { coordinator: null, silentAfterMinutes: 15, etag: null }, NOW, null, snapshot);
  expect((await db.openRuntimeHandles(P)).length).toBe(2);
});

test("a late hand-back from an older worker cannot end its replacement", async () => {
  const db = memoryFleet();
  await db.saveRuntimeHandle({
    project: P,
    ticket: "DEMO-94",
    runtime: "conductor",
    handle: "ws/s",
    branch: null,
    workerSessionId: "replacement",
    at: at(20),
  });
  const report = {
    ticket: "DEMO-94",
    phase: "ready-to-merge" as const,
    previous: "shipping" as const,
    summary: "PR #94, head abc",
    message: "",
    prUrl: null,
    headSha: null,
    workerSessionId: "older",
  };
  await expect(recordReport(db, P, report, at(10))).rejects.toThrow("no longer holds");
  // An old request that already passed its check still carries its authenticated author.
  await db.putHandBack({ project: P, ticket: report.ticket, author: "older", body: report.summary, at: at(10) });
  await db.recordEvent({
    project: P,
    ticket: report.ticket,
    kind: "report",
    phase: report.phase,
    message: report.summary,
    at: at(10),
  });
  const program: ProgramData = {
    rootId: "DEMO-0",
    fetchedAt: NOW.toISOString(),
    comments: [],
    warnings: [],
    issues: [issue("DEMO-0"), issue(report.ticket, { parentId: "DEMO-0" })],
  };
  const snapshot: HandBackSnapshot = {
    repository: "acme/widgets",
    issues: program.issues,
    prs: [{ repo: "acme/widgets", number: 94, state: "merged" }],
    flight: { program, forge: null, after: NOW.toISOString() },
  };
  const reconcile = async () =>
    reconcileHandles(
      db,
      P,
      await db.openRuntimeHandles(P),
      snapshot,
      NOW,
      await db.openInboxItems({ project: P, recipient: "coordinator" }),
      await db.latestEvents(P),
    );
  expect(await reconcile()).toBe(false);
  expect((await db.openRuntimeHandles(P)).length).toBe(1);
  await recordReport(db, P, { ...report, workerSessionId: "replacement" }, at(5));
  // A reading begun before the claim must retain the signed hand-back for the next fresh read.
  await serveInbox(db, P, { coordinator: null, silentAfterMinutes: 15, etag: null }, NOW, null, {
    ...snapshot,
    flight: { program, forge: null, after: at(25).toISOString() },
  });
  expect((await db.openInboxItems({ project: P, recipient: "coordinator" })).some((i) => i.kind === "hand-back")).toBe(
    true,
  );
  expect((await db.openRuntimeHandles(P)).length).toBe(1);

  expect(await reconcile()).toBe(true);
  expect((await db.openRuntimeHandles(P)).length).toBe(0);
});

describe("job alarms", () => {
  test("derives silence per running job at read time, even on Done tickets, and clears on news", async () => {
    const store = memoryFleet();
    const jobConfig = parseConfig(`${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstop = "stop"\nsilence_minutes = 15`);
    const snapshot: HandBackSnapshot = {
      repository: "acme/widgets",
      issues: [{ id: "DEMO-7", statusType: "completed" }],
      prs: [],
      config: jobConfig,
    };
    const jobs = [];
    for (let i = 0; i < 2; i++) {
      const job = await store.startJob({ project: P, ticket: "DEMO-7", name: "eval", startedBy: "runner", at: at(30) });
      await store.observeJob({
        project: P,
        ticket: job.ticket,
        id: job.id,
        state: "running",
        progress: "40/120",
        at: at(20),
      });
      jobs.push(job);
    }
    await store.startJob({ project: P, ticket: "DEMO-8", name: "eval", startedBy: null, at: at(30) });
    const query = { coordinator: null, silentAfterMinutes: 1, etag: null };
    const read = await serveInbox(store, P, query, NOW, null, snapshot);
    expect(read?.items.map((e) => e.kind)).toEqual(["job-silent", "job-silent"]);
    const { entryKey } = await import("../src/live.ts");
    expect(read?.items.map(entryKey)).toEqual(jobs.map((j) => `job-silent:${j.id}`).reverse());
    expect(read?.items[0]?.body).toContain("40/120");
    expect(read?.inFlight).toEqual([]);
    expect(read?.openJobs).toHaveLength(3);
    expect(await serveInbox(store, P, { ...query, etag: read?.etag ?? null }, NOW, null, snapshot)).toBeNull();
    for (const job of jobs)
      await store.observeJob({ project: P, ticket: job.ticket, id: job.id, state: "running", at: NOW });
    expect((await serveInbox(store, P, query, NOW, null, snapshot))?.items).toEqual([]);
    expect((await serveInbox(store, P, query, new Date(NOW.getTime() + 15 * 60000), null, snapshot))?.items).toEqual(
      [],
    );
    expect(
      (await serveInbox(store, P, query, new Date(NOW.getTime() + 16 * 60000), null, snapshot))?.items,
    ).toHaveLength(2);
  });

  test("unchanged progress wakes once per stall, clears on movement and yields to silence", async () => {
    const store = memoryFleet();
    const jobConfig = parseConfig(`${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstop = "stop"`);
    const snapshot: HandBackSnapshot = { repository: "acme/widgets", issues: [], prs: [], config: jobConfig };
    const job = await store.startJob({ project: P, ticket: "DEMO-7", name: "eval", startedBy: null, at: at(61) });
    const observe = (minutesAgo: number, progress?: string | null) =>
      store.observeJob({
        project: P,
        ticket: job.ticket,
        id: job.id,
        state: "running",
        progress,
        at: at(minutesAgo),
      });
    await observe(61, "40/120 ETA 03:10");
    for (const minutes of [51, 41, 31, 21, 11, 1]) await observe(minutes, `40/120 ETA ${minutes} min`);
    const query = { coordinator: null, silentAfterMinutes: 15, etag: null };
    const read = (now = NOW) => serveInbox(store, P, query, now, null, snapshot);
    const before = (await read(at(1)))?.items ?? [];
    expect(before).toEqual([]); // exactly 60 min does not exceed the limit
    const entries = (await read())?.items ?? [];
    expect(entries).toMatchObject([{ kind: "job-stalled", jobId: job.id }]);
    expect(entries[0]?.body).toContain("unchanged for 61 min");
    expect(entries[0]?.body).toContain("keeps running");
    expect(entries[0]?.body).toContain(`armada job status ${job.id}`);
    expect(entries[0]?.body).toContain(`armada job stop ${job.id}`);
    const stalledKey = entryKey(entries[0]!);
    expect(stalledKey).toBe(`job-stalled:${job.id}@${at(61).toISOString()}`);
    await expect(
      recordAck(store, P, { target: stalledKey, reason: "checked the runner" }, NOW, { snapshot }),
    ).rejects.toThrow("armada job status <id> (or armada job stop <id>)");
    const clock = fakeClock();
    const fleet = { ...tempFleet({ store, clock }).fleet, inbox: async () => (await read(clock.now()))! };
    const watch = (seen: string[]) =>
      watchInbox(fleet, {
        project: P,
        coordinator: null,
        silentAfterMinutes: 15,
        seen,
        now: clock.now,
        sleep: clock.sleep,
        until: new Date(clock.now().getTime() + 60_000),
      });
    const first = await watch([]);
    expect(first.outcome).toBe("items");
    expect((await watch(first.items.map(entryKey))).outcome).toBe("timeout");
    await observe(0, "41/120");
    expect((await read())?.items).toEqual([]);
    for (const minutes of [10, 20, 30, 40, 50, 60]) await observe(-minutes, "41/120");
    const later = (await read(at(-61)))?.items ?? [];
    expect(later).toMatchObject([{ kind: "job-stalled" }]);
    expect(entryKey(later[0]!)).not.toBe(entryKey(entries[0]!));
    clock.advance(60 * 60_000);
    expect((await watch(first.items.map(entryKey))).outcome).toBe("items");
    expect((await read(at(-76)))?.items.map((item) => item.kind)).toEqual(["job-silent"]);
    await observe(-77, null);
    expect((await read(at(-140)))?.items.map((item) => item.kind)).toEqual(["job-silent"]);
    await observe(-140);
    expect((await read(at(-140)))?.items).toEqual([]);
    expect((await store.getJob(P, job.id))?.state).toBe("running");
    expect(await store.openInboxItems({ project: P, recipient: "coordinator" })).toEqual([]);
  });

  test("job alarms and liveness follow the ticket's named coordinator", async () => {
    const live = tempFleet();
    const { ctx, linear } = setup(live);
    await working(ctx, linear, "DEMO-7");
    expect(
      await live.store.transferTickets({ project: P, tickets: ["DEMO-7"], from: "default", to: "back", at: NOW }),
    ).toBe(true);
    const job = await live.store.startJob({
      project: P,
      ticket: "DEMO-7",
      name: "eval",
      startedBy: "runner",
      at: at(30),
    });
    await live.store.observeJob({ project: P, ticket: job.ticket, id: job.id, state: "running", at: at(20) });
    const query = { coordinator: null, silentAfterMinutes: 15, etag: null };
    const front = await serveInbox(live.store, P, { ...query, coordinatorName: "front" }, NOW);
    expect(front?.items.filter((item) => item.kind === "job-silent")).toEqual([]);
    expect(front?.openJobs).toBeUndefined();
    const back = await serveInbox(live.store, P, { ...query, coordinatorName: "back" }, NOW);
    expect(back?.items.filter((item) => item.kind === "job-silent")).toMatchObject([{ jobId: job.id, owner: "back" }]);
    expect(back?.openJobs).toEqual([job.id]);
  });

  test("terminal jobs wake watch once and their notices can be acknowledged without Linear writes", async () => {
    const clock = fakeClock();
    const live = tempFleet({ clock });
    const { ctx, linear } = setup(live);
    for (const state of ["succeeded", "failed", "stopped", "lost"] as const) {
      const job = await live.fleet.startJob({ ticket: "DEMO-7", name: "eval" });
      await live.fleet.observeJob({ ticket: job.ticket, id: job.id, state: "running", progress: "40/120" });
      await live.fleet.observeJob({ ticket: job.ticket, id: job.id, state });
      await live.fleet.observeJob({ ticket: job.ticket, id: job.id, state });
    }
    const report = await watchInbox(live.fleet, {
      project: P,
      coordinator: null,
      silentAfterMinutes: 15,
      seen: [],
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(report.outcome).toBe("items");
    expect(report.items).toHaveLength(4);
    expect(report.items.every((item) => item.kind === "job" && item.body.includes("40/120"))).toBe(true);
    const { entryKey } = await import("../src/live.ts");
    const again = await watchInbox(live.fleet, {
      project: P,
      coordinator: null,
      silentAfterMinutes: 15,
      seen: report.items.map(entryKey),
      now: clock.now,
      sleep: clock.sleep,
      until: new Date(clock.now().getTime() + 60000),
    });
    expect(again.outcome).toBe("timeout");
    expect(again.items.every((item) => !item.new)).toBe(true);
    for (const item of report.items) await answerItem(ctx, { target: `#${item.id}`, text: "Runner outcome checked" });
    expect(await inbox(live.store)).toEqual([]);
    expect(linear.writes).toEqual([]);
  });
});

test("watch sees a terminal notice when the job ends during the inbox read", async () => {
  const clock = fakeClock();
  const store = memoryFleet();
  const job = await store.startJob({ project: P, ticket: "DEMO-7", name: "eval", startedBy: null, at: NOW });
  await store.observeJob({ project: P, ticket: job.ticket, id: job.id, state: "running", progress: "40/120", at: NOW });
  const list = store.listJobs.bind(store);
  let ended = false;
  store.listJobs = async (project, query) => {
    if (!ended) {
      ended = true;
      await store.observeJob({ project, ticket: job.ticket, id: job.id, state: "succeeded", at: NOW });
    }
    return list(project, query);
  };
  const live = tempFleet({ store, clock });
  const report = await watchInbox(live.fleet, {
    project: P,
    coordinator: null,
    silentAfterMinutes: 15,
    seen: [],
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(report.outcome).toBe("items");
  expect(report.items).toMatchObject([{ kind: "job", body: expect.stringContaining("succeeded") }]);
  expect(report.inFlight).toEqual([]);
  expect(report.openJobs).toBeUndefined();
});

test("a queue nobody drains wakes the coordinator once; a refusal clears when queued again", async () => {
  const db = memoryFleet();
  const sha = "a".repeat(40);
  const entry = { ticket: "DEMO-2", noTicket: false, keepOpen: false, throughHold: null, reason: null, headSha: sha };
  await db.queueAdd({ ...entry, project: P, pr: 12, queuedBy: "owner", at: at(5) });
  await db.queueAdd({ ...entry, project: P, pr: 15, ticket: "DEMO-3", queuedBy: "owner", at: at(3) });
  const stalled = (await inbox(db)).filter((e) => e.kind === "queue-stalled");
  expect(stalled).toMatchObject([
    {
      id: null,
      body: `2 pull requests queued (#12, #15) and nothing drains them since ${at(3).toISOString().slice(11, 16)} UTC: armada merge --drain`,
    },
  ]);
  expect(stalled.map(entryKey)).toEqual(["queue-stalled:1"]);
  // A drain holding the lease is draining, however long its checks take.
  const lease = { project: P, name: "merge-queue", holder: "coordinator-a", ttlMs: 600_000, at: at(1) };
  await db.acquireLease(lease);
  expect((await inbox(db)).some((e) => e.kind === "queue-stalled")).toBe(false);
  const next = await db.queueNext({ project: P, holder: "coordinator-a", at: at(1) });
  if ("refused" in next || !next.entry) throw new Error("expected the first entry");
  await db.queueFinish({
    project: P,
    id: next.entry.id,
    holder: "coordinator-a",
    outcome: "refused",
    detail: "CI failed",
    at: at(1),
  });
  await db.releaseLease(lease);
  // Within two minutes of the last change, a lost drain is not yet a stall.
  expect((await inbox(db)).map((e) => [e.kind, e.body])).toEqual([["queue-refused", "PR #12 refused: CI failed"]]);
  await db.queueAdd({ ...entry, project: P, pr: 12, queuedBy: "owner", at: NOW });
  expect((await inbox(db)).map((e) => e.kind)).toEqual([]);
});

test("a main-red pause wakes watch once and names the waiting queue without another stall alarm", async () => {
  const clock = fakeClock();
  const live = tempFleet({ clock });
  const store = live.store;
  const hold = {
    project: P,
    kind: "main-red" as const,
    ref: "a".repeat(40),
    reason: "main red since #12: test failing on aaaaaaa",
    author: "armada",
    at: at(5),
  };
  const opened = await store.openHold(hold);
  const entry = {
    project: P,
    ticket: null,
    noTicket: true,
    keepOpen: false,
    throughHold: null,
    reason: null,
    headSha: "b".repeat(40),
    queuedBy: "owner",
    at: at(5),
  };
  await store.queueAdd({ ...entry, pr: 15 });
  await store.queueAdd({ ...entry, pr: 16 });
  const options = { project: P, coordinator: null, silentAfterMinutes: 15, now: clock.now, sleep: clock.sleep };
  const first = await watchInbox(live.fleet, { ...options, seen: [] });
  expect(first.outcome).toBe("items");
  expect(first.items).toHaveLength(1);
  expect(first.items[0]?.kind).toBe("hold");
  expect(first.items[0]?.body).toContain("main red since #12: test failing on aaaaaaa");
  expect(first.items[0]?.body.endsWith("merge queue paused (2 waiting)")).toBe(true);
  expect((await store.openHold(hold)).id).toBe(opened.id);
  const second = await watchInbox(live.fleet, {
    ...options,
    seen: first.items.map(entryKey),
    until: new Date(clock.now().getTime() + 60_000),
  });
  expect(second.outcome).toBe("timeout");
  await store.clearHold({
    project: P,
    id: opened.id,
    reason: "main green again at bbbbbbb",
    author: "armada",
    at: clock.now(),
  });
  expect((await inbox(store)).some((i) => i.kind === "hold")).toBe(false);
  expect((await inbox(store)).some((i) => i.kind === "queue-stalled")).toBe(true);
});

test("confirmed and snapshot merges settle only that PR's coordinator notices", async () => {
  const db = memoryFleet();
  const ids: number[] = [];
  for (const pr of [12, 123]) {
    ids.push(
      await db.addInboxItem({
        project: P,
        ticket: "DEMO-2",
        recipient: "coordinator",
        kind: "queue-refused",
        author: null,
        body: `PR #${pr} refused: CI failed`,
        at: at(5),
      }),
    );
    ids.push(
      (await db.addRequest({
        project: P,
        kind: "merge-request",
        ticket: "DEMO-2",
        question: null,
        profile: null,
        pr,
        author: "owner",
        body: "Please merge",
        at: at(5),
      }))!,
    );
  }
  const recorded = await recordMerge(
    db,
    P,
    {
      ticket: "DEMO-2",
      number: 12,
      url: "https://github.com/acme/widgets/pull/12",
      mergeCommit: "b".repeat(40),
      headSha: "a".repeat(40),
    },
    NOW,
  );
  expect(recorded.cleared).toEqual(ids.slice(0, 2));
  expect((await inbox(db)).map((i) => i.id)).toEqual(ids.slice(2));
  const snapshot: HandBackSnapshot = {
    repository: "acme/widgets",
    issues: [],
    prs: [{ repo: "other/widgets", number: 123, state: "merged" }],
  };
  expect((await readInbox(db, { project: P, silentAfterMinutes: 15, now: NOW, snapshot })).map((i) => i.id)).toEqual(
    ids.slice(2),
  );
  snapshot.prs = [{ repo: "acme/widgets", number: 123, state: "merged" }];
  expect(await readInbox(db, { project: P, silentAfterMinutes: 15, now: NOW, snapshot })).toEqual([]);
  expect((await db.getInboxItem(P, ids[2]!))?.resolution).toBe("resolved: PR #123 merged");
});

test("only the current worker can retire a hand-back; returning ready creates a new wake key", async () => {
  const db = memoryFleet();
  await db.saveRuntimeHandle({
    project: P,
    ticket: "DEMO-2",
    runtime: "Conductor",
    handle: "ws/session",
    branch: null,
    workerSessionId: "current",
    at: at(10),
  });
  const r = {
    ticket: "DEMO-2",
    phase: "ready-to-merge" as const,
    previous: "shipping" as const,
    summary: "PR #12 ready",
    message: "",
    prUrl: null,
    headSha: null,
    workerSessionId: "current",
  };
  await recordReport(db, P, r, at(5));
  const before = (await inbox(db)).find((i) => i.kind === "hand-back")!;
  await expect(recordReport(db, P, { ...r, phase: "shipping", workerSessionId: "old" }, at(3))).rejects.toThrow(
    "no longer holds",
  );
  expect((await db.getInboxItem(P, before.id!))?.resolvedAt).toBeNull();
  await recordReport(db, P, { ...r, phase: "shipping", previous: "ready-to-merge" }, at(2));
  expect((await db.getInboxItem(P, before.id!))?.resolution).toBe("worker resumed: shipping");
  expect((await inbox(db)).some((i) => i.kind === "hand-back")).toBe(false);
  await recordReport(db, P, r, NOW);
  const after = (await inbox(db)).find((i) => i.kind === "hand-back")!;
  expect(entryKey(after)).not.toBe(entryKey(before));
  const live = tempFleet({ store: db });
  const watch = await watchInbox(live.fleet, {
    project: P,
    silentAfterMinutes: 15,
    coordinator: null,
    seen: [entryKey(before)],
    now: live.clock.now,
    sleep: live.clock.sleep,
  });
  expect(watch.outcome).toBe("items");
  expect(watch.items.find((i) => i.kind === "hand-back")?.new).toBe(true);
});

test("queued hand-backs refresh the listing without changing their watch key", async () => {
  const db = memoryFleet();
  await db.putHandBack({ project: P, ticket: "DEMO-2", author: null, body: "PR #12 ready", at: at(5) });
  const before = (await inbox(db))[0]!;
  const entry = {
    project: P,
    ticket: "DEMO-2",
    noTicket: false,
    keepOpen: false,
    throughHold: null,
    reason: null,
    headSha: "a".repeat(40),
    queuedBy: "owner",
    at: NOW,
  };
  await db.queueAdd({ ...entry, pr: 11 });
  await db.queueAdd({ ...entry, pr: 12 });
  const queued = (await inbox(db)).find((i) => i.id === before.id)!;
  expect(queued.queue).toEqual({ state: "queued", position: 2, detail: null });
  expect(entryKey(queued)).toBe(entryKey(before));
  expect(inboxTag([queued])).not.toBe(inboxTag([before]));
  const live = tempFleet({ store: db });
  const watch = await watchInbox(live.fleet, {
    project: P,
    silentAfterMinutes: 15,
    coordinator: null,
    seen: [],
    now: live.clock.now,
    sleep: live.clock.sleep,
    until: new Date(NOW.getTime() + 60_000),
  });
  expect(watch.outcome).toBe("timeout");
  await db.acquireLease({ project: P, name: "merge-queue", holder: "drain", ttlMs: 600_000, at: NOW });
  await db.queueRemove({ project: P, pr: 11, at: NOW });
  const next = await db.queueNext({ project: P, holder: "drain", at: NOW });
  if ("refused" in next || !next.entry) throw new Error("missing queue entry");
  await db.queueProgress({ project: P, id: next.entry.id, holder: "drain", detail: "waiting for checks", at: NOW });
  const merging = (await inbox(db)).find((i) => i.id === before.id)!;
  expect(merging.queue).toEqual({ state: "merging", position: 1, detail: "waiting for checks" });
  expect(entryKey(merging)).toBe(entryKey(before));
  await db.queueFinish({
    project: P,
    id: next.entry.id,
    holder: "drain",
    outcome: "refused",
    detail: "CI failed",
    at: NOW,
  });
  const refused = await inbox(db);
  expect(refused.find((i) => i.id === before.id)?.queue).toBeUndefined();
  expect(refused.some((i) => i.kind === "queue-refused" && entryKey(i) !== entryKey(before))).toBe(true);
});

test("a PR notice write failure cannot undo a confirmed merge and heals on the next stored reading", async () => {
  const db = memoryFleet();
  const id = await db.addInboxItem({
    project: P,
    ticket: "DEMO-2",
    kind: "queue-refused",
    recipient: "coordinator",
    author: null,
    body: "PR #12 refused: head moved",
    at: at(5),
  });
  const resolve = db.resolvePrItems;
  db.resolvePrItems = async () => {
    throw new Error("database unavailable");
  };
  const recorded = await recordMerge(
    db,
    P,
    {
      ticket: "DEMO-2",
      number: 12,
      url: "https://github.com/acme/widgets/pull/12",
      mergeCommit: "b".repeat(40),
      headSha: "a".repeat(40),
    },
    NOW,
  );
  expect(recorded.warnings?.[0]).toContain("could not clear PR #12 inbox notices");
  expect((await db.latestEvents(P))["DEMO-2"]?.kind).toBe("merge");
  expect((await db.getInboxItem(P, id))?.resolvedAt).toBeNull();
  db.resolvePrItems = resolve;
  expect(
    await readInbox(db, {
      project: P,
      silentAfterMinutes: 15,
      now: NOW,
      snapshot: {
        repository: "acme/widgets",
        issues: [],
        prs: [{ repo: "acme/widgets", number: 12, state: "merged" }],
      },
    }),
  ).toEqual([]);
});

test("inbox --wait keeps listening when a hand-back is first observed already queued", async () => {
  const live = tempFleet();
  let added = false;
  const report = await checkInbox(live.fleet, {
    project: P,
    silentAfterMinutes: 15,
    now: live.clock.now,
    wait: {
      timeoutMs: 60_000,
      sleep: async (ms) => {
        await live.clock.sleep(ms);
        if (added) return;
        added = true;
        await live.store.putHandBack({
          project: P,
          ticket: "DEMO-2",
          author: null,
          body: "PR #12 ready",
          at: live.clock.now(),
        });
        await live.store.queueAdd({
          project: P,
          pr: 12,
          ticket: "DEMO-2",
          noTicket: false,
          keepOpen: false,
          throughHold: null,
          reason: null,
          headSha: "a".repeat(40),
          queuedBy: "owner",
          at: live.clock.now(),
        });
      },
    },
  });
  expect(report.wait?.timedOut).toBe(true);
  expect(report.items.find((i) => i.kind === "hand-back")?.queue?.state).toBe("queued");
});
