import { expect, test } from "bun:test";
import {
  recordAnswer,
  recordClaim,
  recordReport,
  requestMerge,
  requestPlanChanges,
  requestRelease,
  serveFleet,
  serveInbox,
} from "@armada/core/read";
import { fleetStore, getCoordinatorPresence, inboxReads, listSessions } from "../lib/fleet-store.ts";
import { tempDatabase } from "./support.ts";

const at = (minutes: number) => new Date(Date.parse("2026-03-04T10:00:00Z") + minutes * 60_000);

test("coordinator activity and inbox reads have separate clocks, reset after silence and retain seven days", async () => {
  const db = await tempDatabase();
  try {
    const store = fleetStore(db);
    await store.ensureProject(
      { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" },
      at(0),
    );
    const facts = { harness: "codex" as const, handle: "machine/tty", model: "synthetic-model", cliVersion: "0.2.4" };
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: false, at: at(0) });
    const query = { coordinator: facts.handle, facts, silentAfterMinutes: 15, etag: null };
    const read = await serveInbox(store, "widgets", query, at(1));
    expect(await serveInbox(store, "widgets", { ...query, etag: read?.etag ?? null }, at(2))).toBeNull();
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: false, at: at(20) });
    expect(await getCoordinatorPresence(db, "widgets")).toMatchObject({
      startedAt: at(0).toISOString(),
      seenAt: at(20).toISOString(),
      inboxSeenAt: at(2).toISOString(),
      ...facts,
    });
    expect((await inboxReads(db, "widgets", at(20))).map((read) => read.at)).toEqual([
      at(1).toISOString(),
      at(2).toISOString(),
    ]);
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: false, at: at(51) });
    expect(await getCoordinatorPresence(db, "widgets")).toMatchObject({ startedAt: at(51).toISOString() });
    expect(await inboxReads(db, "widgets", at(25 * 60 + 3))).toEqual([]);
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: true, at: at(52) });
    const persisted = async () =>
      (
        await db.query("SELECT created_at FROM events WHERE project = $1 AND kind = 'inbox' ORDER BY created_at", [
          "widgets",
        ])
      ).rows.map((row) => new Date(String(row.created_at)).toISOString());
    expect(await persisted()).toEqual([at(1), at(2), at(52)].map((date) => date.toISOString()));
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: true, at: at(7 * 24 * 60 + 2) });
    // Strictly older than seven days is deleted; the boundary and newer rows survive.
    expect(await persisted()).toEqual([at(2), at(52), at(7 * 24 * 60 + 2)].map((date) => date.toISOString()));
    expect(await getCoordinatorPresence(db, "gadgets")).toBeNull();
  } finally {
    await db.end();
  }
});

test("each session retains its launch facts and last report after release and replacement", async () => {
  const db = await tempDatabase();
  try {
    const store = fleetStore(db);
    await store.ensureProject(
      { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" },
      at(0),
    );
    const claim = {
      ticket: "WID-2",
      runtime: "Conductor",
      handle: "ws/one",
      branch: "feature/wid-2",
      phase: "planning",
      resuming: false,
      profile: {
        name: "fast",
        agent: "codex",
        model: "synthetic-model",
        effort: "high",
        fastMode: false,
        routed: "fast",
        reason: null,
        why: "default",
      },
    };
    await recordClaim(store, "widgets", claim, at(1));
    await recordReport(
      store,
      "widgets",
      {
        ticket: "WID-2",
        phase: "implementing",
        previous: "planning",
        summary: "Writing tests",
        message: "Writing tests",
        prUrl: null,
        headSha: null,
      },
      at(2),
    );
    await recordClaim(store, "widgets", { ...claim, resuming: true, profile: null }, at(3));
    await store.releaseRuntimeHandle("widgets", "WID-2", at(4));
    await recordClaim(store, "widgets", { ...claim, handle: "ws/two", profile: null }, at(5));
    const sessions = await listSessions(db, "widgets", { since: at(0) });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      handle: "ws/one",
      claimedAt: at(1).toISOString(),
      releasedAt: at(4).toISOString(),
      profile: "fast",
      agent: "codex",
      model: "synthetic-model",
      effort: "high",
      lastReport: { at: at(2).toISOString(), message: "Writing tests", phase: "implementing" },
    });
    expect(sessions[1]).toMatchObject({ handle: "ws/two", profile: null, lastReport: null });
  } finally {
    await db.end();
  }
});

test("steering requests deduplicate atomically per target, stay scoped and resolve without approving plans", async () => {
  const db = await tempDatabase();
  try {
    const store = fleetStore(db);
    const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" };
    await store.ensureProject(project, at(0));
    await store.ensureProject({ ...project, slug: "gadgets" }, at(0));
    await store.saveRuntimeHandle({
      project: "widgets",
      ticket: "WID-2",
      runtime: "Codex",
      handle: "one",
      branch: null,
      at: at(1),
    });
    await store.putPlan({ project: "widgets", ticket: "WID-2", author: "worker", body: "Original plan", at: at(1) });
    const plan = (await store.openInboxItems({ project: "widgets", recipient: "coordinator" }))[0];
    if (!plan) throw new Error("missing test plan");
    const common = { project: "widgets", author: "Synthetic Owner", now: at(2) };
    const request = () =>
      requestPlanChanges(store, { ...common, question: plan.id, text: "Please include a migration." });
    const results = await Promise.allSettled([request(), request()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const changes = (await store.openInboxItems({ project: "widgets", recipient: "coordinator" })).find(
      (item) => item.kind === "plan-changes",
    );
    if (!changes) throw new Error("missing changes");
    await recordAnswer(
      store,
      "widgets",
      { item: changes.id, ticket: "WID-2", note: false, text: "Amendments delivered" },
      at(3),
    );
    expect((await store.getInboxItem("widgets", plan.id))?.resolvedAt).toBeNull();
    expect((await store.getInboxItem("widgets", changes.id))?.resolvedAt).toBe(at(3).toISOString());
    expect(await request()).toBeGreaterThan(changes.id);
    await expect(
      requestPlanChanges(store, { ...common, project: "gadgets", question: plan.id, text: "wrong project" }),
    ).rejects.toThrow("does not exist");
    await expect(requestPlanChanges(store, { ...common, question: plan.id, text: " " })).rejects.toThrow("empty");
    const firstMerge = await requestMerge(store, { ...common, pr: 11, openPrs: [11, 12] });
    const secondMerge = await requestMerge(store, { ...common, pr: 12, openPrs: [11, 12] });
    expect(firstMerge).not.toBe(secondMerge);
    await expect(requestMerge(store, { ...common, pr: 11, openPrs: [11] })).rejects.toThrow("already waits");
    await expect(requestMerge(store, { ...common, pr: 13, openPrs: [] })).rejects.toThrow("not open");
    const release = await requestRelease(store, { ...common, ticket: "WID-2" });
    await expect(requestRelease(store, { ...common, ticket: "WID-2" })).rejects.toThrow("already waits");
    for (const id of [firstMerge, secondMerge, release])
      await recordAnswer(store, "widgets", { item: id, ticket: null, note: false, text: "handled" }, at(4));
    expect((await store.getInboxItem("widgets", release))?.resolvedAt).toBe(at(4).toISOString());
    const forbidden = await serveFleet(
      store,
      {
        op: "request",
        project,
        caller: { kind: "worker", ticket: "WID-2" },
        input: { kind: "release-request", ticket: "WID-2" },
      },
      { now: () => at(5) },
    );
    expect(forbidden.status).toBe(403);
    const accepted = await serveFleet(
      store,
      {
        op: "request",
        project,
        caller: { kind: "organization", author: "Verified Person" },
        input: { kind: "merge-request", pr: 11, author: "Impersonator" },
      },
      { now: () => at(5), openPrs: [11] },
    );
    expect(accepted.status).toBe(200);
    expect((await store.getInboxItem("widgets", Number(accepted.body.result)))?.author).toBe("Verified Person");
    await serveFleet(
      store,
      {
        op: "register",
        project: { ...project, owner: "Impersonator" },
        caller: { kind: "organization", author: "Verified Person" },
        input: {},
      },
      { now: () => at(6) },
    );
    await serveFleet(
      store,
      { op: "register", project, caller: { kind: "organization", author: "Second Person" }, input: {} },
      { now: () => at(7) },
    );
    expect((await store.listProjects()).find((project) => project.slug === "widgets")?.owner).toBe("Verified Person");
  } finally {
    await db.end();
  }
});
