import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, Submission, SubmissionDraft } from "@earendil-works/pi-durable";
import { followUpEvent } from "../coordinator/follow-ups.ts";
import { type WakeClock, Waker, wakeups } from "../coordinator/wake.ts";
import type { FleetEvent } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";

class Clock implements WakeClock {
  time = Date.parse("2030-01-01T10:00:00.000Z");
  timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.time;
  setTimer = (callback: () => void, delay: number) => {
    const timer = { at: this.time + delay, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      this.timers.delete(next);
      next.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.time = end;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const fake = (submit: (draft: SubmissionDraft) => Promise<void>): Pick<Conversation, "submit"> => ({
  submit: async (draft) => {
    await submit(draft);
    return {} as Submission;
  },
});

const project = "orchard";
const head = "a".repeat(40);
const event = (kind: FleetEvent["kind"], payload: unknown, seq: number, actor = "worker"): FleetEvent =>
  ({ project, kind, payload, seq, actor, at: "2030-01-01T10:00:00.000Z" }) as FleetEvent;
const reading = (events: FleetEvent[]) => ({ tables: fold(events).projects[project], events });

test("wake candidates carry bounded facts for inbox, PR, owner, merge, hold and health transitions", () => {
  const claim = event(
    "session.claimed",
    {
      ticket: "ORC-1",
      session: "s1",
      generation: 1,
      owner: "coordinator",
      runtime: "codex",
      handle: "h",
    },
    1,
  );
  const pr = { number: 12, ticket: "ORC-1", head, state: "open", ci: "pending", conflicting: false };
  const base = [claim, event("pull-request.seen", pr, 2)];
  const cases: [string, FleetEvent[], RegExp][] = [
    ...["hand-back", "question", "plan", "stopped", "silent", "not-started", "deploy", "job", "job-stalled"].map(
      (kind): [string, FleetEvent[], RegExp] => [
        kind,
        [
          event(
            "inbox.opened",
            {
              id: `item-${kind}`,
              ticket: "ORC-1",
              kind,
              body: "Bearer synthetic-private-value",
            },
            3,
          ),
        ],
        new RegExp(kind),
      ],
    ),
    ["checks green", [event("pull-request.seen", { ...pr, ci: "success" }, 3)], /checks.*green/],
    ["checks red", [event("pull-request.seen", { ...pr, ci: "failure" }, 3)], /checks.*red/],
    ["merged", [event("pull-request.seen", { ...pr, state: "merged" }, 3)], /merged/],
    [
      "merge refused",
      [event("merge.refused", { id: "merge-12", pr: 12, head, ticket: "ORC-1", reason: "private" }, 3)],
      /merge refused/,
    ],
    ["hold opened", [event("hold.opened", { id: "hold-1", reason: "private" }, 3, "owner")], /hold added/],
    [
      "owner answered",
      [
        event("inbox.opened", { id: "owner-1", ticket: "ORC-1", kind: "owner-request", body: "private" }, 3),
        event("inbox.answered", { id: "owner-1", answer: "private" }, 4, "owner"),
      ],
      /owner.*answered/,
    ],
    ["main red", [event("default-branch.seen", { branch: "trunk", head, ci: "failure" }, 3, "github")], /trunk.*red/],
    [
      "owner answered worker",
      [
        event("inbox.opened", { id: "worker-q", ticket: "ORC-1", kind: "question", body: "private" }, 3),
        event("inbox.answered", { id: "worker-q", answer: "private" }, 4, "owner"),
      ],
      /owner.*answered/,
    ],
    [
      "owner validation",
      [
        event(
          "validation.opened",
          { id: "validation", ticket: "ORC-1", session: "s1", question: "private", checks: [] },
          3,
        ),
        event("validation.decided", { id: "validation", decision: "approved", note: "private" }, 4, "owner"),
      ],
      /owner decided ORC-1: approved/,
    ],
  ];
  for (const [name, tail, summary] of cases) {
    const candidates = wakeups(reading(base), reading([...base, ...tail]));
    assert.equal(candidates.length, 1, name);
    assert.match(candidates[0]!.summary, summary, name);
    assert.doesNotMatch(JSON.stringify(candidates), /synthetic-private-value|Bearer|private/, name);
    assert.deepEqual(wakeups(reading([...base, ...tail]), reading([...base, ...tail])), [], name);
  }
  const held = [...base, event("hold.opened", { id: "hold-1", reason: "private" }, 3, "owner")];
  assert.match(
    wakeups(
      reading(held),
      reading([...held, event("hold.cleared", { id: "hold-1", reason: "private" }, 4, "owner")]),
    )[0]!.summary,
    /hold cleared/,
  );
  assert.deepEqual(
    wakeups(
      reading(base),
      reading([...base, event("hold.opened", { id: "hold-1", reason: "test" }, 3, "coordinator")]),
    ),
    [],
  );
  assert.deepEqual(wakeups(reading([]), reading([event("pull-request.seen", { ...pr, ci: "success" }, 1)])), []);
  const greenBase = [...base, event("default-branch.seen", { branch: "trunk", head, ci: "success" }, 3, "github")];
  assert.match(
    wakeups(
      reading(greenBase),
      reading([
        ...greenBase,
        event("default-branch.seen", { branch: "trunk", head: "b".repeat(40), ci: "success" }, 4, "github"),
      ]),
    )[0]?.summary ?? "",
    /trunk green/,
  );
});

test("the durable outbox coalesces 10 seconds, steers, retries the same admission and never repeats delivered keys", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  let fail = true;
  const conversation = fake(async (draft) => {
    drafts.push(draft);
    if (fail) throw new Error("uncertain admission");
  });
  let waker = new Waker({ store, project, conversation, clock });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  await clock.advance(60_000);
  assert.equal(store.sequence, 0, "idle startup never appends a fleet event");
  assert.equal(drafts.length, 0, "idle startup never submits a coordinator turn");
  const open = (id: string) =>
    store.append({
      project,
      kind: "inbox.opened",
      actor: "worker",
      at: new Date(clock.now()).toISOString(),
      payload: { id, ticket: "ORC-1", kind: "question", body: "synthetic-private-value" },
    });
  open("first");
  await clock.advance(9000);
  open("second");
  assert.equal(drafts.length, 0);
  await clock.advance(1000);
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0]?.type === "input");
  assert.equal(drafts[0].whenBusy, "steer");
  assert.match(String(drafts[0].content), /^Fleet wake-up:/);
  assert.doesNotMatch(JSON.stringify(drafts), /synthetic-private-value/);
  assert.equal(store.readSince(0).filter((e) => e.kind === "coordinator.wakeup")[0]?.payload.keys.length, 2);
  await waker.close();
  fail = false;
  waker = new Waker({ store, project, conversation, clock });
  await clock.advance(0);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[1], drafts[0], "crash recovery retries the exact durable request");
  await waker.close();
  waker = new Waker({ store, project, conversation, clock });
  open("first");
  await clock.advance(10_000);
  assert.equal(drafts.length, 2, "recorded keys and successful admissions survive a Waker restart");
});

test("quiet reminders wait for both the unanswered threshold and quiet policy, stop after answers, and can be disabled", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const append = (kind: FleetEvent["kind"], payload: unknown, actor = "owner") =>
    store.append({ project, kind, payload, actor, at: new Date(clock.now()).toISOString() } as never);
  append("coordinator.checkpoint", {
    checkpoint: {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 1, value: { policy: { quietMinutes: 3, coordinatorMinutes: 2 } } },
    },
  });
  const waker = new Waker({
    store,
    project,
    conversation: fake(async (draft) => {
      drafts.push(draft);
    }),
    clock,
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  append("inbox.opened", { id: "pending", ticket: "ORC-1", kind: "question", body: "A question" });
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  await clock.advance(179_999);
  assert.equal(drafts.length, 1);
  await clock.advance(1);
  assert.equal(drafts.length, 2);
  assert.match(String(drafts.at(-1)?.type === "input" && drafts.at(-1)?.content), /nothing new/);
  append("inbox.answered", { id: "pending", answer: "Done" }, "coordinator");
  await clock.advance(600_000);
  assert.equal(drafts.length, 2);
  append("coordinator.checkpoint", {
    checkpoint: {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 2, value: { policy: { quietMinutes: 1, coordinatorMinutes: 0 } } },
    },
  });
  append("inbox.opened", { id: "another", ticket: "ORC-2", kind: "question", body: "Another" });
  await clock.advance(10_000);
  assert.equal(drafts.length, 3);
  await clock.advance(600_000);
  assert.equal(drafts.length, 3);
});

test("liveness wakes are generation-scoped, waiting phases stay quiet and fresh reports clear stale notices", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const waker = new Waker({
    store,
    project,
    conversation: fake(async (draft) => {
      drafts.push(draft);
    }),
    clock,
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  store.append(
    event(
      "session.claimed",
      { ticket: "ORC-1", session: "s1", generation: 1, owner: "coordinator", runtime: "codex", handle: "h" },
      1,
    ),
  );
  await clock.advance(15 * 60_000 + 10_001);
  assert.equal(drafts.length, 1);
  assert.match(JSON.stringify(drafts[0]), /silent ORC-1/);
  store.append({
    project,
    kind: "session.reported",
    at: new Date(clock.now()).toISOString(),
    actor: "worker",
    payload: { ticket: "ORC-1", session: "s1", phase: "awaiting-approval", reason: "Waiting for plan approval" },
  });
  await clock.advance(1);
  assert.equal(fold(store.readSince(0)).projects[project]?.inbox.length, 0);
  await clock.advance(60 * 60_000);
  assert.equal(drafts.length, 1);
  store.append({
    project,
    kind: "session.runtime-observed",
    at: new Date(clock.now()).toISOString(),
    actor: "observer",
    payload: { ticket: "ORC-1", session: "old", generation: 0, state: "stopped" },
  });
  await clock.advance(10_000);
  assert.equal(drafts.length, 1, "a stale generation cannot stop the current worker");
});

test("a large burst stays bounded for the model and room while retaining every durable key", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const waker = new Waker({
    store,
    project,
    clock,
    conversation: fake(async (draft) => {
      assert.ok(draft.type === "input");
      assert.ok(String(draft.content).length < 16 * 1024);
      drafts.push(draft);
    }),
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  for (let n = 0; n < 60; n++) {
    store.append({
      project,
      kind: "inbox.opened",
      actor: "worker",
      at: new Date(clock.now()).toISOString(),
      payload: { id: `item-${n}`, ticket: "ORC-1", kind: "question", body: "private".repeat(4000) },
    });
  }
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  assert.match(JSON.stringify(drafts[0]), /40 more changes/);
  assert.doesNotMatch(JSON.stringify(drafts[0]), /private/);
  const body = (drafts[0]?.type === "input" ? drafts[0].entry?.data : null) as { body: string };
  assert.ok(body.body.length < 600);
  const recorded = store.readSince(0).find((e) => e.kind === "coordinator.wakeup");
  assert.ok(recorded?.kind === "coordinator.wakeup");
  assert.equal(recorded.payload.keys.length, 60);
});

test("answering an older generation does not defer the replacement's silence deadline", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const start = clock.now();
  const append = (kind: FleetEvent["kind"], payload: unknown, minute: number, actor = "worker") =>
    store.append({ project, kind, payload, actor, at: new Date(start + minute * 60_000).toISOString() } as never);
  append(
    "session.claimed",
    { ticket: "ORC-1", session: "old", generation: 1, owner: "coordinator", runtime: "codex", handle: "old" },
    0,
  );
  append("inbox.opened", { id: "old-question", ticket: "ORC-1", kind: "question", body: "An old question" }, 0);
  append(
    "session.claimed",
    { ticket: "ORC-1", session: "new", generation: 2, owner: "coordinator", runtime: "codex", handle: "new" },
    1,
  );
  append("inbox.answered", { id: "old-question", answer: "An old answer" }, 10, "owner");
  clock.time = start + 10 * 60_000;
  const drafts: SubmissionDraft[] = [];
  const waker = new Waker({
    store,
    project,
    clock,
    conversation: fake(async (draft) => {
      drafts.push(draft);
    }),
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  await clock.advance(6 * 60_000 + 10_001);
  assert.equal(drafts.length, 1);
  assert.match(JSON.stringify(drafts[0]), /silent ORC-1/);
});

test("an answer from before a replacement launch does not wake the unclaimed replacement", () => {
  const old = [
    event(
      "session.claimed",
      { ticket: "ORC-1", session: "old", generation: 1, owner: "coordinator", runtime: "codex", handle: "old" },
      1,
    ),
    event("inbox.opened", { id: "old-q", ticket: "ORC-1", kind: "question", body: "Old question" }, 2),
    event(
      "coordinator.checkpoint",
      {
        checkpoint: {
          format: "armada.worker",
          version: 1,
          type: "launch-intent",
          ticket: "ORC-1",
          session: "replacement",
          generation: 2,
          runtime: "codex",
          step: "preparing",
        },
      },
      3,
      "coordinator",
    ),
  ];
  assert.equal(reading(old).tables?.sessions[0]?.session, "replacement");
  assert.deepEqual(
    wakeups(
      reading(old),
      reading([...old, event("inbox.answered", { id: "old-q", answer: "Late answer" }, 4, "owner")]),
    ),
    [],
  );
});

for (const phase of ["blocked", "awaiting-approval", "awaiting-validation"] as const) {
  test(`a current-generation answer starts a fresh silence window while phase remains ${phase}`, async (t) => {
    const store = new EventStore(":memory:");
    const clock = new Clock();
    const append = (kind: FleetEvent["kind"], payload: unknown, actor = "coordinator") =>
      store.append({ project, kind, payload, actor, at: new Date(clock.now()).toISOString() } as never);
    append("coordinator.checkpoint", {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: { revision: 1, value: { policy: { coordinatorMinutes: 0 } } },
      },
    });
    append("session.claimed", {
      ticket: "ORC-1",
      session: "s1",
      generation: 1,
      owner: "coordinator",
      runtime: "codex",
      handle: "h",
    });
    append("session.reported", { ticket: "ORC-1", session: "s1", phase, reason: "Waiting" });
    if (phase === "awaiting-validation")
      append("validation.opened", { id: "reply", ticket: "ORC-1", session: "s1", question: "Check this", checks: [] });
    else
      append("inbox.opened", {
        id: "reply",
        ticket: "ORC-1",
        kind: phase === "blocked" ? "question" : "plan",
        body: "Waiting for an answer",
      });
    const drafts: SubmissionDraft[] = [];
    const waker = new Waker({
      store,
      project,
      clock,
      conversation: fake(async (draft) => {
        drafts.push(draft);
      }),
    });
    t.after(async () => {
      await waker.close();
      store.close();
    });
    await clock.advance(60 * 60_000);
    const initial = phase === "awaiting-validation" ? 0 : 1;
    assert.equal(drafts.length, initial, "an unanswered waiting phase is legitimate");
    if (phase === "awaiting-validation")
      append("validation.decided", { id: "reply", decision: "approved", note: "Ready" }, "owner");
    else append("inbox.answered", { id: "reply", answer: "Proceed" });
    await clock.advance(10_000);
    const answered = initial + (phase === "awaiting-validation" ? 1 : 0);
    assert.equal(drafts.length, answered);
    await clock.advance(14 * 60_000);
    assert.equal(drafts.length, answered, "the stale heartbeat cannot make the fresh answer immediately silent");
    await clock.advance(60_000 + 10_001);
    assert.equal(drafts.length, answered + 1);
    assert.match(JSON.stringify(drafts.at(-1)), /silent ORC-1/);
  });
}

const oldBoot = "00000000-0000-4000-8000-000000000001";
const newBoot = "00000000-0000-4000-8000-000000000002";
for (const lost of [false, true])
  test(`first wake coalesces restart recovery and never replays an older boot: lost=${lost}`, async (t) => {
    const store = new EventStore(":memory:");
    const clock = new Clock();
    const append = (kind: FleetEvent["kind"], payload: unknown) => store.append(event(kind, payload, 1, "daemon"));
    const marker = (boot: string) =>
      append("coordinator.checkpoint", { checkpoint: { format: "armada.worker", version: 1, type: "recovery", boot } });
    const tickets = lost ? ["ORC-1", "ORC-2", "ORC-3"] : ["ORC-1", "ORC-2"];
    for (const [index, ticket] of tickets.entries())
      append("session.claimed", {
        ticket,
        session: `s${index}`,
        generation: 1,
        owner: "coordinator",
        runtime: "codex",
        handle: `h${index}`,
      });
    marker(oldBoot);
    append("worker.lost", {
      ticket: "ORC-1",
      session: "s0",
      generation: 1,
      handle: "h0",
      boot: oldBoot,
      reason: "Bearer synthetic-private-value",
    });
    marker(newBoot);
    for (const [index, ticket] of ["ORC-1", "ORC-2"].entries())
      append("worker.readopted", {
        ticket,
        session: `s${index}`,
        generation: 1,
        handle: `h${index}`,
        boot: newBoot,
        ...(index === 0 ? { briefPending: true } : {}),
      });
    if (lost)
      append("worker.lost", {
        ticket: "ORC-3",
        session: "s2",
        generation: 1,
        handle: "h2",
        boot: newBoot,
        reason: "Bearer synthetic-private-value",
      });
    const sent: SubmissionDraft[] = [];
    const conversation = fake(async (draft) => {
      sent.push(draft);
    });
    let waker = new Waker({ store, project, clock, conversation });
    t.after(async () => {
      await waker.close();
      store.close();
    });
    await clock.advance(10_000);
    assert.equal(sent.length, 1);
    const content = JSON.stringify(sent[0]);
    assert.match(content, /2 workers re-adopted/);
    assert.match(content, /ORC-1/);
    assert.match(content, /ORC-2/);
    assert.match(content, /needs initial brief/);
    assert.match(content, lost ? /1 worker lost/ : /0 workers lost/);
    if (lost) assert.match(content, /ORC-3/);
    assert.doesNotMatch(content, /Bearer|synthetic-private-value/);
    assert.equal(store.readSince(0).filter((e) => e.kind === "coordinator.wakeup").length, 1);
    await waker.close();
    waker = new Waker({ store, project, clock, conversation });
    await clock.advance(10_000);
    assert.equal(sent.length, 1, "the same boot is not delivered twice");
    await waker.close();
    for (const [index, ticket] of tickets.entries())
      append("session.released", { ticket, session: `s${index}`, reason: "Finished" });
    marker("00000000-0000-4000-8000-000000000003");
    waker = new Waker({ store, project, clock, conversation });
    await clock.advance(10_000);
    assert.equal(sent.length, 1, "an empty new boot suppresses older recovery history");
  });

test("this boot's recovery wake precedes an older undelivered outbox without changing its identity", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const append = (kind: FleetEvent["kind"], payload: unknown) => store.append(event(kind, payload, 1, "daemon"));
  append("coordinator.wakeup", {
    id: "old-wake",
    keys: ["old-key"],
    candidates: [{ key: "old-key", summary: "old hand-back", facts: { state: "hand-back" } }],
  });
  for (const [index, ticket] of ["ORC-1", "ORC-2"].entries())
    append("session.claimed", {
      ticket,
      session: `s${index}`,
      generation: 1,
      owner: "coordinator",
      runtime: "codex",
      handle: `h${index}`,
    });
  append("coordinator.checkpoint", {
    checkpoint: { format: "armada.worker", version: 1, type: "recovery", boot: newBoot },
  });
  for (const [index, ticket] of ["ORC-1", "ORC-2"].entries())
    append("worker.readopted", { ticket, session: `s${index}`, generation: 1, handle: `h${index}`, boot: newBoot });
  const sent: SubmissionDraft[] = [];
  const waker = new Waker({
    store,
    project,
    clock,
    conversation: fake(async (draft) => {
      sent.push(draft);
    }),
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  await clock.advance(10_000);
  assert.equal(sent.length, 2);
  assert.match(JSON.stringify(sent[0]), /2 workers re-adopted/);
  assert.equal(sent[1]!.requestId, "old-wake");
  assert.match(JSON.stringify(sent[1]), /old hand-back/);
  assert.equal(store.readSince(0).filter((e) => e.kind === "coordinator.wakeup").length, 2);
});

test("a derived delivery failure wakes once, stays coalesced on retry, and closes on send", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const waker = new Waker({
    store,
    project,
    clock,
    conversation: fake(async (draft) => {
      drafts.push(draft);
    }),
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  const base = { project, actor: "worker", at: new Date(clock.now()).toISOString() };
  store.append({
    ...base,
    kind: "session.claimed",
    payload: {
      ticket: "ORC-1",
      session: "one",
      generation: 1,
      owner: "coordinator",
      runtime: "codex",
      handle: "local/one",
    },
  });
  store.append({
    ...base,
    kind: "delivery.queued",
    payload: {
      id: "answer",
      ticket: "ORC-1",
      session: "one",
      generation: 1,
      source: "owner-answer",
      text: "Private answer",
      key: "answer",
    },
  });
  const fail = (attempt: number) =>
    store.append({
      ...base,
      actor: "delivery",
      at: new Date(clock.now()).toISOString(),
      kind: "delivery.failed",
      payload: {
        id: "answer",
        attempt,
        error: "Worker unavailable",
        nextAt: new Date(clock.now() + 60_000).toISOString(),
      },
    });
  fail(1);
  fail(2);
  await clock.advance(10_000);
  assert.equal(drafts.length, 0);
  fail(3);
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  assert.match(JSON.stringify(drafts[0]), /delivery-failed ORC-1/);
  assert.doesNotMatch(JSON.stringify(drafts[0]), /Private answer|Worker unavailable/);
  const item = fold(store.readSince(0)).projects[project]?.inbox[0];
  assert.equal(item?.kind, "delivery-failed");
  fail(4);
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  assert.equal(fold(store.readSince(0)).projects[project]?.inbox[0]?.id, item?.id);
  store.append({
    ...base,
    actor: "delivery",
    kind: "delivery.sent",
    payload: { id: "answer", at: new Date(clock.now()).toISOString() },
  });
  await clock.advance(10_000);
  assert.deepEqual(fold(store.readSince(0)).projects[project]?.inbox, []);
  assert.equal(drafts.length, 1);
});

test("identical wake facts persist across restart, escalate once on attempt three, and new facts wake", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const conversation = fake(async (draft) => {
    drafts.push(draft);
  });
  const append = (kind: FleetEvent["kind"], payload: unknown) =>
    store.append({ project, kind, payload, actor: "reader", at: new Date(clock.now()).toISOString() } as never);
  append("coordinator.checkpoint", {
    checkpoint: {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 1, value: { policy: { coordinatorMinutes: 0 } } },
    },
  });
  append("ticket.seen", { id: "ORC-1", title: "Plant", status: "started", phase: "ready-to-merge" });
  let waker = new Waker({ store, project, conversation, clock });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  const checks = (ci: string, prHead = head) =>
    append("pull-request.seen", { number: 12, ticket: "ORC-1", head: prHead, state: "open", ci, conflicting: false });
  checks("success");
  await waker.close();
  waker = new Waker({ store, project, conversation, clock });
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  checks("pending");
  checks("success");
  await clock.advance(10_000);
  assert.equal(drafts.length, 1, "same facts do not submit another turn");
  await waker.close();
  waker = new Waker({ store, project, conversation, clock });
  checks("pending");
  checks("success");
  await clock.advance(10_000);
  const followUps = fold(store.readSince(0)).projects[project]!.inbox.filter((i) => i.kind === "follow-up");
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0]?.followUp?.attempts, 3);
  assert.equal(drafts.length, 1, "escalation does not repeat the Woke line");
  checks("success", "b".repeat(40));
  await clock.advance(10_000);
  assert.equal(drafts.length, 2, "changed evidence wakes again");
  for (let i = 0; i < 2; i++) {
    checks("pending", "b".repeat(40));
    checks("success", "b".repeat(40));
    await clock.advance(10_000);
  }
  const beforeRollover = fold(store.readSince(0)).projects[project]?.inbox.find((i) => i.kind === "follow-up");
  assert.equal(beforeRollover?.followUp?.attempts, 3);
  await clock.advance(3_600_000);
  checks("pending", "b".repeat(40));
  checks("success", "b".repeat(40));
  await clock.advance(10_000);
  assert.equal(drafts.length, 3, "identical evidence may wake again after an hour");
  const afterRollover = fold(store.readSince(0)).projects[project]?.inbox.find((i) => i.kind === "follow-up");
  assert.equal(afterRollover?.followUp?.attempts, 4, "an open cause keeps a monotonic count across wake windows");
  assert.notEqual(afterRollover?.followUp?.lastAt, beforeRollover?.followUp?.lastAt);
  await clock.advance(3_600_000);
  for (let i = 0; i < 3; i++) {
    checks("pending", "b".repeat(40));
    checks("success", "b".repeat(40));
  }
  await clock.advance(10_000);
  const batched = fold(store.readSince(0)).projects[project]?.inbox.find((i) => i.kind === "follow-up");
  assert.equal(batched?.followUp?.attempts, 7, "every coalesced repeat is counted across hour rollover");
});

test("coalescing checkpoints the latest same-key facts and retains attempt counts before flush", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const conversation = fake(async (draft) => {
    drafts.push(draft);
  });
  const append = (kind: FleetEvent["kind"], payload: unknown) =>
    store.append({ project, kind, payload, actor: "reader", at: new Date(clock.now()).toISOString() } as never);
  append("coordinator.checkpoint", {
    checkpoint: {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 1, value: { policy: { coordinatorMinutes: 0 } } },
    },
  });
  let waker = new Waker({ store, project, conversation, clock });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  const refused = (id: string, prHead: string) =>
    append("merge.refused", { id, pr: 12, ticket: "ORC-1", head: prHead, reason: "Hand-back gap" });
  refused("merge-12", head);
  refused("merge-12", "b".repeat(40));
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  assert.match(JSON.stringify(drafts[0]), new RegExp("b".repeat(40)));
  refused("merge-12", "b".repeat(40));
  await clock.advance(10_000);
  assert.equal(drafts.length, 1, "coalesced facts cannot immediately submit another turn");
  await waker.close();
  waker = new Waker({ store, project, conversation, clock });
  refused("merge-12", "b".repeat(40));
  await clock.advance(10_000);
  assert.equal(drafts.length, 1, "facts already delivered during coalescing cannot wake again after restart");
  for (let i = 0; i < 3; i++) refused("merge-13", head);
  await clock.advance(10_000);
  const item = fold(store.readSince(0)).projects[project]?.inbox.find(
    (i) => i.followUp?.candidate === "merge-refused:merge-13",
  );
  assert.equal(item?.followUp?.attempts, 3);
});

test("an untold follow-up wakes once when overdue and its owner receipt stops reminders", async (t) => {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const drafts: SubmissionDraft[] = [];
  const at = () => new Date(clock.now()).toISOString();
  store.append({
    project,
    at: at(),
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: { revision: 1, value: { policy: { coordinatorMinutes: 1, quietMinutes: 10 } } },
      },
    },
  });
  store.append(
    followUpEvent([], project, at(), "ORC-1", {
      tool: "worker.launch",
      code: "capability_missing",
      reason: "no runtime provider enabled",
      facts: "ORC-1 not launched",
      next: "fleet.status",
      fix: "Enable Conductor in Settings › Providers",
    }),
  );
  let waker = new Waker({
    store,
    project,
    clock,
    conversation: fake(async (draft) => {
      drafts.push(draft);
    }),
  });
  t.after(async () => {
    await waker.close();
    store.close();
  });
  await clock.advance(59_000);
  assert.equal(drafts.length, 0);
  await clock.advance(1_000);
  assert.equal(drafts.length, 1, "follow-ups need not wait for the ordinary quiet window");
  assert.match(JSON.stringify(drafts[0]), /follow-up/);
  await clock.advance(10_000);
  assert.equal(
    store.readSince(0, project).filter((event) => event.kind === "coordinator.wakeup").length,
    1,
    "a pending owner report must not schedule a millisecond wake loop",
  );
  const item = store.fold(project).projects[project]?.inbox[0];
  assert.ok(item?.followUp);
  store.append({
    project,
    actor: "coordinator",
    at: at(),
    kind: "inbox.opened",
    payload: {
      id: item.id,
      ticket: item.ticket,
      kind: "follow-up",
      body: item.body,
      followUp: { ...item.followUp, toldOwnerAt: at() },
    },
  });
  await clock.advance(10_000);
  assert.equal(drafts.length, 1);
  store.append({
    project,
    actor: "coordinator",
    at: at(),
    kind: "inbox.answered",
    payload: { id: item.id, answer: "Recovered" },
  });
  const { toldOwnerAt: _receipt, ...detail } = item.followUp;
  store.append(followUpEvent(store.readSince(0, project), project, at(), item.ticket, detail));
  await waker.close();
  waker = new Waker({
    store,
    project,
    clock,
    conversation: fake(async (draft) => {
      drafts.push(draft);
    }),
  });
  await clock.advance(59_000);
  assert.equal(drafts.length, 1);
  await clock.advance(1_000);
  assert.equal(drafts.length, 2, "a reopened cause gets a new reminder deadline, including after restart");
  const reopened = store.fold(project).projects[project]?.inbox[0];
  assert.ok(reopened?.followUp);
  store.append({
    project,
    actor: "coordinator",
    at: at(),
    kind: "inbox.opened",
    payload: {
      id: reopened.id,
      ticket: reopened.ticket,
      kind: "follow-up",
      body: reopened.body,
      followUp: { ...reopened.followUp, toldOwnerAt: at() },
    },
  });
  await clock.advance(20 * 60_000);
  assert.equal(drafts.length, 2);
});
