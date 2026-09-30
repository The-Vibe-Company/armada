import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, askCoordinator, checkInbox, readInbox } from "../src/inbox.ts";
import {
  addInboxItem,
  type Db,
  getInboxItem,
  lastCoordinatorSeen,
  putHandBack,
  recordEvent,
  resolveInboxItem,
  saveRuntimeHandle,
} from "../src/turso.ts";
import { claimTicket, Refusal, releaseTicket, reportPhase, type WorkerContext } from "../src/worker.ts";
import { closeTempTurso, DEMO_TOML, FakeLinear, NOW, tempTurso } from "./support.ts";

afterEach(closeTempTurso);

const config = parseConfig(DEMO_TOML);
const P = "widgets";
const at = (minutesBeforeNow: number) => new Date(NOW.getTime() - minutesBeforeNow * 60_000);

function setup(db: Db | null) {
  const linear = new FakeLinear();
  const ctx: WorkerContext = {
    config,
    linear,
    turso: async () => (db ? { db, warning: null } : { db: null, warning: "Turso is not configured" }),
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

const inbox = (db: Db) => readInbox(db, { project: P, silentAfterMinutes: 15, now: () => NOW });

describe("ask and answer", () => {
  test("a question blocks the worker, reaches the inbox and the ticket; the answer closes it in both", async () => {
    const { db } = await tempTurso();
    const { linear, ctx } = setup(db);
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
    expect(await getInboxItem(db, P, 1)).toMatchObject({
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
    const { db } = await tempTurso();
    const { linear, ctx } = setup(db);
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
    expect(await getInboxItem(db, P, 3)).toMatchObject({
      kind: "note",
      recipient: "worker",
      resolution: "delivered through the runtime",
    });
    expect(await inbox(db)).toEqual([]);
    expect(await refusal(answerItem(ctx, { target: "3", text: "x", note: true }))).toContain("a note goes to a ticket");
    await putHandBack(db, { project: P, ticket: "DEMO-7", author: null, body: "handed back", at: NOW });
    expect(await refusal(answerItem(ctx, { target: "4", text: "ok" }))).toBe(
      "inbox item #4 is a hand-back: armada merge resolves it once the pull request is merged\nNext: armada merge <pr> --ticket DEMO-7 --dry-run",
    );
  });

  test("without Turso a question still blocks the ticket; an item id cannot be answered, a ticket can", async () => {
    const { linear, ctx } = setup(null);
    await working(ctx, linear, "DEMO-7");
    const asked = await askCoordinator(ctx, { ticket: "DEMO-7", question: "Which store?" });
    expect([asked.item, linear.get("DEMO-7").comments[0]?.status?.phase]).toEqual([null, "blocked"]);
    expect(await refusal(answerItem(ctx, { target: "4", text: "SQLite" }))).toContain("answer by ticket instead");
    const out = await answerItem(ctx, { target: "DEMO-7", text: "SQLite" });
    expect([out.lines[0], out.warnings]).toEqual(["Answer posted on DEMO-7 (blocked).", ["Turso is not configured"]]);
  });

  test("releasing a ticket resolves its open questions", async () => {
    const { db } = await tempTurso();
    const { linear, ctx } = setup(db);
    await working(ctx, linear, "DEMO-7");
    await askCoordinator(ctx, { ticket: "DEMO-7", question: "Which store?" });
    await releaseTicket(ctx, { ticket: "DEMO-7", reason: "wrong ticket" });
    expect(await inbox(db)).toEqual([]);
  });
});

describe("the coordinator's inbox", () => {
  test("only the reading coordinator's exact nonempty handle is excluded from silence, not open items", async () => {
    const { db } = await tempTurso();
    for (const [ticket, handle] of [
      ["DEMO-1", "ws-1/s-1"],
      ["DEMO-2", "ws-1/s-2"],
      ["DEMO-3", "ws-2/s-1"],
    ] as const) {
      await saveRuntimeHandle(db, { project: P, ticket, runtime: "Conductor", handle, branch: null, at: at(40) });
    }
    await recordEvent(db, { project: P, ticket: "DEMO-1", kind: "report", phase: "implementing", at: at(30) });
    const options = { project: P, silentAfterMinutes: 15, now: () => NOW };
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
      await addInboxItem(db, {
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
    const { db } = await tempTurso();
    const hold = async (ticket: string, phase: string, minutesAgo: number, kind: "report" | "release" = "report") => {
      await saveRuntimeHandle(db, {
        project: P,
        ticket,
        runtime: "Conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: at(90),
      });
      await recordEvent(db, { project: P, ticket, kind, phase, at: at(minutesAgo) });
    };
    await hold("DEMO-1", "implementing", 40); // silent since 40 min
    await hold("DEMO-2", "awaiting-approval", 60); // waits on the coordinator: not silent
    await hold("DEMO-3", "shipping", 5); // reported recently
    await hold("DEMO-4", "implementing", 50, "release"); // gone
    await hold("DEMO-5", "implementing", 20); // silent, but its question says why
    await addInboxItem(db, {
      project: P,
      ticket: "DEMO-5",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "Which?",
      at: at(20),
    });
    await putHandBack(db, {
      project: P,
      ticket: "DEMO-6",
      author: null,
      body: "Agent status: ready-to-merge — PR #9",
      at: at(55),
    });
    await addInboxItem(db, {
      project: P,
      ticket: "DEMO-9",
      kind: "question",
      recipient: "worker",
      author: null,
      body: "for a worker",
      at: at(70),
    });
    await addInboxItem(db, {
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
    const q = await addInboxItem(db, {
      project: P,
      ticket: "DEMO-8",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "Which?",
      at: at(60),
    });
    await resolveInboxItem(db, { project: P, id: q, resolution: "SQLite", at: at(30) });

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

  test("--wait returns on a new question, and on the timeout; presence is recorded at most once a minute", async () => {
    const { db } = await tempTurso();
    let clock = NOW.getTime();
    const now = () => new Date(clock);
    await saveRuntimeHandle(db, {
      project: P,
      ticket: "DEMO-3",
      runtime: "Conductor",
      handle: "ws-coordinator/session",
      branch: null,
      at: at(14),
    });
    await addInboxItem(db, {
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
      clock += ms;
      if (++sleeps === 3)
        await addInboxItem(db, {
          project: P,
          ticket: "DEMO-2",
          kind: "question",
          recipient: "coordinator",
          author: null,
          body: "new",
          at: now(),
        });
    };

    const got = await checkInbox(db, {
      project: P,
      coordinator: "ws-coordinator/session",
      silentAfterMinutes: 15,
      now,
      wait: { sleep, timeoutMs: 300_000 },
    });
    expect(got.items.map((e) => [e.body, e.new])).toEqual([
      ["old", false],
      ["new", true],
    ]);
    expect([got.wait, clock - NOW.getTime()]).toEqual([{ timeoutSeconds: 300, timedOut: false }, 15_000]);

    const idle = await checkInbox(db, {
      project: P,
      coordinator: "ws-coordinator/session",
      silentAfterMinutes: 15,
      now,
      wait: {
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 150_000,
      },
    });
    expect([idle.wait?.timedOut, idle.items.some((e) => e.new), clock - NOW.getTime()]).toEqual([true, false, 165_000]);
    const seen = await db.execute("SELECT created_at FROM events WHERE kind = 'inbox' ORDER BY id");
    // First call once; second call at its start, then after 60 s and 120 s of waiting.
    expect(seen.rows.length).toBe(4);
    expect(await lastCoordinatorSeen(db, P)).toBe(new Date(NOW.getTime() + 135_000).toISOString());
  });
});
