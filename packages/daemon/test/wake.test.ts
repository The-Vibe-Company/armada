import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, Submission, SubmissionDraft } from "@earendil-works/pi-durable";
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
