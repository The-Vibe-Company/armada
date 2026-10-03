import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { serveFleet } from "../src/fleet-api.ts";
import { heartbeatLoop } from "../src/heartbeat.ts";
import { readInbox, recordClaim, recordRelease } from "../src/live.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_PROJECT, fakeClock, NOW } from "./support.ts";

const claim = {
  ticket: "DEMO-7",
  runtime: "Conductor",
  handle: "workspace/session",
  branch: null,
  phase: "implementing",
  resuming: false,
  profile: null,
  workerSessionId: "worker-one",
};

describe("worker heartbeats", () => {
  test("the API uses server time and current worker identity, rejects other tickets and stale claims", async () => {
    const store = memoryFleet();
    await recordClaim(store, "widgets", claim, NOW);
    const now = new Date(NOW.getTime() + 5 * 60_000);
    const request = {
      project: DEMO_PROJECT,
      op: "heartbeat",
      caller: { kind: "worker" as const, ticket: claim.ticket, sessionId: "worker-one" },
      input: { ticket: claim.ticket, handle: claim.handle, at: "2099-01-01T00:00:00Z" },
    };
    expect((await serveFleet(store, request, { now: () => now })).body.result).toEqual({
      active: true,
      phase: "implementing",
      agent: null,
      claimedAt: NOW.toISOString(),
    });
    expect((await store.getRuntimeHandle("widgets", claim.ticket))?.lastHeartbeatAt).toBe(now.toISOString());
    expect(
      (await serveFleet(store, { ...request, input: { ...request.input, ticket: "DEMO-8" } }, { now: () => now }))
        .status,
    ).toBe(403);
    expect(
      (
        await serveFleet(
          store,
          { ...request, caller: { ...request.caller, sessionId: "other-worker" } },
          { now: () => now },
        )
      ).body.result,
    ).toEqual({ active: false, claimedAt: null });
    await recordRelease(store, "widgets", { ticket: claim.ticket, reason: "replace" }, now);
    await recordClaim(store, "widgets", claim, new Date(now.getTime() + 1));
    expect(
      (
        await serveFleet(
          store,
          { ...request, input: { ...request.input, claimedAt: NOW.toISOString() } },
          { now: () => now },
        )
      ).body.result,
    ).toEqual({ active: false, claimedAt: null });
    expect(store.events.filter((event) => event.kind === "heartbeat")).toHaveLength(1);
  });
  test("pings immediately and on schedule, pins the claim, and stops with its parent", async () => {
    const clock = fakeClock(NOW);
    const calls: { at: number; claimedAt?: string | null }[] = [];
    const result = await heartbeatLoop({
      ticket: claim.ticket,
      handle: claim.handle,
      everyMs: 5 * 60_000,
      now: clock.now,
      sleep: clock.sleep,
      parentAlive: () => clock.now().getTime() < NOW.getTime() + 11 * 60_000,
      ping: async (input) => {
        calls.push({ at: clock.now().getTime() - NOW.getTime(), claimedAt: input.claimedAt });
        return { active: true, claimedAt: NOW.toISOString() };
      },
    });
    expect(result).toBe("parent-exited");
    expect(calls).toEqual([
      { at: 0, claimedAt: null },
      { at: 300_000, claimedAt: NOW.toISOString() },
      { at: 600_000, claimedAt: NOW.toISOString() },
    ]);
  });

  test("stops on session end or auth refusal; transient failure retries without losing the pinned claim", async () => {
    for (const ending of ["released", "merged", "revoked"] as const) {
      const clock = fakeClock(NOW);
      let calls = 0;
      const result = await heartbeatLoop({
        ticket: claim.ticket,
        handle: claim.handle,
        everyMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
        parentAlive: () => true,
        ping: async () => {
          calls++;
          if (calls === 2) throw new ArmadaApiError("unreachable");
          if (calls === 3) {
            if (ending === "revoked") throw new ArmadaApiError("revoked", null, true, 401);
            return { active: false, claimedAt: null };
          }
          return { active: true, claimedAt: NOW.toISOString() };
        },
      });
      expect(result).toBe("session-ended");
      expect(calls).toBe(3);
    }
  });

  test("server liveness does not change reports, phases or inbox items; silent and quiet are distinct", async () => {
    const store = memoryFleet();
    await recordClaim(store, "widgets", claim, NOW);
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const query = (minutes: number) =>
      readInbox(store, { project: "widgets", now: at(minutes), silentAfterMinutes: 15, quietAfterMinutes: 45 });
    expect((await query(16)).map((item) => item.kind)).toEqual(["silent"]);
    expect(
      await store.recordHeartbeat({
        project: "widgets",
        ticket: claim.ticket,
        handle: claim.handle,
        workerSessionId: "worker-one",
        at: at(45),
      }),
    ).toEqual({ active: true, claimedAt: NOW.toISOString() });
    expect(await query(45)).toEqual([]);
    expect((await query(50)).map((item) => [item.kind, item.body])).toEqual([
      ["quiet", "DEMO-7 has been working 50 min without a report (heartbeats are arriving, phase implementing)"],
    ]);
    expect((await query(61)).map((item) => item.kind)).toEqual(["silent"]);
    expect((await store.latestEvents("widgets"))[claim.ticket]?.kind).toBe("claim");
    expect(await store.lastEventTimes("widgets")).toEqual({ "DEMO-7": NOW.toISOString() });
    expect(store.items).toEqual([]);
    await recordRelease(store, "widgets", { ticket: claim.ticket, reason: "done" }, at(62));
    expect(
      await store.recordHeartbeat({
        project: "widgets",
        ticket: claim.ticket,
        handle: claim.handle,
        workerSessionId: "worker-one",
        at: at(63),
      }),
    ).toEqual({ active: false, claimedAt: null });
  });

  test("quiet respects configured thresholds and suppresses human-waiting phases without resolving anything", async () => {
    const store = memoryFleet();
    await recordClaim(store, "widgets", { ...claim, phase: "awaiting-approval" }, NOW);
    const later = new Date(NOW.getTime() + 50 * 60_000);
    await store.putPlan({ project: "widgets", ticket: claim.ticket, author: claim.handle, body: "the plan", at: NOW });
    await store.recordHeartbeat({
      project: "widgets",
      ticket: claim.ticket,
      handle: claim.handle,
      workerSessionId: "worker-one",
      at: later,
    });
    const query = { project: "widgets", now: later, silentAfterMinutes: 2, quietAfterMinutes: 5 };
    expect((await readInbox(store, query)).map((item) => item.kind)).toEqual(["plan"]);
    await store.recordEvent({
      project: "widgets",
      ticket: claim.ticket,
      kind: "report",
      phase: "implementing",
      at: NOW,
    });
    expect((await readInbox(store, query)).map((item) => item.kind).sort()).toEqual(["plan", "quiet"]);
    expect((await readInbox(store, { ...query, quietAfterMinutes: 60 })).map((item) => item.kind)).toEqual(["plan"]);
    expect((await readInbox(store, { ...query, coordinator: claim.handle })).map((item) => item.kind)).toEqual([
      "plan",
    ]);
  });
});
