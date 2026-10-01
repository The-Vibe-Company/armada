import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../lib/db.ts";
import {
  addInboxItem,
  addValidation,
  insightRecords,
  putHandBack,
  recordEvent,
  releaseRuntimeHandle,
  resolveInboxItem,
  saveRuntimeHandle,
  saveWorkerProfile,
  upsertProject,
} from "../lib/fleet-store.ts";
import { tempDatabase } from "./support.ts";

// Synthetic projects and tickets, for these tests only.
const P = "widgets";
const T0 = Date.parse("2026-03-04T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const DAY = 24 * 60;

let db: Database;
beforeAll(async () => {
  db = await tempDatabase();
  for (const slug of [P, "gadgets"])
    await upsertProject(db, { slug, name: slug, repository: `acme/${slug}`, programRoot: "WID-1" }, at(-90 * DAY));
  const event = (ticket: string, kind: string, minutes: number, more: { phase?: string; headSha?: string } = {}) =>
    recordEvent(db, { project: P, ticket, kind: kind as "report", at: at(minutes), ...more });

  // W-1: claimed ten days before the range, heartbeats every 5 minutes, one 40-minute gap, merged in range.
  await saveRuntimeHandle(db, {
    project: P,
    ticket: "W-1",
    runtime: "Conductor",
    handle: "ws/1",
    branch: null,
    at: at(-10 * DAY),
  });
  await saveWorkerProfile(db, {
    project: P,
    ticket: "W-1",
    profile: {
      name: "opus",
      agent: "claude",
      model: "m",
      effort: "high",
      fastMode: false,
      routed: null,
      reason: null,
      why: "",
    },
    at: at(-10 * DAY),
  });
  await event("W-1", "claim", -10 * DAY, { phase: "planning" });
  for (let m = 0; m <= 60; m += 5) if (m < 10 || m > 45) await event("W-1", "heartbeat", m);
  await event("W-1", "report", 61, { phase: "ready-to-merge", headSha: "a1" });
  await event("W-1", "merge", 62, { phase: "merged" });
  await releaseRuntimeHandle(db, P, "W-1", at(62));
  // W-2: nothing since the range started: not read.
  await event("W-2", "claim", -5 * DAY, { phase: "planning" });
  await event("W-2", "heartbeat", -5 * DAY + 5);
  // Another project's ticket.
  await recordEvent(db, { project: "gadgets", ticket: "W-1", kind: "merge", at: at(10) });
  // The coordinator's waits and the owner's validations.
  const question = await addInboxItem(db, {
    project: P,
    ticket: "W-1",
    kind: "question",
    recipient: "coordinator",
    author: "ws/1",
    body: "Which?",
    at: at(20),
  });
  await resolveInboxItem(db, { project: P, id: question, resolution: "This one", at: at(30) });
  await putHandBack(db, { project: P, ticket: "W-1", author: null, body: "ready", at: at(61) });
  await addInboxItem(db, {
    project: P,
    ticket: "W-1",
    kind: "note",
    recipient: "worker",
    author: "c",
    body: "fyi",
    at: at(25),
  });
  await addInboxItem(db, {
    project: P,
    ticket: "W-1",
    kind: "question",
    recipient: "coordinator",
    author: null,
    body: "old",
    at: at(-DAY),
  });
  await addValidation(db, {
    project: P,
    ticket: "W-1",
    kind: "merge",
    what: "Merge it",
    reason: null,
    choices: null,
    pr: {
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      title: "t",
      headSha: "a1",
      files: [],
      additions: 0,
      deletions: 0,
      ci: "success",
      preview: null,
    },
    attachments: [],
    author: "coordinator",
    at: at(61),
  });
});
afterAll(() => db.end());

describe("insightRecords", () => {
  test("reads every event of a ticket active since `since`, and only the heartbeats that end a gap or come last", async () => {
    const r = await insightRecords(db, P, at(0), 15);
    expect(r.events.map((e) => [e.kind, e.at, e.gapFrom, e.last])).toEqual([
      ["claim", iso(-10 * DAY), null, false],
      // The first heartbeat ends the ten days since the claim, but that gap began before the range: kept, it ends in it.
      ["heartbeat", iso(0), iso(-10 * DAY), false],
      ["heartbeat", iso(50), iso(5), false],
      ["report", iso(61), null, false],
      ["merge", iso(62), null, true],
    ]);
    expect(r.events[3]).toMatchObject({ phase: "ready-to-merge", headSha: "a1" });
  });

  test("reads the sessions, the coordinator's waits and the owner's validations of the range, for the project only", async () => {
    const r = await insightRecords(db, P, at(0), 15);
    expect(r.sessions).toEqual([
      { ticket: "W-1", runtime: "Conductor", profile: "opus", claimedAt: iso(-10 * DAY), releasedAt: iso(62) },
    ]);
    expect(r.waits).toEqual([
      { ticket: "W-1", kind: "question", createdAt: iso(20), resolvedAt: iso(30) },
      { ticket: "W-1", kind: "hand-back", createdAt: iso(61), resolvedAt: null },
    ]);
    expect(r.validations).toEqual([
      { ticket: "W-1", kind: "merge", createdAt: iso(61), decidedAt: null, outcome: null },
    ]);
    expect((await insightRecords(db, "gadgets", at(0), 15)).events.map((e) => e.kind)).toEqual(["merge"]);
  });
});
