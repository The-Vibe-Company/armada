import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Job,
  type NewRequest,
  readInbox,
  recordClaim,
  recordRelease,
  recordReport,
  serveFleet,
} from "@armada/core/read";
import { type Database, DB_MIGRATIONS, DB_SCHEMA_VERSION, migrateDatabase } from "../lib/db.ts";
import {
  acquireLease,
  addInboxItem,
  addRequest,
  assignUnownedProjects,
  coordinatorPresence,
  eventsSince,
  fleetStore,
  getLease,
  getRuntimeHandle,
  heartbeatTimes,
  lastAnsweredAt,
  lastCoordinatorSeen,
  lastEventTimes,
  latestEvents,
  listProjects,
  listSessions,
  openInboxItems,
  openRuntimeHandles,
  putChore,
  putHandBack,
  putPlan,
  recordCoordinatorSeen,
  recordEvent,
  recordHeartbeat,
  releaseLease,
  releaseRuntimeHandle,
  renewLease,
  resolveInboxItem,
  resolvePlans,
  resolvePrItems,
  saveRuntimeHandle,
  saveWorkerProfile,
  shownJobs,
  upsertProject,
} from "../lib/fleet-store.ts";
import { bindLaunch, createLaunch, endWorker, exchangeLaunch, revokePendingLaunch } from "../lib/workers.ts";
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
  test("keyed deliveries admit one retry, fence settlement, and retire failures once a newer answer is confirmed", async () => {
    const project = "delivery-outbox";
    await upsertProject(
      db,
      { slug: project, name: "Deliveries", repository: "acme/deliveries", programRoot: "WID-1" },
      at(0),
    );
    const store = fleetStore(db);
    const base = {
      project,
      key: "delivery-old",
      ticket: "WID-44",
      item: 77,
      kind: "answer" as const,
      text: "Approve the migration\nwith the staged rollout",
      runtime: "conductor" as const,
      handle: "workspace/session",
      claimedAt: at(0).toISOString(),
      launchId: null,
      branch: "ticket/WID-44",
      coordinator: "default",
      at: at(0),
    };
    const first = await store.keepDelivery(base);
    expect(first).toMatchObject({ attempts: 1, state: "pending", attemptedAt: at(0).toISOString() });
    expect(await store.keepDelivery({ ...base, text: "a changed retry payload" })).toMatchObject({
      id: first.id,
      text: base.text,
      attempts: 1,
    });
    const attempts = await Promise.all([
      store.attemptDelivery({ project, key: first.key, coordinator: "default", at: at(1) }),
      store.attemptDelivery({ project, key: first.key, coordinator: "default", at: at(1) }),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.filter(Boolean)[0]).toMatchObject({ attempts: 2, attemptedAt: at(1).toISOString() });
    expect(
      await store.settleDelivery({
        project,
        key: first.key,
        coordinator: "default",
        state: "abandoned",
        reason: "runtime unavailable",
        attempts: 1,
        at: at(2),
      }),
    ).toMatchObject({ state: "pending", attempts: 2 });
    const failed = await store.settleDelivery({
      project,
      key: first.key,
      coordinator: "default",
      state: "abandoned",
      reason: "runtime unavailable",
      attempts: 2,
      at: at(2),
    });
    expect(failed).toMatchObject({ state: "abandoned", attempts: 2 });
    const failureItems = await openInboxItems(db, { project, recipient: "coordinator" });
    expect(failureItems.filter((item) => item.kind === "delivery-failed")).toHaveLength(1);
    expect(failureItems.find((item) => item.kind === "delivery-failed")?.body).toContain("Approve the migration");

    const newer = await store.keepDelivery({ ...base, key: "delivery-new", text: "Use the safer rollout", at: at(3) });
    expect((await store.pendingDeliveries(project)).some((row) => row.key === first.key)).toBe(false);
    const pendingOld = await store.keepDelivery({ ...base, key: "delivery-pending-old", item: 88, at: at(5) });
    const pendingNew = await store.keepDelivery({ ...base, key: "delivery-pending-new", item: 88, at: at(6) });
    expect((await store.pendingDeliveries(project)).some((row) => row.key === pendingOld.key)).toBe(true);
    expect((await store.pendingDeliveries(project)).some((row) => row.key === pendingNew.key)).toBe(true);
    // A new key does not retire the older pending delivery until it is confirmed.
    expect(
      await store.settleDelivery({
        project,
        key: pendingNew.key,
        coordinator: "default",
        state: "delivered",
        reason: "confirmed",
        at: at(7),
      }),
    ).toMatchObject({ state: "delivered" });
    expect(
      (
        await db.query("SELECT state, reason FROM pending_deliveries WHERE project = $1 AND delivery_key = $2", [
          project,
          pendingOld.key,
        ])
      ).rows[0],
    ).toEqual({ state: "abandoned", reason: "replaced by a newer answer" });
    expect(
      await store.settleDelivery({
        project,
        key: newer.key,
        coordinator: "default",
        state: "delivered",
        reason: "confirmed",
        at: at(4),
      }),
    ).toMatchObject({ state: "delivered" });
    expect(
      (await openInboxItems(db, { project, recipient: "coordinator" })).filter(
        (item) => item.kind === "delivery-failed",
      ),
    ).toHaveLength(0);
  });

  test("launch failures rewrite one notice, suppress not-started and close on claim without reopening after a late result", async () => {
    const P = "launch-outcome-claim";
    await upsertProject(
      db,
      { slug: P, name: "Launch outcomes", repository: "acme/launch-outcomes", programRoot: "ABC-1" },
      at(0),
    );
    const store = fleetStore(db);
    const ticket = "ABC-1429";
    const { worker } = await createLaunch(db, {
      organization: "org-a",
      project: P,
      ticket,
      launcher: { kind: "session", id: "owner", label: "Synthetic Owner" },
      now: at(10),
    });
    const failure = {
      project: P,
      ticket,
      outcome: "failed" as const,
      reason: "unknown model",
      next: `armada launch ${ticket}`,
      launchId: worker.id,
      coordinator: "default",
      at: at(11),
    };
    await Promise.all([store.recordLaunchFailure(failure), store.recordLaunchFailure(failure)]);
    const [first] = await store.openInboxItems({ project: P, ticket, recipient: "coordinator" });
    expect(first).toMatchObject({ kind: "launch-failed", body: `unknown model\nNext: armada launch ${ticket}` });
    await store.recordLaunchFailure({ ...failure, outcome: "uncertain", reason: "launch timed out", at: at(12) });
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toMatchObject([
      { id: first?.id, kind: "launch-uncertain" },
    ]);
    const inbox = await readInbox(store, { project: P, silentAfterMinutes: 15, now: at(25) });
    expect(inbox.filter((i) => i.ticket === ticket).map((i) => i.kind)).toEqual(["launch-uncertain"]);
    await recordClaim(
      store,
      P,
      {
        ticket,
        runtime: "conductor",
        handle: "workspace/session",
        branch: null,
        phase: "implementing",
        resuming: false,
        profile: null,
        workerSessionId: worker.id,
      },
      at(26),
    );
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toEqual([]);
    await store.recordLaunchFailure({ ...failure, at: at(27) });
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toEqual([]);
  });

  test("successful launch and explicit revoke clear notices without an old generation clearing a newer failure", async () => {
    const P = "launch-outcome-revoke";
    await upsertProject(
      db,
      { slug: P, name: "Launch outcomes", repository: "acme/launch-outcomes", programRoot: "ABC-1" },
      at(0),
    );
    const store = fleetStore(db);
    const ticket = "ABC-1439";
    const make = (now: Date) =>
      createLaunch(db, {
        organization: "org-a",
        project: P,
        ticket,
        launcher: { kind: "session", id: "owner", label: "Synthetic Owner" },
        now,
      });
    const old = (await make(at(30))).worker;
    const failure = {
      project: P,
      ticket,
      outcome: "failed" as const,
      reason: "runtime refused",
      next: `armada launch ${ticket}`,
      launchId: old.id,
      at: at(31),
    };
    await store.recordLaunchFailure(failure);
    const next = (await make(at(32))).worker;
    expect(
      await bindLaunch(db, {
        organization: "org-a",
        project: P,
        ticket,
        id: next.id,
        runtime: "conductor",
        handle: "new/session",
        now: at(33),
      }),
    ).toBe("bound");
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toEqual([]);
    await store.recordLaunchFailure({ ...failure, at: at(34) });
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toEqual([]);
    await store.recordLaunchFailure({ ...failure, outcome: "uncertain", launchId: next.id, at: at(34) });
    const actor = { kind: "person" as const, id: "owner", label: "Synthetic Owner" };
    await revokePendingLaunch(db, { organization: "org-a", project: P, ticket, id: old.id, by: actor, now: at(35) });
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toHaveLength(1);
    await revokePendingLaunch(db, { organization: "org-a", project: P, ticket, id: next.id, by: actor, now: at(36) });
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toEqual([]);
    // A known failed launch was already revoked before its notice was recorded.
    await store.recordLaunchFailure({ ...failure, launchId: next.id, at: at(37) });
    await revokePendingLaunch(db, { organization: "org-a", project: P, ticket, by: actor, now: at(38) });
    expect(await store.openInboxItems({ project: P, ticket, recipient: "coordinator" })).toEqual([]);
  });

  test("merge notice reservations and resolved notes survive retries and concurrent coordinators", async () => {
    const project = "merge-notices";
    await upsertProject(
      db,
      { slug: project, name: "Notices", repository: "acme/notices", programRoot: "WID-1" },
      at(0),
    );
    const store = fleetStore(db);
    const reservations = await Promise.all(
      Array.from({ length: 3 }, () => store.prepareMergeNotice(project, "merge-a", at(1))),
    );
    expect(reservations.filter((r) => r === "reserved")).toHaveLength(1);
    expect(reservations.filter((r) => r === "attempted")).toHaveLength(2);
    const plan = await addInboxItem(db, {
      project,
      ticket: "WID-7",
      kind: "plan",
      recipient: "coordinator",
      author: null,
      body: "Pending plan",
      at: at(0),
    });
    const note = { project, key: "merge-a", ticket: "WID-7", text: "main moved: PR #9", at: at(2) };
    await Promise.all([store.recordMergeNotice(note), store.recordMergeNotice(note)]);
    expect(await store.prepareMergeNotice(project, "merge-a", at(3))).toBe("delivered");
    expect((await store.getInboxItem(project, plan))?.resolvedAt).toBeNull();
    const rows = await db.query("SELECT body, resolved_at FROM inbox_items WHERE project = $1 AND kind = 'note'", [
      project,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.resolved_at).not.toBeNull();
    // A second ticket in the same session records its own audit note without another native delivery.
    await store.recordMergeNotice({ ...note, ticket: "WID-8" });
    expect(
      (await db.query("SELECT id FROM inbox_items WHERE project = $1 AND kind = 'note'", [project])).rows,
    ).toHaveLength(2);
  });
  test("a stale release leaves the replacement claim, profile, plans and questions untouched", async () => {
    const project = "guarded-release";
    await upsertProject(
      db,
      { slug: project, name: "Release", repository: "acme/release", programRoot: "WID-1" },
      at(0),
    );
    const ticket = "WID-97";
    const store = fleetStore(db);
    await saveRuntimeHandle(db, {
      project,
      ticket,
      runtime: "Conductor",
      handle: "ws/s",
      branch: null,
      workerSessionId: "worker-new",
      at: at(5),
    });
    await saveWorkerProfile(db, {
      project,
      ticket,
      profile: {
        name: "test",
        agent: "codex",
        model: "test",
        effort: "high",
        fastMode: false,
        routed: null,
        reason: null,
        why: "test",
      },
      at: at(5),
    });
    const common = {
      project,
      ticket,
      recipient: "coordinator" as const,
      author: "ws/s",
      body: "replacement item",
      at: at(6),
    };
    const ids: number[] = [];
    for (const kind of ["plan", "question", "answer-request"] as const)
      ids.push(await addInboxItem(db, { ...common, kind }));
    await putHandBack(db, { project, ticket, author: "worker-new", body: "PR #97", at: at(6) });
    await putHandBack(db, { project, ticket, author: "worker-old", body: "PR #96", at: at(6) });
    expect(
      (await openInboxItems(db, { project, recipient: "coordinator", ticket })).find((i) => i.kind === "hand-back"),
    ).toMatchObject({ author: "worker-new", body: "PR #97" });
    const before = await lastEventTimes(db, project);
    for (const guard of [
      { handle: "ws/s", claimedAt: at(0).toISOString() },
      { workerSessionId: "worker-old" },
      { handle: "old/s" },
    ]) {
      expect(await recordRelease(store, project, { ticket, reason: "late", ...guard }, at(7))).toEqual({
        released: false,
      });
      expect((await getRuntimeHandle(db, project, ticket))?.releasedAt).toBeNull();
      expect((await getRuntimeHandle(db, project, ticket))?.profile).toBe("test");
      expect(
        (await openInboxItems(db, { project, recipient: "coordinator", ticket })).filter((item) =>
          ids.includes(item.id),
        ),
      ).toHaveLength(3);
      expect(await lastEventTimes(db, project)).toEqual(before);
    }
    // Failure late in cleanup rolls back the handle, paths and inbox together.
    await store.saveTicketPaths(project, ticket, ["src/replacement.ts"], at(6));
    const failing: Database = {
      query: db.query.bind(db),
      end: async () => {},
      connect: async () => {
        const connection = await db.connect();
        return {
          release: connection.release.bind(connection),
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO events")) throw new Error("synthetic cleanup failure");
            return connection.query(sql, params);
          },
        };
      },
    };
    await expect(
      recordRelease(
        fleetStore(failing),
        project,
        { ticket, reason: "done", handle: "ws/s", claimedAt: at(5).toISOString() },
        at(7),
      ),
    ).rejects.toThrow("cleanup failure");
    expect((await getRuntimeHandle(db, project, ticket))?.releasedAt).toBeNull();
    expect((await store.ticketPaths(project))[ticket]).toEqual(["src/replacement.ts"]);
    expect(
      (await openInboxItems(db, { project, recipient: "coordinator", ticket })).filter((i) => ids.includes(i.id)),
    ).toHaveLength(3);
    expect(
      await recordRelease(
        store,
        project,
        { ticket, reason: "done", handle: "ws/s", claimedAt: at(5).toISOString(), workerSessionId: "worker-new" },
        at(8),
      ),
    ).toEqual({ released: true });
    expect((await getRuntimeHandle(db, project, ticket))?.releasedAt).toBe(at(8).toISOString());
    expect(
      (await openInboxItems(db, { project, recipient: "coordinator", ticket })).filter((item) => ids.includes(item.id)),
    ).toHaveLength(0);
    expect(
      await recordRelease(
        store,
        project,
        { ticket, reason: "retry", handle: "ws/s", claimedAt: at(5).toISOString(), workerSessionId: "worker-new" },
        at(9),
      ),
    ).toEqual({ released: true });
    const missing = "WID-96";
    expect(
      await recordRelease(
        store,
        project,
        { ticket: missing, reason: "missing", handle: "ws/missing", claimedAt: at(0).toISOString() },
        at(9),
      ),
    ).toEqual({ released: false });
    expect(
      await recordRelease(
        store,
        project,
        { ticket: missing, reason: "Linear-only claim", handle: "ws/missing", workerSessionId: "worker-missing" },
        at(9),
      ),
    ).toEqual({ released: true });
  });

  test("shipping detail persists on events and session reports, and a later phase clears it", async () => {
    const project = "shipping-stages";
    await upsertProject(db, { slug: project, name: "Stages", repository: "acme/stages", programRoot: "WID-1" }, at(0));
    const ticket = "WID-98";
    await saveRuntimeHandle(db, {
      project,
      ticket,
      runtime: "Conductor",
      handle: "stage/session",
      branch: "feature/wid-98",
      at: at(0),
    });
    await recordEvent(db, {
      project,
      ticket,
      kind: "report",
      phase: "shipping",
      shippingStage: "review",
      at: at(1),
    });
    expect((await latestEvents(db, project))[ticket]?.shippingStage).toBe("review");
    expect(
      (await listSessions(db, project, { since: at(0) })).find((s) => s.ticket === ticket)?.lastReport?.shippingStage,
    ).toBe("review");
    await recordEvent(db, { project, ticket, kind: "report", phase: "shipping", shippingStage: "ci", at: at(2) });
    expect((await latestEvents(db, project))[ticket]?.shippingStage).toBe("ci");
    await recordEvent(db, { project, ticket, kind: "report", phase: "implementing", at: at(3) });
    expect((await latestEvents(db, project))[ticket]?.shippingStage).toBeNull();
    expect(
      (await listSessions(db, project, { since: at(0) })).find((s) => s.ticket === ticket)?.lastReport?.shippingStage,
    ).toBeNull();
  });

  test("heartbeats atomically target the current claim, never change reports, and stop on release or replacement", async () => {
    const ticket = "WID-99";
    const handle = {
      project: P,
      ticket,
      runtime: "Conductor",
      handle: "workspace/session",
      branch: "feature/wid-99",
      workerSessionId: "worker-one",
      at: at(0),
    };
    await saveRuntimeHandle(db, handle);
    await recordEvent(db, {
      project: P,
      ticket,
      kind: "report",
      phase: "implementing",
      message: "building",
      at: at(1),
    });
    const ping = {
      project: P,
      ticket,
      handle: handle.handle,
      claimedAt: at(0).toISOString(),
      workerSessionId: "worker-one",
      at: at(5),
    };
    expect(await recordHeartbeat(db, ping)).toEqual({ active: true, claimedAt: at(0).toISOString() });
    expect((await heartbeatTimes(db, P))[ticket]).toBe(at(5).toISOString());
    expect((await latestEvents(db, P))[ticket]?.phase).toBe("implementing");
    expect((await lastEventTimes(db, P))[ticket]).toBe(at(1).toISOString());
    expect((await listSessions(db, P, { since: at(0) })).find((session) => session.ticket === ticket)).toMatchObject({
      lastHeartbeatAt: at(5).toISOString(),
      lastReport: { at: at(1).toISOString(), message: "building", phase: "implementing", shippingStage: null },
    });
    expect(await recordHeartbeat(db, { ...ping, workerSessionId: "stale-worker" })).toEqual({
      active: false,
      claimedAt: null,
    });
    expect(await recordHeartbeat(db, { ...ping, project: "another-project" })).toEqual({
      active: false,
      claimedAt: null,
    });
    await saveRuntimeHandle(db, { ...handle, workerSessionId: "replacement", at: at(10) });
    expect(await recordHeartbeat(db, ping)).toEqual({ active: false, claimedAt: null });
    expect((await getRuntimeHandle(db, P, ticket))?.lastHeartbeatAt).toBeUndefined();
    const replacement = { ...ping, workerSessionId: "replacement", claimedAt: at(10).toISOString(), at: at(11) };
    expect(await recordHeartbeat(db, replacement)).toEqual({ active: true, claimedAt: at(10).toISOString() });
    await releaseRuntimeHandle(db, P, ticket, at(12));
    expect(await recordHeartbeat(db, replacement)).toEqual({ active: false, claimedAt: null });
    expect((await heartbeatTimes(db, P))[ticket]).toBeUndefined();
  });
  test("the newest event of each ticket since a time, the coordinator's newest inbox read, the open sessions", async () => {
    await recordEvent(db, { project: P, ticket: "WID-2", kind: "claim", phase: "planning", at: at(1) });
    await recordEvent(db, { project: P, ticket: "WID-2", kind: "report", phase: "shipping", prUrl: "u", at: at(3) });
    await recordEvent(db, { project: P, ticket: "WID-3", kind: "report", phase: "implementing", at: at(1) });
    await recordEvent(db, { project: "other", ticket: "WID-2", kind: "report", phase: "blocked", at: at(9) });
    expect(Object.keys(await latestEvents(db, P, { tickets: ["WID-3"] }))).toEqual(["WID-3"]);
    expect(await latestEvents(db, P, { tickets: [] })).toEqual({});
    expect(await latestEvents(db, P, { since: at(2), tickets: ["WID-3"] })).toEqual({});
    const latest = await latestEvents(db, P, { since: at(2) });
    expect(Object.keys(latest)).toEqual(["WID-2"]);
    expect(latest["WID-2"]).toMatchObject({ kind: "report", phase: "shipping", prUrl: "u", at: at(3).toISOString() });
    const latestClaim = (await latestEvents(db, P, { kinds: ["claim"] }))["WID-2"];
    expect(latestClaim?.kind).toBe("claim");
    expect(latestClaim?.id).toBeGreaterThan(0);
    expect(latest["WID-2"]?.id).toBeGreaterThan(latestClaim?.id ?? 0);
    expect(await latestEvents(db, P, { kinds: ["claim"], since: at(2), tickets: ["WID-2"] })).toEqual({});
    expect(await latestEvents(db, P, { kinds: [] })).toEqual({});

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
        coordinator: null,
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

  test("relayed validation decisions renew the bounded answer clock", async () => {
    const id = await addInboxItem(db, {
      project: P,
      ticket: "WID-5",
      kind: "decision",
      recipient: "coordinator",
      author: "Ada",
      body: "Approved the synthetic validation",
      at: at(20),
    });
    expect(await lastAnsweredAt(db, P, { tickets: ["WID-5"] })).toEqual({});
    await resolveInboxItem(db, { project: P, id, resolution: "Delivered to the worker", at: at(22) });
    expect(await lastAnsweredAt(db, P, { tickets: ["WID-5"] })).toEqual({ "WID-5": at(22).toISOString() });
    expect(await lastAnsweredAt(db, "other-project", { tickets: ["WID-5"] })).toEqual({});
    expect(await lastAnsweredAt(db, P, { since: at(23), tickets: ["WID-5"] })).toEqual({});
    expect(await lastAnsweredAt(db, P, { tickets: ["WID-999"] })).toEqual({});
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
    expect(await lastAnsweredAt(db, P, { tickets: ["WID-5"] })).toEqual({ "WID-5": at(22).toISOString() });
    expect(await lastAnsweredAt(db, P, { tickets: [] })).toEqual({});
    expect(await lastAnsweredAt(db, P, { tickets: ["WID-999"] })).toEqual({});
    expect(await lastAnsweredAt(db, P, { since: at(23), tickets: ["WID-5"] })).toEqual({});
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
      ["plan", "Plan B"],
      ["hand-back", "PR 1, CI green"],
    ]);
    await addRequest(db, { ...answer(plan?.id ?? 0, "approved"), ticket: "WID-7" });
    expect(await resolvePlans(db, { project: P, ticket: "WID-7", resolution: "released", at: at(32) })).toBe(1);
    expect((await open()).map((i) => i.kind)).toEqual(["hand-back"]);
  });
});

describe("Linear follow-up work", () => {
  test("one open chore per project and ticket, even when recorded concurrently; resolved history is kept", async () => {
    const projects = ["chore-a", "chore-b"];
    for (const project of projects)
      await upsertProject(
        db,
        { slug: project, name: "Chores", repository: "acme/chores", programRoot: "WID-1" },
        at(0),
      );
    const chore = {
      project: "chore-a",
      ticket: "WID-77",
      kind: "linear-pending" as const,
      pr: 11,
      author: "coordinator",
      body: "Finish Linear for #11",
      coordinator: "night",
      at: at(30),
    };
    await Promise.all([putChore(db, chore), putChore(db, chore)]);
    const open = () => openInboxItems(db, { project: chore.project, recipient: "coordinator", ticket: chore.ticket });
    expect(await open()).toHaveLength(1);
    const original = (await open())[0];
    if (!original) throw new Error("missing chore");
    await putChore(db, {
      ...chore,
      body: "Run: armada merge --finish 11",
      author: "another coordinator",
      coordinator: "day",
      at: at(31),
    });
    expect(await open()).toMatchObject([
      {
        id: original.id,
        body: "Run: armada merge --finish 11",
        author: "another coordinator",
        coordinator: "day",
        createdAt: at(31).toISOString(),
      },
    ]);
    await putChore(db, { ...chore, project: "chore-b" });
    expect(await openInboxItems(db, { project: "chore-b", recipient: "coordinator" })).toHaveLength(1);
    await expect(
      addInboxItem(db, {
        project: chore.project,
        ticket: chore.ticket,
        kind: chore.kind,
        recipient: "coordinator",
        author: null,
        body: "duplicate",
        at: at(31),
      }),
    ).rejects.toThrow("inbox_one_open_chore");
    expect(
      await resolveInboxItem(db, { project: chore.project, id: original.id, resolution: "finished", at: at(32) }),
    ).toBe(true);
    await putChore(db, { ...chore, at: at(33) });
    expect(await open()).toHaveLength(1);
    expect((await open())[0]?.id).not.toBe(original.id);
    expect(
      (await db.query("SELECT id FROM inbox_items WHERE project = $1 AND ticket = $2", [chore.project, chore.ticket]))
        .rows,
    ).toHaveLength(2);
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

test("long jobs persist across store instances, are project scoped and never revive after stopping", async () => {
  const project = { slug: "job-project", name: "Runner", repository: "acme/runner", programRoot: "DEMO-1" };
  const store = fleetStore(db);
  await store.ensureProject(project, at(0));
  const job = await store.startJob({
    project: project.slug,
    ticket: "DEMO-7",
    name: "eval",
    startedBy: "worker-1",
    at: at(0),
  });
  expect(job).toMatchObject({ state: "starting", ref: null, startedAt: at(0).toISOString(), finishedAt: null });
  const next = fleetStore(db);
  await next.observeJob({ project: project.slug, ticket: job.ticket, id: job.id, state: "running", at: at(0) });
  const running = await next.observeJob({
    project: project.slug,
    ticket: job.ticket,
    id: job.id,
    ref: "run-1",
    state: "running",
    progress: "37/120 cases",
    eta: at(120).toISOString(),
    at: at(1),
  });
  expect(running).toMatchObject({
    ref: "run-1",
    state: "running",
    progress: "37/120 cases",
    eta: at(120).toISOString(),
    observedAt: at(1).toISOString(),
  });
  expect(await store.listJobs(project.slug, { open: true })).toEqual(running ? [running] : []);
  expect(await next.listJobs("other-project", {})).toEqual([]);
  expect(await next.getJob("other-project", job.id)).toBeNull();
  expect(
    await next.observeJob({ project: project.slug, ticket: "DEMO-8", id: job.id, state: "stopped", at: at(2) }),
  ).toBeNull();
  expect(
    (
      await next.observeJob({
        project: project.slug,
        ticket: job.ticket,
        id: job.id,
        state: "running",
        progress: "old",
        at: at(0),
      })
    )?.progress,
  ).toBe("37/120 cases");
  expect(
    await next.observeJob({
      project: project.slug,
      ticket: job.ticket,
      id: job.id,
      state: "failed",
      ref: "replacement",
      at: at(2),
    }),
  ).toEqual(running);
  const stopped = await next.observeJob({
    project: project.slug,
    ticket: job.ticket,
    id: job.id,
    state: "stopped",
    at: at(2),
  });
  expect(stopped).toMatchObject({ state: "stopped", ref: "run-1", eta: null, finishedAt: at(2).toISOString() });
  expect(
    (
      await next.observeJob({
        project: project.slug,
        ticket: job.ticket,
        id: job.id,
        state: "running",
        ref: "forged",
        at: at(3),
      })
    )?.state,
  ).toBe("stopped");
  expect(await next.listJobs(project.slug, { open: true })).toEqual([]);
  expect(await next.listJobs(project.slug, { ticket: job.ticket, id: job.id })).toEqual(stopped ? [stopped] : []);

  // The dashboard shows every open job, and the ended jobs of the tickets it shows since a time (THE-1128).
  const open = await store.startJob({
    project: project.slug,
    ticket: "DEMO-9",
    name: "eval",
    startedBy: null,
    at: at(3),
  });
  expect(await shownJobs(db, project.slug, [job.ticket], at(2))).toEqual(stopped ? [open, stopped] : []);
  expect(await shownJobs(db, project.slug, [job.ticket], at(3))).toEqual([open]);
  expect(await shownJobs(db, project.slug, [], at(0))).toEqual([open]);
  expect(await shownJobs(db, "other-project", [job.ticket], at(0))).toEqual([]);
  // An open job comes before newer ended ones, so the limit never cuts it.
  const rerun = await store.startJob({
    project: project.slug,
    ticket: job.ticket,
    name: "eval",
    startedBy: null,
    at: at(4),
  });
  const failed = await store.observeJob({
    project: project.slug,
    ticket: job.ticket,
    id: rerun.id,
    state: "failed",
    at: at(5),
  });
  expect(await shownJobs(db, project.slug, [job.ticket], at(2))).toEqual(
    failed && stopped ? [open, failed, stopped] : [],
  );
});

test("a deferred request survives storage, shares launch uniqueness and is resolved by the worker claim", async () => {
  const project = "deferred-requests";
  await upsertProject(
    db,
    { slug: project, name: "Deferred", repository: "acme/deferred", programRoot: "WID-1" },
    at(0),
  );
  const store = fleetStore(db);
  const request = {
    project,
    ticket: "WID-9",
    kind: "launch-request" as const,
    author: "Ada",
    body: "Wait for blockers",
    question: null,
    profile: "backend",
    deferred: true,
    at: at(0),
  };
  const id = await store.addRequest(request);
  expect(id).not.toBeNull();
  expect(await store.addRequest({ ...request, deferred: false })).toBeNull();
  expect(await store.openInboxItems({ project, recipient: "coordinator" })).toMatchObject([
    { id, request: { deferred: true, profile: "backend" } },
  ]);
  await recordClaim(
    store,
    project,
    {
      ticket: "WID-9",
      runtime: "Conductor",
      handle: "ws/9",
      branch: null,
      phase: null,
      resuming: false,
      profile: null,
    },
    at(1),
  );
  expect(await store.openInboxItems({ project, recipient: "coordinator" })).toEqual([]);
});

test("merge holds deduplicate automatic pauses and atomically open and resolve their inbox items", async () => {
  const database = await tempDatabase();
  try {
    const store = fleetStore(database);
    await store.ensureProject(
      { slug: "hold-test", name: "Hold test", repository: "acme/widgets", programRoot: "DEMO-1" },
      at(0),
    );
    const input = {
      project: "hold-test",
      kind: "deploy" as const,
      ref: "api",
      reason: "smoke failed",
      author: "Ada",
      at: at(0),
    };
    const hold = await store.openHold(input);
    expect((await store.openHold({ ...input, author: "Grace", at: at(1) })).id).toBe(hold.id);
    const manual = await store.openHold({ ...input, kind: "manual", ref: null });
    expect((await store.openHold({ ...input, kind: "manual", ref: null })).id).not.toBe(manual.id);
    const inbox = await store.openInboxItems({ project: input.project, recipient: "coordinator" });
    expect(inbox).toHaveLength(3);
    expect(inbox[0]).toMatchObject({ kind: "hold", ticket: null, author: "Ada" });
    expect(inbox[0]?.body).toContain(`hold #${hold.id}`);
    expect(
      await store.clearHold({ project: "elsewhere", id: hold.id, reason: "wrong project", author: "Grace", at: at(2) }),
    ).toBeNull();
    const cleared = await store.clearHold({
      project: input.project,
      id: hold.id,
      reason: "verified",
      author: "Grace",
      at: at(2),
    });
    if (!cleared) throw new Error("expected the cleared hold");
    expect(cleared).toMatchObject({
      cleared: true,
      hold: { clearedBy: "Grace", clearedAt: at(2).toISOString(), clearReason: "verified" },
    });
    expect(
      await store.clearHold({ project: input.project, id: hold.id, reason: "repeat", author: "Ada", at: at(3) }),
    ).toEqual({ ...cleared, cleared: false });
    expect(
      (await store.openInboxItems({ project: input.project, recipient: "coordinator" })).map((i) => i.body),
    ).not.toContain(inbox[0]?.body);
    expect(await store.openHolds("elsewhere")).toEqual([]);
    expect((await store.openHold(input)).id).not.toBe(hold.id);
    const count = (await store.openHolds(input.project)).length;
    await database.query("ALTER TABLE inbox_items ADD CONSTRAINT reject_test_holds CHECK (kind <> 'hold') NOT VALID");
    await expect(
      store.openHold({ ...input, kind: "main-red", ref: "abcdef", reason: "tests failed" }),
    ).rejects.toThrow();
    expect(await store.openHolds(input.project)).toHaveLength(count);
  } finally {
    await database.end();
  }
});

test("merge queue preserves intent, deduplicates concurrent adds and fences dequeue and finish with the lease", async () => {
  const project = "queue-test";
  const input = {
    project,
    pr: 12,
    ticket: "WID-12",
    noTicket: false,
    keepOpen: false,
    throughHold: null,
    reason: "Reviewed",
    headSha: "a".repeat(40),
    queuedBy: "coordinator-a",
    at: at(0),
  };
  const store = fleetStore(db);
  const adds = await Promise.all([store.queueAdd(input), store.queueAdd(input)]);
  expect(adds.filter((e) => "existing" in e)).toHaveLength(1);
  const first = (await fleetStore(db).queueList(project, { since: at(0) }))[0]!;
  expect(first).toMatchObject({ pr: 12, reason: "Reviewed", state: "queued", headSha: input.headSha });
  expect(await store.queueAdd({ ...input, pr: 15 })).toMatchObject({ position: 2 });
  expect(await store.queueNext({ project, holder: "a", at: at(1) })).toEqual({ refused: true, held: null });
  expect(await store.acquireLease({ project, name: "merge-queue", holder: "a", ttlMs: 60_000, at: at(1) })).toEqual({
    acquired: true,
  });
  const secondHolder = await store.acquireLease({
    project,
    name: "merge-queue",
    holder: "b",
    ttlMs: 60_000,
    at: at(1),
  });
  expect(secondHolder).toMatchObject({ acquired: false, held: { holder: "a" } });
  expect(await store.queueNext({ project, holder: "b", at: at(1) })).toMatchObject({
    refused: true,
    held: { holder: "a" },
  });
  expect(await store.queueNext({ project, holder: "a", at: at(1) })).toMatchObject({
    entry: { id: first.id, state: "merging" },
    holds: [],
  });
  expect(await store.queueRemove({ project, pr: 12, at: at(1) })).toBe(false);
  expect(
    await store.queueFinish({ project, id: first.id, holder: "b", outcome: "merged", detail: null, at: at(1) }),
  ).toBe(false);
  // A lost session's successor resumes its unfinished entry before taking another.
  await store.acquireLease({ project, name: "merge-queue", holder: "b", ttlMs: 600_000, at: at(3) });
  expect(await store.queueNext({ project, holder: "b", at: at(3) })).toMatchObject({ entry: { id: first.id } });
  expect(
    await store.queueFinish({ project, id: first.id, holder: "a", outcome: "merged", detail: null, at: at(3) }),
  ).toBe(false);
  expect(
    await store.queueFinish({ project, id: first.id, holder: "b", outcome: "paused", detail: "paused", at: at(3) }),
  ).toBe(true);
  expect((await store.queueList(project, { since: at(0) }))[0]).toMatchObject({
    state: "queued",
    attempts: 0,
    finishedAt: null,
  });
  expect(await store.queueNext({ project, holder: "b", at: at(3) })).toMatchObject({ entry: { id: first.id } });
  expect(
    await store.queueFinish({
      project,
      id: first.id,
      holder: "b",
      outcome: "retry",
      detail: "CI running",
      notBefore: at(5).toISOString(),
      at: at(3),
    }),
  ).toBe(true);
  expect((await store.queueList(project, { since: at(0) }))[0]).toMatchObject({
    state: "queued",
    attempts: 1,
    detail: "CI running",
  });
  expect(await store.queueNext({ project, holder: "b", at: at(3) })).toMatchObject({ entry: null });
  expect(await store.queueNext({ project, holder: "b", at: at(5) })).toMatchObject({ entry: { pr: 12 } });
  await store.queueFinish({ project, id: first.id, holder: "b", outcome: "retry", detail: null, at: at(5) });
  expect(await store.queueRemove({ project, pr: 12, at: at(5) })).toBe(true);
  expect(await store.queueNext({ project, holder: "b", at: at(5) })).toMatchObject({ entry: { pr: 15 } });
  const second = (await store.queueList(project, { since: at(0) }))[1]!;
  // The drain's step on the entry it merges (THE-1103): written by the lease's holder only.
  const step = { project, id: second.id, detail: "Waiting: the checks on the updated head of #15", at: at(5) };
  expect(await store.queueProgress({ ...step, holder: "a" })).toBe(false);
  expect(await store.queueProgress({ ...step, holder: "b" })).toBe(true);
  expect((await store.queueList(project, { since: at(0) }))[1]).toMatchObject({
    state: "merging",
    detail: step.detail,
    updatedAt: at(5).toISOString(),
  });
  expect(
    await store.queueFinish({
      project: "other",
      id: second.id,
      holder: "b",
      outcome: "refused",
      detail: "head moved",
      at: at(3),
    }),
  ).toBe(false);
  expect(
    await store.queueFinish({
      project,
      id: second.id,
      holder: "b",
      outcome: "refused",
      detail: "head moved",
      at: at(3),
    }),
  ).toBe(true);
  expect(
    await store.queueFinish({
      project,
      id: second.id,
      holder: "b",
      outcome: "refused",
      detail: "head moved",
      at: at(3),
    }),
  ).toBe(false);
  expect(await store.openInboxItems({ project, recipient: "coordinator" })).toMatchObject([
    { kind: "queue-refused", ticket: "WID-12", body: expect.stringContaining("head moved") },
  ]);
  expect(await store.queueRemove({ project, pr: 12, at: at(3) })).toBe(false);
  expect(await store.queueList(project, { since: at(6) })).toEqual([]);
  expect(await store.queueAdd({ ...input, at: at(4) })).toMatchObject({ position: 1 });
  expect(await store.openInboxItems({ project, recipient: "coordinator" })).toHaveLength(1);
  // Queuing the refused pull request again settles its refusal.
  await store.queueAdd({ ...input, pr: 15, at: at(4) });
  expect(await store.openInboxItems({ project, recipient: "coordinator" })).toEqual([]);
});

test("events/since uses the project, kinds and tickets, pages ties and reads late commits once", async () => {
  const project = "follow-stream";
  await upsertProject(db, { slug: project, name: "Follow", repository: "acme/follow", programRoot: "WID-1" }, at(0));
  for (const kind of ["report", "report", "heartbeat", "claim"] as const)
    await recordEvent(db, { project, ticket: "WID-2", kind, message: kind, at: at(1) });
  const q = { afterId: 0, afterAt: at(0).toISOString(), kinds: ["report"] as const, tickets: ["WID-2"], limit: 1 };
  const first = await eventsSince(db, project, q);
  expect(first).toHaveLength(1);
  const firstEvent = first[0];
  if (!firstEvent) throw new Error("missing first page");
  const next = await eventsSince(db, project, { ...q, pageAfter: { id: firstEvent.id, at: firstEvent.at } });
  expect(next).toHaveLength(1);
  const one = first[0],
    two = next[0];
  if (!one || !two) throw new Error("missing event page");
  expect(two.id).toBeGreaterThan(one.id);
  const boundary = { ...q, afterId: two.id, afterAt: two.at, seenIds: [one.id, two.id] };
  expect(await eventsSince(db, project, boundary)).toEqual([]);
  await recordEvent(db, {
    project,
    ticket: "WID-2",
    kind: "report",
    message: "late",
    at: new Date(at(1).getTime() - 10000),
  });
  const late = await eventsSince(db, project, boundary);
  expect(late.map((e) => e.message)).toEqual(["late"]);
  const lateEvent = late[0];
  if (!lateEvent) throw new Error("missing late event");
  expect(await eventsSince(db, project, { ...boundary, seenIds: [...boundary.seenIds, lateEvent.id] })).toEqual([]);
  expect(await eventsSince(db, project, { ...q, tickets: ["WID-3"] })).toEqual([]);
  expect(await eventsSince(db, "unknown-project", q)).toEqual([]);
  expect(await eventsSince(db, project, { ...q, excludedTickets: ["WID-2"] })).toEqual([]);
  expect(await eventsSince(db, project, { ...boundary, excludedTickets: ["WID-2"] })).toEqual([]);
});

test("events/since selects handover reports before pagination", async () => {
  const project = "follow-handover";
  await upsertProject(db, { slug: project, name: "Handover", repository: "acme/follow", programRoot: "WID-1" }, at(0));
  await recordEvent(db, { project, ticket: "WID-2", kind: "report", phase: "implementing", at: at(1) });
  await recordEvent(db, { project, ticket: "WID-2", kind: "report", phase: "ready-to-merge", at: at(2) });
  const events = await eventsSince(db, project, {
    afterId: 0,
    afterAt: at(0).toISOString(),
    kinds: ["report"],
    handoverOnly: true,
    limit: 1,
  });
  expect(events.map((e) => e.phase)).toEqual(["ready-to-merge"]);
});

test("declared paths replace the old plan, stay scoped to a project and are cleared on release and merge", async () => {
  const { recordMerge } = await import("@armada/core/read");
  const store = fleetStore(db);
  for (const slug of ["paths-a", "paths-b"]) {
    await store.ensureProject({ slug, name: slug, repository: "acme/widgets", programRoot: "WID-1" }, at(0));
    await store.saveRuntimeHandle({
      project: slug,
      ticket: "WID-7",
      runtime: "conductor",
      handle: `ws/${slug}`,
      branch: null,
      at: at(0),
    });
    await store.saveTicketPaths(slug, "WID-7", ["src/**"], at(1));
  }
  await store.saveTicketPaths("paths-a", "WID-7", ["docs/readme.md"], at(2));
  expect(await store.ticketPaths("paths-a")).toEqual({ "WID-7": ["docs/readme.md"] });
  await recordRelease(store, "paths-a", { ticket: "WID-7", reason: "done" }, at(3));
  expect(await store.ticketPaths("paths-a")).toEqual({});
  expect(await store.ticketPaths("paths-b")).toEqual({ "WID-7": ["src/**"] });
  await recordMerge(
    store,
    "paths-b",
    {
      ticket: "WID-7",
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      headSha: "a".repeat(40),
      mergeCommit: "b".repeat(40),
      decision: null,
    },
    at(4),
  );
  expect(await store.ticketPaths("paths-b")).toEqual({});
});

test("a higher reserved version does not hide a later merge-hold migration", async () => {
  const database = await tempDatabase();
  try {
    const migration = DB_MIGRATIONS.find((m) => m.statements.some((s) => s.includes("CREATE TABLE merge_holds")));
    if (!migration) throw new Error("missing hold migration");
    await database.query("DROP TABLE merge_holds");
    await database.query("DELETE FROM armada_migrations WHERE version = $1", [migration.version]);
    // Another branch applied its higher reserved version first.
    await database.query("INSERT INTO armada_migrations (version, applied_at) VALUES ($1, $2)", [
      DB_SCHEMA_VERSION + 1,
      at(0),
    ]);
    expect(await migrateDatabase(database, at(1))).toBe(DB_SCHEMA_VERSION);
    expect((await database.query("SELECT to_regclass('merge_holds') AS name")).rows[0]?.name).not.toBeNull();
    expect(
      (await database.query("SELECT version FROM armada_migrations WHERE version = $1", [migration.version])).rows,
    ).toEqual([{ version: migration.version }]);
    expect(await migrateDatabase(database, at(2))).toBe(DB_SCHEMA_VERSION);
  } finally {
    await database.end();
  }
});

test("job progress clocks ignore ETA chatter and stale probes, but track movement and clearing", async () => {
  const project = { slug: "progress-clocks", name: "Jobs", repository: "acme/jobs", programRoot: "DEMO-1" };
  const store = fleetStore(db);
  await store.ensureProject(project, at(0));
  const job = await store.startJob({
    project: project.slug,
    ticket: "DEMO-7",
    name: "eval",
    startedBy: null,
    at: at(0),
  });
  expect(job.progressChangedAt).toBe(at(0).toISOString());
  const observe = (minutes: number, progress?: string | null, expectedRevision?: number) =>
    store.observeJob({
      project: project.slug,
      ticket: job.ticket,
      id: job.id,
      state: "running",
      at: at(minutes),
      progress,
      expectedRevision,
    });
  const first = await observe(1, "40/120 ETA 03:10");
  const repeated = await observe(2, "40/120 ETA 03:20");
  expect(repeated?.progress).toBe("40/120 ETA 03:20");
  expect(repeated?.observedAt).toBe(at(2).toISOString());
  expect(repeated?.progressChangedAt).toBe(at(1).toISOString());
  const moved = await observe(3, "41/120 ETA 03:30");
  expect(moved?.progressChangedAt).toBe(at(3).toISOString());
  const stale = await observe(4, "40/120", first?.revision);
  expect(stale?.progress).toBe("41/120 ETA 03:30");
  expect(stale?.progressChangedAt).toBe(at(3).toISOString());
  expect((await observe(5))?.progressChangedAt).toBe(at(3).toISOString());
  expect((await observe(6, null))?.progressChangedAt).toBe(at(6).toISOString());
  expect((await observe(7, "preparing"))?.progressChangedAt).toBe(at(7).toISOString());
  expect((await observe(8, "processing"))?.progressChangedAt).toBe(at(8).toISOString());
});

test("concurrent terminal job observations atomically store one coordinator notice with last progress", async () => {
  const project = { slug: "job-notices", name: "Jobs", repository: "acme/jobs", programRoot: "DEMO-1" };
  const store = fleetStore(db);
  await store.ensureProject(project, at(0));
  for (const state of ["succeeded", "failed", "stopped", "lost"] as const) {
    const job = await store.startJob({
      project: project.slug,
      ticket: "DEMO-7",
      name: "eval",
      startedBy: "runner",
      at: at(0),
    });
    await store.observeJob({
      project: project.slug,
      ticket: job.ticket,
      id: job.id,
      state: "running",
      progress: "40/120",
      at: at(0),
    });
    await store.observeJob({
      project: project.slug,
      ticket: job.ticket,
      id: job.id,
      state: "running",
      progress: "40/120",
      at: at(0),
    });
    const stale = await store.observeJob({
      project: project.slug,
      ticket: job.ticket,
      id: job.id,
      state: "failed",
      progress: "old result",
      expectedRevision: 1,
      at: at(2),
    });
    expect(stale?.state).toBe("running");
    expect(stale?.progress).toBe("40/120");
    const input = { project: project.slug, ticket: job.ticket, id: job.id, state, at: at(2) };
    const outcomes = await Promise.all([store.observeJob(input), fleetStore(db).observeJob(input)]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]?.progress).toBe("40/120");
    await store.observeJob({ ...input, state: "running", at: at(3) });
  }
  const items = await store.openInboxItems({ project: project.slug, recipient: "coordinator" });
  expect(items).toHaveLength(4);
  expect(items.map((i) => i.kind)).toEqual(["job", "job", "job", "job"]);
  for (const item of items) {
    expect(item.ticket).toBe("DEMO-7");
    expect(item.body).toContain("eval");
    expect(item.body).toContain("40/120");
    expect(item.createdAt).toBe(at(2).toISOString());
  }
  expect(items.map((i) => i.body).join("\n")).toContain("succeeded");
  expect(items.map((i) => i.body).join("\n")).toContain("lost");
});

test("terminal jobs notify their live originating worker; silence and orphaned jobs notify the coordinator", async () => {
  const project = { slug: "job-routing", name: "Jobs", repository: "acme/jobs", programRoot: "DEMO-1" };
  const store = fleetStore(db);
  await store.ensureProject(project, at(0));
  await db.query("UPDATE projects SET organization_id = $2 WHERE slug = $1", [project.slug, "org-a"]);
  const launcher = { kind: "session" as const, id: "person-a", label: "Demo coordinator" };
  for (const [index, owner] of ["worker", "coordinator", "revoked", "expired", "replacement"].entries()) {
    const ticket = `DEMO-${index + 20}`;
    const launch = await createLaunch(db, {
      organization: "org-a",
      project: project.slug,
      ticket,
      launcher,
      now: at(0),
    });
    const signedIn = await exchangeLaunch(db, { token: launch.token, address: `demo-${index}`, now: at(0) });
    expect(signedIn.ok).toBe(true);
    const workerCaller = { kind: "worker" as const, ticket, sessionId: launch.worker.id };
    const startCaller = owner === "coordinator" ? { kind: "organization" as const, author: launcher.id } : workerCaller;
    const coordinatorItems = () => store.openInboxItems({ project: project.slug, recipient: "coordinator", ticket });
    const jobs: Job[] = [];
    for (let i = 0; i < 2; i++) {
      const started = await serveFleet(
        store,
        {
          op: "job/start",
          project,
          caller: startCaller,
          input: { ticket, name: "eval", startedBy: "forged" },
        },
        { now: () => at(0) },
      );
      expect(started.status).toBe(200);
      const job = started.body.result as Job;
      jobs.push(job);
      expect(job.startedBy).toBe(startCaller === workerCaller ? launch.worker.id : launcher.id);
      await store.observeJob({
        project: project.slug,
        ticket,
        id: job.id,
        state: "running",
        progress: "40/120",
        at: at(0),
      });
      const silent = await readInbox(store, { project: project.slug, silentAfterMinutes: 15, now: at(16) });
      expect(silent.filter((item) => item.kind === "job-silent" && item.jobId === job.id)).toHaveLength(1);
    }
    if (owner === "revoked" || owner === "replacement") {
      await endWorker(db, {
        organization: "org-a",
        id: launch.worker.id,
        reason: "revoked",
        by: launcher,
        now: at(16),
      });
      if (owner === "replacement") {
        const next = await createLaunch(db, {
          organization: "org-a",
          project: project.slug,
          ticket,
          launcher,
          now: at(16),
        });
        expect((await exchangeLaunch(db, { token: next.token, address: "replacement", now: at(16) })).ok).toBe(true);
      }
    } else if (owner === "expired") {
      await db.query('UPDATE "armada_worker" SET "sessionExpiresAt" = $1 WHERE "id" = $2', [at(17), launch.worker.id]);
    }
    for (const [i, job] of jobs.entries()) {
      const input = {
        project: project.slug,
        ticket,
        id: job.id,
        state: i ? ("failed" as const) : ("succeeded" as const),
        at: at(17),
      };
      // Completion may be observed by a coordinator probe or the remote runner; ownership stays with the starter.
      const outcomes = await Promise.all([store.observeJob(input), fleetStore(db).observeJob(input)]);
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0]?.progress).toBe("40/120");
    }
    const workerItems = await store.openInboxItems({ project: project.slug, recipient: "worker", ticket });
    expect(await coordinatorItems()).toHaveLength(owner === "worker" ? 0 : 2);
    expect(workerItems).toHaveLength(owner === "worker" ? 2 : 0);
    if (owner === "worker") {
      const report = await serveFleet(
        store,
        {
          op: "report",
          project,
          caller: workerCaller,
          input: { ticket, phase: "implementing", previous: "implementing", summary: "Checking job results" },
        },
        { now: () => at(18) },
      );
      expect(report.status).toBe(200);
      expect(report.body.result).toEqual(workerItems);
    }
    const durable = await store.listJobs(project.slug, { ticket });
    expect(durable.map((job) => job.state)).toEqual(["failed", "succeeded"]);
    expect(await shownJobs(db, project.slug, [ticket], at(0))).toEqual(durable);
    expect(
      (await readInbox(store, { project: project.slug, silentAfterMinutes: 15, now: at(18) })).filter(
        (item) => item.ticket === ticket && (item.kind === "job" || item.kind === "job-silent"),
      ),
    ).toHaveLength(owner === "worker" ? 0 : 2);
  }
});

test("PR notice resolution preserves the prefix boundary, project, recipient and existing resolutions", async () => {
  const project = "pr-notices";
  const ids: number[] = [];
  for (const pr of [12, 123]) {
    ids.push(
      await addInboxItem(db, {
        project,
        ticket: null,
        recipient: "coordinator",
        kind: "queue-refused",
        author: null,
        body: `PR #${pr} refused: checks failed`,
        at: at(0),
      }),
    );
    ids.push(
      (await addRequest(db, {
        project,
        kind: "merge-request",
        ticket: null,
        pr,
        question: null,
        profile: null,
        author: "owner",
        body: "Please merge",
        at: at(0),
      }))!,
    );
  }
  const others = [
    await addInboxItem(db, {
      project: "other-pr-notices",
      ticket: null,
      recipient: "coordinator",
      kind: "queue-refused",
      author: null,
      body: "PR #12 refused: checks failed",
      at: at(0),
    }),
    await addInboxItem(db, {
      project,
      ticket: "WID-2",
      recipient: "worker",
      kind: "queue-refused",
      author: null,
      body: "PR #12 refused: checks failed",
      at: at(0),
    }),
    await addInboxItem(db, {
      project,
      ticket: "WID-2",
      recipient: "coordinator",
      kind: "hand-back",
      author: null,
      body: "PR #12 ready",
      at: at(0),
    }),
  ];
  const q = { project, pr: 12, resolution: "resolved: PR #12 merged", at: at(1) };
  expect(await resolvePrItems(db, q)).toEqual(ids.slice(0, 2));
  expect(await resolvePrItems(db, { ...q, resolution: "retry", at: at(2) })).toEqual([]);
  const rows = (
    await db.query("SELECT id, resolution FROM inbox_items WHERE id = ANY($1::bigint[]) ORDER BY id", [
      [...ids, ...others],
    ])
  ).rows;
  expect(rows.map((r) => r.resolution)).toEqual([q.resolution, q.resolution, null, null, null, null, null]);
  // No-ticket queue completion reaches the same cleanup without recordMerge.
  const store = fleetStore(db);
  await store.queueAdd({
    project,
    pr: 123,
    ticket: null,
    noTicket: true,
    keepOpen: false,
    throughHold: null,
    reason: null,
    headSha: "a".repeat(40),
    queuedBy: "owner",
    at: at(2),
  });
  // queueAdd resolved its old refusal; a coordinator notice arriving during the drain is settled at finish.
  const later = await addInboxItem(db, {
    project,
    ticket: null,
    recipient: "coordinator",
    kind: "queue-refused",
    author: null,
    body: "PR #123 refused: earlier attempt",
    at: at(2),
  });
  await store.acquireLease({ project, name: "merge-queue", holder: "drain", ttlMs: 600_000, at: at(2) });
  const next = await store.queueNext({ project, holder: "drain", at: at(2) });
  if ("refused" in next || !next.entry) throw new Error("missing entry");
  expect(
    await store.queueFinish({
      project,
      id: next.entry.id,
      holder: "drain",
      outcome: "merged",
      detail: null,
      at: at(3),
    }),
  ).toBe(true);
  expect((await store.getInboxItem(project, ids[3]!))?.resolution).toBe("resolved: PR #123 merged");
  expect((await store.getInboxItem(project, later))?.resolution).toBe("resolved: PR #123 merged");
});

test("queue completion survives a notice cleanup outage after a confirmed no-ticket merge", async () => {
  const project = "queue-cleanup-outage";
  const store = fleetStore(db);
  const queued = await store.queueAdd({
    project,
    pr: 12,
    ticket: null,
    noTicket: true,
    keepOpen: false,
    throughHold: null,
    reason: null,
    headSha: "a".repeat(40),
    queuedBy: "owner",
    at: at(0),
  });
  if (!("id" in queued)) throw new Error("expected new queue entry");
  const id = await addInboxItem(db, {
    project,
    ticket: null,
    recipient: "coordinator",
    kind: "queue-refused",
    author: null,
    body: "PR #12 refused: earlier attempt",
    at: at(0),
  });
  await store.acquireLease({ project, name: "merge-queue", holder: "drain", ttlMs: 600_000, at: at(0) });
  await store.queueNext({ project, holder: "drain", at: at(0) });
  // Keep the real transaction adapter; only its separate cleanup statement fails.
  const failing: Database = {
    connect: () => db.connect(),
    end: async () => {},
    query: async (sql, params) => {
      if (sql.startsWith("UPDATE inbox_items")) throw new Error("cleanup unavailable");
      return db.query(sql, params);
    },
  };
  expect(
    await fleetStore(failing).queueFinish({
      project,
      id: queued.id,
      holder: "drain",
      outcome: "merged",
      detail: null,
      at: at(1),
    }),
  ).toBe(true);
  expect((await store.queueList(project, { since: at(0) }))[0]?.state).toBe("merged");
  expect((await store.getInboxItem(project, id))?.resolvedAt).toBeNull();
  expect(
    await readInbox(store, {
      project,
      now: at(2),
      silentAfterMinutes: 15,
      snapshot: {
        repository: "acme/widgets",
        issues: [],
        prs: [{ repo: "acme/widgets", number: 12, state: "merged" }],
      },
    }),
  ).toEqual([]);
});

test.each([true, false])(
  "a delayed resume cannot retire a replacement's hand-back, even when its id was refreshed in place (session auth: %s)",
  async (authenticated) => {
    const store = fleetStore(db);
    const ticket = authenticated ? "WID-900" : "WID-902";
    await store.saveRuntimeHandle({
      project: P,
      ticket,
      runtime: "Conductor",
      handle: "ws/old",
      branch: null,
      workerSessionId: authenticated ? "old-session" : null,
      at: at(0),
    });
    const report = {
      ticket,
      phase: "ready-to-merge" as const,
      previous: "shipping" as const,
      summary: "PR #900 ready",
      message: "",
      prUrl: null,
      headSha: null,
      workerSessionId: authenticated ? "old-session" : null,
    };
    await recordReport(store, P, report, at(1));
    const old = (await store.openInboxItems({ project: P, recipient: "coordinator", ticket })).find(
      (i) => i.kind === "hand-back",
    );
    if (!old) throw new Error("missing hand-back");
    const racing = {
      ...store,
      recordEvent: async (event: Parameters<typeof store.recordEvent>[0]) => {
        await store.saveRuntimeHandle({
          project: P,
          ticket,
          runtime: "Conductor",
          handle: "ws/new",
          branch: null,
          workerSessionId: authenticated ? "new-session" : null,
          at: at(3),
        });
        await recordReport(
          store,
          P,
          { ...report, workerSessionId: authenticated ? "new-session" : null, summary: "PR #901 ready" },
          at(4),
        );
        await store.recordEvent(event);
      },
    };
    await recordReport(racing, P, { ...report, phase: "shipping", previous: "ready-to-merge" }, at(2));
    expect(await store.getInboxItem(P, old.id)).toMatchObject({
      author: authenticated ? "new-session" : "ws/new",
      body: "Agent status: ready-to-merge — PR #901 ready",
      resolvedAt: null,
    });
    expect(
      (await store.listSessions(P, { since: at(0) })).find((s) => s.ticket === ticket && !s.releasedAt)?.lastReport
        ?.phase,
    ).toBe("ready-to-merge");
  },
);

test("deferred fire admission fences cancellation, expiry, owner, backoff and budget; renewal and handover keep intent", async () => {
  const project = "deferred-admission";
  const store = fleetStore(db);
  await store.upsertProject(
    { slug: project, name: "Waiting", repository: "acme/waiting", programRoot: "WID-1" },
    at(0),
  );
  const request = (ticket: string): NewRequest => ({
    project,
    ticket,
    kind: "launch-request",
    question: null,
    profile: null,
    pinned: false,
    deferred: true,
    author: "Ada",
    coordinator: "front",
    body: "Wait",
    runtime: "conductor",
    notes: "Saved context",
    reason: null,
    expiresAt: at(7 * 1440).toISOString(),
    at: at(0),
  });
  const ids = new Map<string, number>();
  for (const ticket of ["WID-2", "WID-3", "WID-4", "WID-5", "WID-6"]) {
    const id = await store.addRequest(request(ticket));
    expect(id).not.toBeNull();
    if (id === null) throw new Error("missing request id");
    ids.set(ticket, id);
    expect((await store.getInboxItem(project, id))?.request).toMatchObject({
      profile: null,
      pinned: false,
      runtime: "conductor",
      notes: "Saved context",
    });
  }
  const idOf = (ticket: string) => {
    const id = ids.get(ticket);
    if (id === undefined) throw new Error("missing request id");
    return id;
  };
  const attempt = (ticket: string, minutes: number, coordinator = "front") =>
    store.attemptDeferredLaunch({ project, id: idOf(ticket), coordinator, backoffMinutes: 5, at: at(minutes) });
  expect(await attempt("WID-2", 0)).toEqual({ ok: true, attempt: 1 });
  expect(await store.resolveInboxItem({ project, id: idOf("WID-2"), resolution: "declined", at: at(1) })).toBe(true);
  expect(await attempt("WID-2", 6)).toMatchObject({ ok: false, why: "request is closed" });
  expect(await attempt("WID-3", 0)).toEqual({ ok: true, attempt: 1 });
  expect(await attempt("WID-3", 7 * 1440)).toMatchObject({ ok: false, why: "request expired" });
  expect(await attempt("WID-4", 0)).toEqual({ ok: true, attempt: 1 });
  expect(await attempt("WID-4", 6, "back")).toMatchObject({ ok: false, why: "request belongs to another coordinator" });
  expect(await store.transferTickets({ project, tickets: ["WID-4"], from: "front", to: "back", at: at(5) })).toBe(true);
  expect(await attempt("WID-4", 6)).toMatchObject({ ok: false, why: "request belongs to another coordinator" });
  expect(await attempt("WID-4", 6, "back")).toEqual({ ok: true, attempt: 2 });
  expect(await attempt("WID-5", 0)).toEqual({ ok: true, attempt: 1 });
  expect(await attempt("WID-5", 1)).toMatchObject({ ok: false, why: "request attempted too recently" });
  expect(await attempt("WID-5", 5)).toEqual({ ok: true, attempt: 2 });
  expect(await attempt("WID-5", 10)).toEqual({ ok: true, attempt: 3 });
  expect(await attempt("WID-5", 15)).toMatchObject({ ok: false, why: "request exhausted three attempts; renew it" });
  expect(
    await store.renewDeferredLaunch({ ...request("WID-5"), at: at(15), expiresAt: at(15 + 7 * 1440).toISOString() }),
  ).toBe(idOf("WID-5"));
  expect(await attempt("WID-5", 15)).toEqual({ ok: true, attempt: 1 });
  const pinned = {
    ...request("WID-5"),
    profile: "backend",
    pinned: true,
    notes: "Updated context",
    reason: "Updated choice",
  };
  expect(await store.renewDeferredLaunch(pinned)).toBe(idOf("WID-5"));
  // Omission preservation happens on the locked database row, independently of an earlier CLI read.
  expect(await store.renewDeferredLaunch({ ...request("WID-5"), notes: null, runtime: null, reason: null })).toBe(
    idOf("WID-5"),
  );
  expect((await store.getInboxItem(project, idOf("WID-5")))?.request).toMatchObject({
    profile: "backend",
    pinned: true,
    runtime: "conductor",
    notes: "Updated context",
    reason: "Updated choice",
  });
  await db.query("UPDATE projects SET organization_id = $2 WHERE slug = $1", [project, "org-a"]);
  for (const [ticket, ended] of [
    ["WID-7", false],
    ["WID-8", true],
  ] as const) {
    await store.addRequest(request(ticket));
    const historical = await createLaunch(db, {
      organization: "org-a",
      project,
      ticket,
      coordinator: "old",
      launcher: { kind: "session", id: "person-a", label: "Demo coordinator" },
      now: at(0),
    });
    if (ended)
      await db.query('UPDATE "armada_worker" SET "endedAt" = $2 WHERE "id" = $1', [historical.worker.id, at(1)]);
    expect(await store.transferTickets({ project, tickets: [ticket], from: "front", to: "back", at: at(121) })).toBe(
      true,
    );
    expect((await store.openInboxItems({ project, recipient: "coordinator", ticket }))[0]?.coordinator).toBe("back");
    expect(
      (await db.query('SELECT "coordinator" FROM "armada_worker" WHERE "id" = $1', [historical.worker.id])).rows[0]
        ?.coordinator,
    ).toBe("old");
  }
  const concurrent = await Promise.all([attempt("WID-6", 0), attempt("WID-6", 0)]);
  expect(concurrent.filter((r) => r.ok)).toEqual([{ ok: true, attempt: 1 }]);
  expect(concurrent.filter((r) => !r.ok)).toEqual([{ ok: false, why: "request attempted too recently" }]);
  expect((await store.getInboxItem(project, idOf("WID-6")))?.request?.attempts).toBe(1);
});
