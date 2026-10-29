import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventInput, FleetEvent } from "../src/events.ts";
import { fold } from "../src/fold.ts";

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
