import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type FeedEntry, type FeedKind, sinceSummary } from "@armada/core/read";
import { catchupRecords, type FeedQuery, feedPage } from "../lib/activity-store.ts";
import type { Database } from "../lib/db.ts";
import {
  addInboxItem,
  addRequest,
  addValidation,
  decideValidation,
  recordCoordinatorSeen,
  recordEvent,
  resolveInboxItem,
  saveRuntimeHandle,
  upsertProject,
} from "../lib/fleet-store.ts";
import { dismissSummary, readVisit, recordVisit, saveNotify } from "../lib/visits.ts";
import { createLaunch, revokePendingLaunch } from "../lib/workers.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

// Synthetic projects, tickets and people, for these tests only.
const P = "widgets";
const T0 = Date.parse("2026-03-04T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const NOW = at(300);

let db: Database;
beforeAll(async () => {
  db = await tempDatabase();
  await addOrganizations(db, "org-a");
  for (const slug of [P, "gadgets"])
    await upsertProject(db, { slug, name: slug, repository: `acme/${slug}`, programRoot: "WID-1" }, at(-60));
  const event = (ticket: string, kind: string, minutes: number, phase?: string, project = P) =>
    recordEvent(db, { project, ticket, kind: kind as "report", at: at(minutes), ...(phase ? { phase } : {}) });

  // W-1: launched, claimed, a heartbeat, a 40-minute silence, then merged (its session not released yet).
  await createLaunch(db, {
    organization: "org-a",
    project: P,
    ticket: "W-1",
    launcher: { kind: "session", id: "u1", label: "Ada Lovelace" },
    now: at(0),
  });
  await saveRuntimeHandle(db, {
    project: P,
    ticket: "W-1",
    runtime: "Conductor",
    handle: "ws/1",
    branch: null,
    at: at(1),
  });
  await event("W-1", "claim", 1, "planning");
  await event("W-1", "heartbeat", 5);
  await event("W-1", "heartbeat", 45);
  await event("W-1", "report", 50, "ready-to-merge");
  await event("W-1", "merge", 60, "merged");
  // W-2: claimed, blocked, then silent until now.
  await saveRuntimeHandle(db, {
    project: P,
    ticket: "W-2",
    runtime: "Codex",
    handle: "ws/2",
    branch: null,
    at: at(100),
  });
  await event("W-2", "claim", 100, "planning");
  await event("W-2", "report", 110, "blocked");
  // A question, answered; an owner's request; a hand-back.
  const q = await addInboxItem(db, {
    project: P,
    ticket: "W-2",
    kind: "question",
    recipient: "coordinator",
    author: null,
    body: "Which cache?",
    at: at(120),
  });
  await resolveInboxItem(db, { project: P, id: q, resolution: "The LRU one", at: at(130) });
  await addRequest(db, {
    project: P,
    ticket: "W-3",
    kind: "launch-request",
    author: "Grace Hopper",
    body: "Launch W-3",
    question: null,
    profile: null,
    at: at(140),
  });
  // A validation the owner decided, and one still waiting.
  const v = await addValidation(db, {
    project: P,
    ticket: "W-1",
    kind: "validation",
    what: "Check the mockup",
    reason: null,
    choices: null,
    pr: null,
    attachments: [],
    author: null,
    at: at(55),
  });
  await decideValidation(db, {
    project: P,
    id: v.id,
    decision: { outcome: "approved", answer: null, note: "Lovely", by: "Ada Lovelace" },
    body: "approved",
    at: at(58),
  });
  await addValidation(db, {
    project: P,
    ticket: "W-2",
    kind: "question",
    what: "Ship on Friday?",
    reason: null,
    choices: ["yes", "no"],
    pr: null,
    attachments: [],
    author: "coordinator",
    at: at(150),
  });
  // A launch revoked before any claim.
  await createLaunch(db, {
    organization: "org-a",
    project: P,
    ticket: "W-4",
    launcher: { kind: "session", id: "u1", label: "Ada Lovelace" },
    now: at(160),
  });
  await revokePendingLaunch(db, {
    organization: "org-a",
    project: P,
    ticket: "W-4",
    by: { kind: "person", id: "u2", label: "Grace Hopper" },
    now: at(170),
  });
  // The coordinator reads its inbox from 0 to 20, stops, and is back from 200 to 210.
  for (const m of [0, 10, 20, 200, 210]) await recordCoordinatorSeen(db, { project: P, at: at(m) });
  // Another project's merge.
  await event("G-1", "merge", 65, "merged", "gadgets");
});
afterAll(() => db.end());

const query = (over: Partial<FeedQuery> = {}): FeedQuery => ({
  projects: [P],
  before: null,
  kinds: null,
  phase: null,
  limit: 100,
  now: NOW,
  ...over,
});
const kinds = (list: FeedEntry[]) => list.map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ""} ${e.ticket ?? "-"}`);

describe("feedPage", () => {
  test("lists every event of the fleet newest first, and never a heartbeat or an inbox read", async () => {
    expect(kinds(await feedPage(db, query()))).toEqual([
      "coordinator:stop -",
      "coordinator:start -",
      "revoke W-4",
      "launch W-4",
      "validation:question W-2",
      "request:launch-request W-3",
      "answer:question W-2",
      "question W-2",
      "report W-2",
      "claim W-2",
      "merge W-1",
      "decision:approved W-1",
      "validation:validation W-1",
      "report W-1",
      "coordinator:stop -",
      "claim W-1",
      "launch W-1",
      "coordinator:start -",
    ]);
  });

  test("says who did it", async () => {
    const list = await feedPage(db, query());
    const by = (kind: FeedKind, ticket: string | null) =>
      list.find((e) => e.kind === kind && e.ticket === ticket)?.actor;
    expect(by("launch", "W-1")).toEqual({ kind: "person", name: "Ada Lovelace" });
    expect(by("revoke", "W-4")).toEqual({ kind: "person", name: "Grace Hopper" });
    expect(by("decision", "W-1")).toEqual({ kind: "person", name: "Ada Lovelace" });
    expect(by("request", "W-3")).toEqual({ kind: "person", name: "Grace Hopper" });
    expect(by("claim", "W-1")).toEqual({ kind: "agent", name: null });
    expect(by("merge", "W-1")).toEqual({ kind: "coordinator", name: null });
    expect(by("answer", "W-2")).toEqual({ kind: "coordinator", name: null });
    expect(list.find((e) => e.kind === "decision")).toMatchObject({ text: "Lovely", ref: expect.any(Number) });
  });

  test("filters by kind in every source, and the reports by phase", async () => {
    expect(kinds(await feedPage(db, query({ kinds: ["merge", "claim"] })))).toEqual([
      "claim W-2",
      "merge W-1",
      "claim W-1",
    ]);
    expect(kinds(await feedPage(db, query({ kinds: ["coordinator", "answer"] })))).toEqual([
      "coordinator:stop -",
      "coordinator:start -",
      "answer:question W-2",
      "coordinator:stop -",
      "coordinator:start -",
    ]);
    // The Activity page's "Blocks": the questions, and the reports that entered blocked (W-1's ready-to-merge is not one).
    expect(kinds(await feedPage(db, query({ kinds: ["question", "report"], phase: "blocked" })))).toEqual([
      "question W-2",
      "report W-2",
    ]);
  });

  test("pages on its cursor without a gap or a repeat", async () => {
    const all = await feedPage(db, query());
    const seen: FeedEntry[] = [];
    let before: FeedQuery["before"] = null;
    for (let page = 0; page < 10; page++) {
      const list = await feedPage(db, query({ before, limit: 4 }));
      if (!list.length) break;
      seen.push(...list);
      const last = list.at(-1) as FeedEntry;
      before = { at: last.at, key: last.key };
    }
    expect(seen.map((e) => e.key)).toEqual(all.map((e) => e.key));
  });

  test("reads only the projects it is given", async () => {
    expect(kinds(await feedPage(db, query({ projects: ["gadgets"] })))).toEqual(["merge G-1"]);
    expect(await feedPage(db, query({ projects: [] }))).toEqual([]);
  });
});

describe("catchupRecords", () => {
  test("reads the merges, claims, blocks, silences and what waits since a visit's start", async () => {
    const r = await catchupRecords(db, P, { since: at(30), until: NOW }, 15, NOW);
    expect(r.merged).toEqual([{ ticket: "W-1", at: iso(60) }]);
    expect(r.claimed).toEqual([{ ticket: "W-2", at: iso(100) }]);
    expect(r.blocked).toEqual([{ ticket: "W-2", at: iso(110) }]);
    // W-1's 40 minutes between heartbeats, planning; W-2 silent since its blocked report, still held.
    expect(r.gaps).toEqual([
      { ticket: "W-1", from: iso(5), to: iso(45), phase: "planning" },
      { ticket: "W-2", from: iso(110), to: null, phase: "blocked" },
    ]);
    expect(r.waiting).toEqual([{ id: expect.any(Number), ticket: "W-2", kind: "question" }]);
    const s = sinceSummary({ since: iso(30), now: NOW, records: [r] });
    // Blocked waits on someone: named for the block, not for its silence.
    expect(s.stuck.map((x) => [x.ticket, x.reason, x.minutes, x.ongoing])).toEqual([
      ["W-1", "silent", 40, false],
      ["W-2", "blocked", null, false],
    ]);
  });

  test("reads a silence whole when it began long before the visit's start, and stops at its end", async () => {
    // W-1's last event before 50 is its heartbeat at 45; its report at 50 ends no silence.
    const late = await catchupRecords(db, P, { since: at(46), until: NOW }, 15, NOW);
    expect(late.gaps.filter((g) => g.ticket === "W-1")).toEqual([]);
    const crossing = await catchupRecords(db, P, { since: at(40), until: NOW }, 15, NOW);
    expect(crossing.gaps.filter((g) => g.ticket === "W-1")).toEqual([
      { ticket: "W-1", from: iso(5), to: iso(45), phase: "planning" },
    ]);
    // Back at 55: the merge at 60 happened while they watched.
    expect((await catchupRecords(db, P, { since: at(30), until: at(55) }, 15, NOW)).merged).toEqual([]);
  });
});

describe("visits", () => {
  const me = { viewer: "user-1", organization: "org-a" };

  test("start a new one after more than 30 minutes away, from when the viewer was last seen", async () => {
    expect(await recordVisit(db, me, at(0))).toMatchObject({ seenAt: iso(0), since: null });
    expect(await recordVisit(db, me, at(20))).toMatchObject({ seenAt: iso(20), since: null });
    expect(await recordVisit(db, me, at(45))).toMatchObject({ seenAt: iso(45), since: null });
    expect(await recordVisit(db, me, at(120))).toMatchObject({ seenAt: iso(120), since: iso(45), backAt: iso(120) });
    expect(await recordVisit(db, me, at(125))).toMatchObject({ seenAt: iso(125), since: iso(45), backAt: iso(120) });
    // A late beacon from another tab moves nothing back.
    expect(await recordVisit(db, me, at(110))).toMatchObject({ seenAt: iso(125), since: iso(45) });
    // Each person and organization is kept apart.
    expect(await readVisit(db, { viewer: "user-1", organization: "org-b" })).toMatchObject({ seenAt: null });
  });

  test("dismiss the summary of one visit only", async () => {
    expect(await dismissSummary(db, me, at(0))).toBe(false);
    expect(await dismissSummary(db, me, at(45))).toBe(true);
    expect(await readVisit(db, me)).toMatchObject({ since: iso(45), dismissedSince: iso(45) });
    expect(await recordVisit(db, me, at(200))).toMatchObject({ since: iso(125), dismissedSince: iso(45) });
  });

  test("keep the notification settings", async () => {
    expect((await readVisit(db, me)).notify).toEqual({ on: false, quiet: null });
    const notify = { on: true, quiet: { from: "22:00", to: "07:30" } };
    await saveNotify(db, me, notify, at(210));
    expect((await readVisit(db, me)).notify).toEqual(notify);
    await saveNotify(db, { viewer: "browser-1", organization: "" }, notify, at(210));
    expect(await readVisit(db, { viewer: "browser-1", organization: "" })).toMatchObject({ seenAt: iso(210), notify });
  });
});
