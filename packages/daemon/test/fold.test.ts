import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventInput, FleetEvent } from "../src/events.ts";
import { FOLD_VERSION, FoldAccumulator, fold } from "../src/fold.ts";

const at = "2030-01-01T10:00:00Z";
const ref = { ticket: "SEED-7", session: "sprout" };
function log(...inputs: EventInput[]): FleetEvent[] {
  return inputs.map((input, i) => ({ ...input, seq: i + 1 }));
}
function event<K extends EventInput["kind"]>(
  kind: K,
  payload: Extract<EventInput, { kind: K }>["payload"],
  project = "orchard",
): EventInput {
  return { project, kind, at, actor: "Mira", payload } as EventInput;
}
const claimed = event("session.claimed", { ...ref, generation: 1, owner: "Mira", runtime: "local", handle: "pane-a" });

test("sessions retain reasons and flow through blocked, owner decision, review, CI and merge states", () => {
  const events = log(
    event("ticket.seen", { id: ref.ticket, title: "Grow a canopy", status: "started" }),
    claimed,
    event("session.reported", { ...ref, phase: "implementing", reason: "Growing" }),
    event("session.reported", { ...ref, phase: "blocked", reason: "Need shade" }),
  );
  const blocked = fold(events).projects.orchard;
  assert.equal(blocked?.sessionsByState.blocked[0]?.reason, "Need shade");
  assert.equal(blocked?.sessions[0]?.flowStep, "implementing");
  const append = (input: EventInput) => events.push({ ...input, seq: events.length + 1 });
  append(event("session.reported", { ...ref, phase: "awaiting-approval", reason: "Approve the canopy" }));
  assert.equal(fold(events).projects.orchard?.sessionsByState["waiting-for-owner"][0]?.step, 1);
  append(event("session.reported", { ...ref, phase: "shipping", reason: "Review", stage: "review" }));
  assert.equal(fold(events).projects.orchard?.sessions[0]?.flowStep, "review");
  append(
    event("pull-request.seen", {
      number: 8,
      ticket: ref.ticket,
      state: "open",
      ci: "failure",
      conflicting: false,
      head: "abc",
    }),
  );
  assert.equal(fold(events).projects.orchard?.sessions[0]?.state, "blocked");
  append(event("session.reported", { ...ref, phase: "shipping", reason: "Running checks", stage: "ci" }));
  assert.equal(fold(events).projects.orchard?.sessions[0]?.step, 4);
  assert.equal(fold(events).projects.orchard?.sessions[0]?.flowStep, "ci");
  append(
    event("pull-request.seen", {
      number: 8,
      ticket: ref.ticket,
      state: "open",
      ci: "success",
      conflicting: false,
      head: "abc",
    }),
  );
  append(event("session.reported", { ...ref, phase: "ready-to-merge", reason: "All green" }));
  assert.equal(fold(events).projects.orchard?.sessionsByState["ready-to-merge"].length, 1);
  append(event("merge.confirmed", { ...ref, id: "merge-a", pr: 8, head: "abc" }));
  assert.equal(fold(events).projects.orchard?.sessionsByState.merged[0]?.step, 5);
});

test("inbox answers resolve only the matching project's request", () => {
  const events = log(
    event("inbox.opened", { id: "water", ticket: ref.ticket, kind: "question", body: "Water now?" }),
    event("inbox.opened", { id: "water", ticket: "SHIP-2", kind: "owner-request", body: "Sail?" }, "harbor"),
    event("inbox.answered", { id: "water", answer: "Yes" }),
  );
  assert.deepEqual(fold(events).projects.orchard?.inbox, []);
  assert.equal(fold(events).projects.harbor?.inbox[0]?.body, "Sail?");
});

test("merge queue stays FIFO and removes only confirmed, refused or canceled entries", () => {
  const events = log(
    event("merge.queued", { ...ref, id: "one", pr: 8, head: "abc" }),
    event("merge.queued", { ...ref, id: "two", pr: 9, head: "def" }),
    event("merge.started", { id: "one" }),
  );
  assert.deepEqual(
    fold(events).projects.orchard?.queue.map((q) => [q.id, q.state]),
    [
      ["one", "running"],
      ["two", "queued"],
    ],
  );
  events.push(
    { ...event("merge.confirmed", { ...ref, id: "one", pr: 8, head: "abc" }), seq: 4 },
    { ...event("merge.refused", { id: "two", reason: "Head changed" }), seq: 5 },
  );
  assert.deepEqual(fold(events).projects.orchard?.queue, []);
});

test("holds remain open until an explicit clear, independently of other holds", () => {
  const tables = fold(
    log(
      event("hold.opened", { id: "rain", reason: "Wait for CI" }),
      event("hold.opened", { id: "wind", reason: "Deploy pending" }),
      event("hold.cleared", { id: "rain", reason: "Green" }),
    ),
  );
  assert.deepEqual(
    tables.projects.orchard?.holds.map((h) => [h.id, h.reason]),
    [["wind", "Deploy pending"]],
  );
});

test("validations wait for a decision and keep its note and owner while updating session state", () => {
  const events = log(
    claimed,
    event("session.reported", { ...ref, phase: "awaiting-validation", reason: "Owner check" }),
    event("validation.opened", { ...ref, id: "canopy", question: "Enough shade?", checks: ["Read the leaf"] }),
  );
  assert.equal(fold(events).projects.orchard?.sessions[0]?.state, "waiting-for-owner");
  events.push({
    ...event("validation.decided", { id: "canopy", decision: "changes-requested", note: "More leaves" }),
    seq: 4,
  });
  const result = fold(events).projects.orchard;
  assert.equal(result?.validations[0]?.decision?.note, "More leaves");
  assert.equal(result?.validations[0]?.decision?.actor, "Mira");
  assert.equal(result?.sessions[0]?.state, "in-progress");
  assert.equal(result?.sessions[0]?.reason, "More leaves");
});

test("replay is pure and old generation reports, heartbeats and releases cannot change its replacement", () => {
  const events = log(
    claimed,
    event("session.claimed", {
      ...ref,
      session: "tree",
      generation: 2,
      owner: "Ivo",
      runtime: "local",
      handle: "pane-b",
    }),
    event("session.reported", { ...ref, phase: "blocked", reason: "Old turn" }),
    event("session.heartbeat", ref),
    event("session.released", { ...ref, reason: "Old cleanup" }),
    claimed,
  );
  for (const e of events) {
    Object.freeze(e.payload);
    Object.freeze(e);
  }
  Object.freeze(events);
  const result = fold(events);
  assert.equal(result.seq, 6);
  assert.deepEqual(
    result.projects.orchard?.sessions.map((s) => [s.session, s.owner, s.phase]),
    [["tree", "Ivo", "planning"]],
  );
  assert.deepEqual(fold(events), result);
  assert.throws(() => fold(events.slice(0, 2).reverse()), /sequence/);
});

test("tracker-only phase observations form sessions before a local worker has claimed", () => {
  const events = log(
    event("ticket.seen", {
      id: "SEED-9",
      title: "Plant",
      status: "started",
      phase: "shipping",
      reason: "Checking",
      owner: "Ivo",
    }),
  );
  assert.equal(fold(events).projects.orchard?.sessions[0]?.phase, "shipping");
  events.push({
    ...event("ticket.seen", { id: "SEED-9", title: "Plant", status: "completed", phase: "merged", owner: "Ivo" }),
    seq: 2,
  });
  assert.equal(fold(events).projects.orchard?.sessions[0]?.state, "merged");
});

// A delayed claim can be the first time this old session ID appears in the log.
test("a late old claim cannot replace a higher generation even when it was never seen before", () => {
  const events = log(
    event("session.claimed", {
      ...ref,
      session: "tree",
      generation: 2,
      owner: "Ivo",
      runtime: "local",
      handle: "pane-b",
    }),
    claimed,
    event("session.reported", { ...ref, session: "tree", phase: "implementing", reason: "Still growing" }),
  );
  assert.deepEqual(
    fold(events).projects.orchard?.sessions.map((s) => [s.session, s.phase, s.reason]),
    [["tree", "implementing", "Still growing"]],
  );
});

test("a merged PR completes its session, but cannot complete a later launch or claim of the same ticket", () => {
  const events: EventInput[] = [
    {
      project: "orchard",
      kind: "session.claimed",
      at,
      actor: "worker",
      payload: {
        ticket: "SEED-1",
        session: "old",
        generation: 1,
        owner: "Mira",
        runtime: "codex",
        handle: "local/old",
      },
    },
    {
      project: "orchard",
      kind: "pull-request.seen",
      at,
      actor: "forge",
      payload: {
        number: 41,
        ticket: "SEED-1",
        head: "a".repeat(40),
        state: "merged",
        ci: "failure",
        conflicting: true,
      },
    },
  ];
  const reading = () => fold(events.map((e, i) => ({ ...e, seq: i + 1 }))).projects.orchard;
  assert.equal(reading()?.sessions[0]?.state, "merged");
  events.push({
    project: "orchard",
    kind: "coordinator.checkpoint",
    at,
    actor: "coordinator",
    payload: {
      checkpoint: {
        format: "armada.worker",
        version: 1,
        type: "launch-intent",
        ticket: "SEED-1",
        session: "new",
        generation: 2,
        runtime: "codex",
        step: "preparing",
      },
    },
  });
  assert.equal(reading()?.sessions[0]?.state, "in-progress");
  assert.equal(reading()?.sessions[0]?.reason, "Preparing workspace");
  events.push({
    project: "orchard",
    kind: "session.claimed",
    at,
    actor: "worker",
    payload: { ticket: "SEED-1", session: "new", generation: 2, owner: "Mira", runtime: "codex", handle: "local/new" },
  });
  // Repeated observations of the already merged PR do not make it belong to this claim.
  events.push(events[1] as EventInput);
  const current = reading()?.sessions[0];
  assert.equal(current?.session, "new");
  assert.equal(current?.phase, "planning");
  assert.equal(current?.state, "in-progress");
  assert.equal(current?.flowStep, "plan");
});

test("incremental readings isolate retained snapshots and input while preserving every prefix and sequence gap", () => {
  const events = log(
    event("ticket.created", {
      id: "SEED-7",
      title: "Plant",
      description: "",
      labels: [],
      state: "started",
      parent: null,
      blockers: ["SEED-8"],
    }),
    event("ticket.created", {
      id: "SEED-8",
      title: "Water",
      description: "",
      labels: [],
      state: "backlog",
      parent: null,
      blockers: [],
    }),
    claimed,
    event("session.reported", { ...ref, phase: "blocked", reason: "Need water" }),
    event("inbox.opened", { id: "water", ticket: ref.ticket, kind: "question", body: "Water now?" }),
    event("inbox.answered", { id: "water", answer: "Yes" }),
    event("ticket.edited", { ticket: "SEED-8", patch: { state: "completed" } }),
    event("session.claimed", {
      ...ref,
      session: "tree",
      generation: 2,
      owner: "Mira",
      runtime: "codex",
      handle: "new",
    }),
    event("session.reported", { ...ref, phase: "ready-to-merge", reason: "stale generation" }),
    event("coordinator.checkpoint", {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: { revision: 1, value: { policy: { plans: "approve" } } },
      },
    }),
    event("coordinator.checkpoint", { checkpoint: { format: "armada.readers", version: 1, provider: "linear" } }),
    event("tracker.import-started", {
      id: "import-1",
      programRoot: "SEED-1",
      state: "running",
      imported: 0,
      skipped: 0,
      comments: 0,
      total: 1,
    }),
    event("tracker.import-progress", {
      id: "import-1",
      programRoot: "SEED-1",
      state: "running",
      imported: 1,
      skipped: 0,
      comments: 1,
      total: 1,
      source: "SEED-7",
    }),
    event("tracker.import-ended", {
      id: "import-1",
      programRoot: "SEED-1",
      state: "completed",
      imported: 1,
      skipped: 0,
      comments: 1,
      total: 1,
    }),
  ).map((e) => ({ ...e, seq: e.seq * 2 }));
  const replay = new FoldAccumulator();
  const snapshots = [];
  for (const [index, e] of events.entries()) {
    replay.append(e);
    const snapshot = replay.snapshot();
    assert.deepEqual(snapshot, fold(events.slice(0, index + 1)), `prefix ${index + 1}`);
    snapshots.push(snapshot);
    const state = snapshot.projects.orchard;
    assert.ok(state);
    state.tickets[0]!.title = "Caller mutation";
    if (state.rules) state.rules.revision = 999;
    if (state.trackerImport) state.trackerImport.imported = 999;
  }
  const current = replay.snapshot().projects.orchard;
  assert.equal(current?.tickets[0]?.title, "Plant");
  assert.equal(current?.tickets[0]?.blockers?.[0]?.status, "completed");
  assert.equal(current?.sessions[0]?.phase, "planning", "old generation never replaces the current reading");
  assert.deepEqual(current?.trackerImport, {
    id: "import-1",
    programRoot: "SEED-1",
    state: "completed",
    imported: 1,
    skipped: 0,
    comments: 1,
    total: 1,
  });
  assert.equal(
    snapshots[3]?.projects.orchard?.sessions[0]?.phase,
    "blocked",
    "later events never mutate a retained reading",
  );
  events[0]!.payload = { ...events[0]!.payload, title: "Changed source" } as (typeof events)[0]["payload"];
  assert.equal(replay.snapshot().projects.orchard?.tickets[0]?.title, "Plant");
  assert.equal(replay.snapshot().projects.constructor, undefined);
  assert.throws(() => replay.append(events[0]!), /sequence/);
  assert.throws(() => replay.append({ ...events[0]!, seq: 2.5 }), /sequence/);
});

test("fifteen stale conflicting PRs reconcile to zero open after terminal observations", () => {
  const payloads = Array.from({ length: 15 }, (_, index) => ({
    number: index + 10,
    ticket: `SEED-${index + 1}`,
    repository: "example/orchard",
    title: "Grow",
    url: `https://github.com/example/orchard/pull/${index + 10}`,
    headRef: `feature/seed-${index + 1}`,
    head: "a".repeat(40),
    state: "open" as const,
    ci: "pending" as const,
    conflicting: true,
    draft: false,
    review: "none" as const,
    checks: [],
    checksComplete: true,
  }));
  const inputs: EventInput[] = payloads.map((payload) =>
    event("pull-request.conflicting", {
      ...payload,
      pr: payload.number,
      key: `conflict-${payload.number}`,
    }),
  );
  assert.equal(fold(log(...inputs)).projects.orchard?.pullRequests.filter((pr) => pr.state === "open").length, 15);
  inputs.push(
    ...payloads.map((payload) =>
      event("pull-request.merged", {
        ...payload,
        state: "merged",
        mergeCommit: "c".repeat(40),
        mergedAt: "2030-01-01T10:30:00Z",
      }),
    ),
  );
  const project = fold(log(...inputs)).projects.orchard;
  assert.equal(project?.pullRequests.length, 15);
  assert.equal(project?.pullRequests.filter((pr) => pr.state === "open").length, 0);
});

test("a merge first discovered after a replacement claim cannot complete that generation", () => {
  const payload = {
    number: 10,
    ticket: ref.ticket,
    repository: "example/orchard",
    title: "Grow",
    url: "https://github.com/example/orchard/pull/10",
    headRef: "feature/seed-7",
    head: "a".repeat(40),
    state: "open" as const,
    ci: "success" as const,
    conflicting: true,
    draft: false,
    review: "none" as const,
    checks: [],
    checksComplete: true,
  };
  const inputs: EventInput[] = [
    claimed,
    event("pull-request.conflicting", { ...payload, pr: 10, key: "conflict-10" }),
    {
      ...event("session.claimed", {
        ...ref,
        session: "new",
        generation: 2,
        owner: "Mira",
        runtime: "codex",
        handle: "new",
      }),
      at: "2030-01-02T10:00:00Z",
    },
  ];
  assert.equal(fold(log(...inputs)).projects.orchard?.sessions[0]?.phase, "planning");
  inputs.push({
    ...event("pull-request.merged", {
      ...payload,
      state: "merged",
      mergeCommit: "c".repeat(40),
      mergedAt: "2030-01-01T11:00:00Z",
    }),
    at: "2030-01-02T12:00:00Z",
  });
  const session = fold(log(...inputs)).projects.orchard?.sessions[0];
  assert.equal(session?.session, "new");
  assert.equal(session?.phase, "planning");
});

test("a serialized reading restores to the same fold at every prefix, and refuses another version or shape", () => {
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const checkpoint = (actor: string, checkpoint: unknown, extra: Record<string, unknown> = {}): EventInput =>
    ({
      project: "orchard",
      kind: "coordinator.checkpoint",
      at,
      actor,
      payload: { checkpoint, ...extra },
    }) as EventInput;
  const events = log(
    event("ticket.seen", { id: "SEED-9", title: "Prune", status: "started", phase: "implementing" }),
    event("ticket.created", {
      id: "SEED-7",
      title: "Plant",
      description: "",
      labels: ["implementing"],
      state: "started",
      parent: null,
      blockers: ["SEED-9"],
    }),
    event("ticket.commented", { ticket: "SEED-7", id: "c1", body: "Watered", author: "Mira" }),
    claimed,
    event("session.reported", { ...ref, phase: "shipping", reason: "Review", stage: "review" }),
    event("session.heartbeat", ref),
    event("pull-request.seen", {
      number: 8,
      ticket: ref.ticket,
      state: "open",
      ci: "pending",
      conflicting: false,
      head: "abc",
    }),
    event("inbox.opened", { id: "water", ticket: ref.ticket, kind: "question", body: "Water now?" }),
    event("merge.queued", { ...ref, id: "m1", pr: 8, head: "abc" }),
    event("hold.opened", { id: "rain", reason: "Wait" }),
    event("validation.opened", { ...ref, id: "v1", question: "Does it read?", checks: [] }),
    event("validation.decided", { id: "v1", decision: "approved", note: "" }),
    event("delivery.queued", { ...ref, id: "d1", generation: 1, key: "k1", text: "Go on", source: "owner-answer" }),
    event("delivery.failed", { id: "d1", attempt: 3, error: "pane gone", nextAt: null }),
    checkpoint("coordinator", {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 2, value: { policy: { budget: { zone: "Europe/Paris" } } } },
    }),
    checkpoint("coordinator", { format: "armada.readers", version: 1, provider: "linear" }),
    checkpoint("armada.linear-reader", {
      format: "armada.linear-reader",
      version: 1,
      usage: { hour: at, requests: 12, pausedUntil: null },
    }),
    checkpoint("coordinator", {
      format: "armada.worker",
      version: 1,
      type: "launch",
      step: "launched",
      ticket: "SEED-8",
      session: "bud",
      generation: 1,
      runtime: "local",
    }),
    checkpoint("coordinator", {
      format: "armada.pi",
      version: 1,
      type: "commit",
      seq: 1,
      writes: [
        {
          type: "document.create",
          record: { id: 5, kind: "pi.usage", scope: { kind: "conversation", conversationId: 1 } },
          content: {
            kind: "base",
            value: { models: { "fixture/oak": { input: 40, output: 4, cacheRead: 0, cacheWrite: 0 } } },
          },
        },
      ],
    }),
    checkpoint("coordinator", {
      format: "armada.pi",
      version: 1,
      type: "commit",
      seq: 2,
      writes: [
        {
          type: "document.change",
          id: 5,
          content: {
            kind: "base",
            value: { models: { "fixture/oak": { input: 70, output: 9, cacheRead: 0, cacheWrite: 0 } } },
          },
        },
      ],
    }),
    checkpoint("coordinator", {}, { turn: { id: "t9", session: "root" }, usage: "unknown" }),
    event("session.usage", {
      ...ref,
      generation: 1,
      usage: { input: 30, output: 3, cacheRead: null, cacheWrite: 0, model: "oak", provider: "fixture" },
    }),
    event("default-branch.seen", { branch: "main", head: "abc", ci: "success" }),
    event("tracker.import-started", {
      id: "import-1",
      programRoot: "SEED-1",
      state: "running",
      imported: 0,
      skipped: 0,
      comments: 0,
      total: 1,
    }),
    event("hold.opened", { id: "tide", reason: "Wait" }, "harbor"),
  );
  let replay = new FoldAccumulator();
  for (const [index, e] of events.entries()) {
    replay.append(e);
    const text = replay.serialize();
    assert.equal(JSON.parse(text).version, FOLD_VERSION);
    const restored = FoldAccumulator.restore(text);
    assert.equal(restored.seq, e.seq);
    assert.deepEqual(json(restored.snapshot()), json(fold(events.slice(0, index + 1))), `prefix ${index + 1}`);
    assert.equal(restored.snapshot().projects.constructor, undefined);
    // Continue from the restored reading, so each prefix also checks resuming mid-log.
    replay = restored;
  }
  const final = replay.snapshot().projects.orchard;
  assert.equal(final?.usage?.days[0]?.coordinator.input, 70, "pi usage deltas survive the restore");
  assert.equal(final?.usage?.days[0]?.workers.input, 30);
  assert.equal(final?.readers?.linear?.requests, 12);
  assert.equal(
    final?.inbox.some((i) => i.kind === "delivery-failed"),
    true,
  );
  assert.throws(() => FoldAccumulator.restore("{not json"), SyntaxError);
  const text = replay.serialize();
  assert.throws(
    () => FoldAccumulator.restore(text.replace(`"version":${FOLD_VERSION}`, `"version":${FOLD_VERSION + 1}`)),
    /version/,
  );
  const state = JSON.parse(text);
  state.projects[0][1].tickets = { "SEED-9": {} };
  assert.throws(() => FoldAccumulator.restore(JSON.stringify(state)), /tickets/);
  state.projects[0][1].tickets = [];
  state.projects[0][1].usage.entries = "none";
  assert.throws(() => FoldAccumulator.restore(JSON.stringify(state)), /usage ledger/);
  assert.throws(() => FoldAccumulator.restore("[]"), /object/);
});
