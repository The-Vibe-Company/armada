import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { NewRequest } from "@armada/core/read";
import type { Database } from "../lib/db.ts";
import {
  acquireLease,
  addInboxItem,
  addRequest,
  assignUnownedProjects,
  coordinatorPresence,
  getLease,
  getRuntimeHandle,
  lastCoordinatorSeen,
  latestEvents,
  listProjects,
  openInboxItems,
  openRuntimeHandles,
  putHandBack,
  putPlan,
  recordCoordinatorSeen,
  recordEvent,
  releaseLease,
  releaseRuntimeHandle,
  renewLease,
  resolveInboxItem,
  resolvePlans,
  saveRuntimeHandle,
  saveWorkerProfile,
  upsertProject,
} from "../lib/fleet-store.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

// Synthetic projects and tickets, for these tests only.
const P = "widgets";
const T0 = Date.parse("2026-03-04T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

let db: Database;
beforeAll(async () => {
  db = await tempDatabase();
  await addOrganizations(db, "org-a", "org-b");
});
afterAll(() => db.end());

describe("the project registry", () => {
  test("a project is registered once per slug; an update keeps its creation time; an organization is given once", async () => {
    await upsertProject(db, { slug: P, name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" }, at(0));
    await upsertProject(db, { slug: P, name: "Widgets 2", repository: "acme/widgets", programRoot: "WID-1" }, at(5));
    expect(await assignUnownedProjects(db, "org-a", at(6))).toBe(1);
    expect(await assignUnownedProjects(db, "org-b", at(7))).toBe(0);
    expect(await listProjects(db)).toEqual([
      {
        slug: P,
        name: "Widgets 2",
        repository: "acme/widgets",
        programRoot: "WID-1",
        organization: "org-a",
        owner: null,
        createdAt: at(0).toISOString(),
        updatedAt: at(5).toISOString(),
      },
    ]);
  });
});

describe("live data", () => {
  test("the newest event of each ticket since a time, the coordinator's newest inbox read, the open sessions", async () => {
    await recordEvent(db, { project: P, ticket: "WID-2", kind: "claim", phase: "planning", at: at(1) });
    await recordEvent(db, { project: P, ticket: "WID-2", kind: "report", phase: "shipping", prUrl: "u", at: at(3) });
    await recordEvent(db, { project: P, ticket: "WID-3", kind: "report", phase: "implementing", at: at(1) });
    await recordEvent(db, { project: "other", ticket: "WID-2", kind: "report", phase: "blocked", at: at(9) });
    const latest = await latestEvents(db, P, { since: at(2) });
    expect(Object.keys(latest)).toEqual(["WID-2"]);
    expect(latest["WID-2"]).toMatchObject({ kind: "report", phase: "shipping", prUrl: "u", at: at(3).toISOString() });

    await recordCoordinatorSeen(db, { project: P, handle: "ws/c", cliVersion: "0.2.3", at: at(9) });
    // A read that names no version keeps the one known.
    await recordCoordinatorSeen(db, { project: P, handle: "ws/c", at: at(10) });
    // A late write of an older read never moves it back.
    await recordCoordinatorSeen(db, { project: P, cliVersion: "0.1.0", at: at(8) });
    expect(await lastCoordinatorSeen(db, P)).toBe(at(10).toISOString());
    expect(await coordinatorPresence(db, P)).toEqual({ seenAt: at(10).toISOString(), cliVersion: "0.2.3" });
    expect(await lastCoordinatorSeen(db, "other")).toBeNull();

    const claim = { project: P, ticket: "WID-2", runtime: "Conductor", handle: "ws/2", branch: "b", at: at(1) };
    await saveRuntimeHandle(db, claim);
    await saveWorkerProfile(db, {
      project: P,
      ticket: "WID-2",
      profile: {
        name: "opus",
        agent: "claude",
        model: "m",
        effort: "high",
        fastMode: false,
        routed: null,
        reason: null,
        why: "default",
      },
      at: at(1),
    });
    // The same session claiming again keeps its claim time; the profile shows on the handle.
    await saveRuntimeHandle(db, { ...claim, at: at(4) });
    expect(await openRuntimeHandles(db, P)).toEqual([
      {
        project: P,
        ticket: "WID-2",
        runtime: "Conductor",
        handle: "ws/2",
        branch: "b",
        claimedAt: at(1).toISOString(),
        releasedAt: null,
        profile: "opus",
      },
    ]);
    await releaseRuntimeHandle(db, P, "WID-2", at(6));
    expect(await openRuntimeHandles(db, P)).toEqual([]);
    expect(await getRuntimeHandle(db, P, "WID-2")).toMatchObject({ releasedAt: at(6).toISOString(), profile: null });
    // Another session's claim replaces the released one, with its own time.
    await saveRuntimeHandle(db, { ...claim, handle: "ws/2b", at: at(7) });
    expect(await getRuntimeHandle(db, P, "WID-2")).toMatchObject({ handle: "ws/2b", claimedAt: at(7).toISOString() });
  });
});

describe("the coordinator's inbox", () => {
  const question = () =>
    addInboxItem(db, {
      project: P,
      ticket: "WID-5",
      kind: "question",
      recipient: "coordinator",
      author: "ws/5",
      body: "Which table?",
      at: at(20),
    });
  const answer = (q: number, body: string): NewRequest => ({
    project: P,
    ticket: "WID-5",
    kind: "answer-request",
    author: "Ada",
    body,
    question: q,
    profile: null,
    at: at(21),
  });

  test("one open answer per question, even from two requests at once; none to a closed question", async () => {
    const q = await question();
    const both = await Promise.all([addRequest(db, answer(q, "users")), addRequest(db, answer(q, "accounts"))]);
    expect(both.filter((id) => id !== null)).toHaveLength(1);
    const [item] = (await openInboxItems(db, { project: P, recipient: "coordinator", ticket: "WID-5" })).filter(
      (i) => i.kind === "answer-request",
    );
    expect(item?.request).toEqual({ question: q, profile: null });

    const closed = await question();
    await resolveInboxItem(db, { project: P, id: closed, resolution: "answered", at: at(22) });
    expect(await addRequest(db, answer(closed, "late"))).toBeNull();

    const launch: NewRequest = {
      ...answer(0, "Launch WID-6"),
      ticket: "WID-6",
      kind: "launch-request",
      question: null,
      profile: "codex",
    };
    expect(await addRequest(db, launch)).not.toBeNull();
    expect(await addRequest(db, launch)).toBeNull();
  });

  test("one open plan and one hand-back per ticket; resolving the plan resolves the answers waiting on it", async () => {
    const item = { project: P, ticket: "WID-7", author: "ws/7", at: at(30) };
    await putPlan(db, { ...item, body: "Plan A" });
    await putPlan(db, { ...item, body: "Plan B" });
    await putHandBack(db, { ...item, body: "PR 1" });
    await putHandBack(db, { ...item, body: "PR 1, CI green", at: at(31) });
    const open = () => openInboxItems(db, { project: P, recipient: "coordinator", ticket: "WID-7" });
    const plan = (await open()).find((i) => i.kind === "plan");
    expect((await open()).map((i) => [i.kind, i.body])).toEqual([
      ["plan", "Plan A"],
      ["hand-back", "PR 1, CI green"],
    ]);
    await addRequest(db, { ...answer(plan?.id ?? 0, "approved"), ticket: "WID-7" });
    expect(await resolvePlans(db, { project: P, ticket: "WID-7", resolution: "released", at: at(32) })).toBe(1);
    expect((await open()).map((i) => i.kind)).toEqual(["hand-back"]);
  });
});

describe("leases", () => {
  const lease = { project: P, name: "merge", ttlMs: 10 * 60_000 };

  test("one holder at a time, even when two ask at once; ours renews; an expired one is taken", async () => {
    const both = await Promise.all([
      acquireLease(db, { ...lease, holder: "coord-a", at: at(0) }),
      acquireLease(db, { ...lease, holder: "coord-b", at: at(0) }),
    ]);
    expect(both.filter((r) => r.acquired)).toHaveLength(1);
    const winner = both[0]?.acquired ? "coord-a" : "coord-b";
    const loser = winner === "coord-a" ? "coord-b" : "coord-a";
    expect(both.find((r) => !r.acquired)).toMatchObject({ held: { holder: winner } });

    // Taking it again renews it and keeps when it was first taken.
    expect(await acquireLease(db, { ...lease, holder: winner, at: at(5) })).toEqual({ acquired: true });
    expect(await getLease(db, P, "merge")).toMatchObject({
      acquiredAt: at(0).toISOString(),
      expiresAt: at(15).toISOString(),
    });
    expect(await acquireLease(db, { ...lease, holder: loser, at: at(14) })).toMatchObject({ acquired: false });
    expect(await acquireLease(db, { ...lease, holder: loser, at: at(15) })).toEqual({ acquired: true });
    // The one that lost it can neither renew nor release it.
    expect(await renewLease(db, { ...lease, holder: winner, at: at(16) })).toBe(false);
    await releaseLease(db, { ...lease, holder: winner });
    expect(await getLease(db, P, "merge")).toMatchObject({ holder: loser, acquiredAt: at(15).toISOString() });
    await releaseLease(db, { ...lease, holder: loser });
    expect(await getLease(db, P, "merge")).toBeNull();
  });
});
