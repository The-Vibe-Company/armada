import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, askCoordinator, checkInbox } from "../src/inbox.ts";
import { type FleetStore, readInbox } from "../src/live.ts";
import { claimTicket, Refusal, releaseTicket, reportPhase, type WorkerContext } from "../src/worker.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_TOML, FakeLinear, fakeClock, NOW, tempFleet } from "./support.ts";

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

  test("--wait long-polls Armada until a new question, or its own timeout; each read records the presence", async () => {
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
    const tick = clock.sleep;
    clock.sleep = async (ms: number) => {
      await tick(ms);
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

    const got = await checkInbox(live.fleet, { ...options, waitMs: 300_000 });
    expect(got.items.map((e) => [e.body, e.new])).toEqual([
      ["old", false],
      ["new", true],
    ]);
    // Armada read it again every 2 s, and answered at the third look.
    expect([got.wait, clock.now().getTime() - NOW.getTime(), live.calls]).toEqual([
      { timeoutSeconds: 300, timedOut: false },
      6_000,
      ["inbox", "inbox"],
    ]);

    live.calls.length = 0;
    const idle = await checkInbox(live.fleet, { ...options, waitMs: 60_000 });
    expect([idle.wait?.timedOut, idle.items.some((e) => e.new), clock.now().getTime() - NOW.getTime()]).toEqual([
      true,
      false,
      66_000,
    ]);
    // One read, then calls of at most 25 s each until the CLI's own timeout: 25 + 25 + 10 s.
    expect(live.calls).toEqual(["inbox", "inbox", "inbox", "inbox"]);
    expect(await db.lastCoordinatorSeen(P)).toBe(new Date(NOW.getTime() + 56_000).toISOString());
    expect(db.presence.get(P)?.handle).toBe("ws-coordinator/session");
  });

  test("without --wait the inbox is read once", async () => {
    const live = tempFleet();
    const got = await checkInbox(live.fleet, { project: P, silentAfterMinutes: 15, now: () => NOW });
    expect([got.items, got.wait, live.calls]).toEqual([[], null, ["inbox"]]);
  });
});
