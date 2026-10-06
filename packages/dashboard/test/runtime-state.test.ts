import { expect, test } from "bun:test";
import { serveFleet } from "@armada/core/read";
import { fleetStore } from "../lib/fleet-store.ts";
import { tempDatabase } from "./support.ts";

const at = (minutes: number) => new Date(Date.parse("2026-03-04T10:00:00Z") + minutes * 60_000);

test("runtime readings and stop are scoped to an exact claim, preserve transitions, and reset on replacement", async () => {
  const db = await tempDatabase();
  try {
    const store = fleetStore(db);
    await store.ensureProject(
      { slug: "synthetic", name: "Synthetic fleet", repository: "acme/synthetic", programRoot: "SYN-1" },
      at(0),
    );
    const claim = {
      project: "synthetic",
      ticket: "SYN-2",
      runtime: "Herdr",
      handle: "pane-one",
      branch: "feature/syn-2",
      at: at(0),
    };
    await store.saveRuntimeHandle(claim);
    const input = { ...claim, claimedAt: at(0).toISOString(), state: "blocked" as const, sequence: 4, at: at(1) };
    expect(await store.observeRuntime(input)).toBe(true);
    expect(await store.observeRuntime({ ...input, project: "another-project" })).toBe(false);
    expect(await store.observeRuntime({ ...input, claimedAt: at(-1).toISOString() })).toBe(false);
    await store.observeRuntime({ ...input, at: at(2) });
    expect(await store.observeRuntime({ ...input, state: "working", at: at(1) })).toBe(false);
    expect((await store.getRuntimeHandle(claim.project, claim.ticket))?.runtimeState).toEqual({
      state: "blocked",
      sequence: 4,
      at: at(2).toISOString(),
      since: at(1).toISOString(),
    });
    await store.observeRuntime({ ...input, sequence: 6, at: at(2.5) });
    expect((await store.getRuntimeHandle(claim.project, claim.ticket))?.runtimeState).toEqual({
      state: "blocked",
      sequence: 6,
      at: at(2.5).toISOString(),
      since: at(2.5).toISOString(),
    });
    await store.saveRuntimeHandle({ ...claim, at: at(3) });
    expect((await store.getRuntimeHandle(claim.project, claim.ticket))?.runtimeState?.since).toBe(
      at(2.5).toISOString(),
    );
    await store.releaseRuntimeHandle(claim.project, claim.ticket, at(4));
    expect(await store.observeRuntime({ ...input, at: at(4) })).toBe(false);
    expect(await store.stopRuntime({ ...input, at: at(5) })).toBe(true);
    expect((await store.getRuntimeHandle(claim.project, claim.ticket))?.releasedAt).toBe(at(4).toISOString());
    await store.saveRuntimeHandle({ ...claim, at: at(6) });
    expect((await store.getRuntimeHandle(claim.project, claim.ticket))?.runtimeState).toBeUndefined();
    expect(await store.stopRuntime({ ...input, at: at(7) })).toBe(false);
    expect((await store.openRuntimeHandles(claim.project)).length).toBe(1);
    expect(await store.stopRuntime({ ...input, claimedAt: at(6).toISOString(), at: at(8) })).toBe(true);
    expect(await store.openRuntimeHandles(claim.project)).toEqual([]);
    expect((await store.listSessions(claim.project, { since: at(0) })).map((s) => s.releasedAt).sort()).toEqual([
      at(4).toISOString(),
      at(8).toISOString(),
    ]);
  } finally {
    await db.end();
  }
});

test("Conductor observations and archive records cross the fleet API on Postgres with exact generation checks", async () => {
  const db = await tempDatabase();
  try {
    const store = fleetStore(db);
    const project = { slug: "synthetic", name: "Synthetic fleet", repository: "acme/synthetic", programRoot: "SYN-1" };
    const claim = {
      project: project.slug,
      ticket: "SYN-2",
      runtime: "Conductor",
      handle: "ws-1/ses-1",
      branch: "feature/syn-2",
      at: at(0),
    };
    await store.ensureProject(project, at(0));
    await store.saveRuntimeHandle(claim);
    const input = { ticket: claim.ticket, handle: claim.handle, claimedAt: at(0).toISOString() };
    const call = (op: "runtime/observe" | "runtime/stop", body: Record<string, unknown>, now = at(2)) =>
      serveFleet(store, { op, project, caller: { kind: "organization" }, input: body }, { now: () => now });
    expect((await call("runtime/observe", { ...input, state: "failed", since: at(1).toISOString() })).status).toBe(200);
    expect((await store.getRuntimeHandle(project.slug, claim.ticket))?.runtimeState).toEqual({
      state: "failed",
      at: at(2).toISOString(),
      since: at(1).toISOString(),
    });
    expect((await call("runtime/observe", { ...input, state: "unrecognized" })).status).toBe(400);
    expect((await call("runtime/observe", { ...input, state: "idle", since: at(3).toISOString() })).status).toBe(400);
    await store.releaseRuntimeHandle(project.slug, claim.ticket, at(3));
    expect((await call("runtime/observe", { ...input, state: "gone" }, at(3))).body).toEqual({ result: true });
    expect((await store.getRuntimeHandle(project.slug, claim.ticket))?.runtimeState?.state).toBe("gone");
    await store.saveRuntimeHandle({ ...claim, at: at(4) });
    expect((await call("runtime/observe", { ...input, state: "gone" }, at(5))).body).toEqual({ result: false });
    expect(await store.stopRuntime({ ...claim, claimedAt: input.claimedAt, at: at(5) })).toBe(false);
    expect((await store.getRuntimeHandle(project.slug, claim.ticket))?.releasedAt).toBeNull();
    await store.addInboxItem({
      project: project.slug,
      ticket: claim.ticket,
      kind: "question",
      recipient: "coordinator",
      author: claim.handle,
      body: "Resume?",
      at: at(4.5),
    });
    await store.resolveInboxItems({
      project: project.slug,
      ticket: claim.ticket,
      kind: "question",
      resolution: "Resume",
      at: at(4.75),
    });
    expect((await store.openRuntimeHandles(project.slug))[0]?.lastAnsweredAt).toBe(at(4.75).toISOString());
    expect((await store.getRuntimeHandle(project.slug, claim.ticket))?.lastAnsweredAt).toBe(at(4.75).toISOString());
    const current = { ...input, claimedAt: at(4).toISOString() };
    expect((await call("runtime/observe", { ...current, state: "gone" }, at(5))).status).toBe(200);
    expect((await store.getRuntimeHandle(project.slug, claim.ticket))?.runtimeState?.state).toBe("gone");
    expect((await call("runtime/stop", current, at(6))).status).toBe(200);
    expect((await store.getRuntimeHandle(project.slug, claim.ticket))?.releasedAt).toBe(at(6).toISOString());
    expect((await store.listSessions(project.slug, { since: at(4) }))[0]?.releasedAt).toBe(at(6).toISOString());
    expect((await store.latestEvents(project.slug))[claim.ticket]).toMatchObject({
      kind: "release",
      phase: "released",
      at: at(6).toISOString(),
    });
    expect((await call("runtime/stop", current, at(7))).status).toBe(200);
    expect((await store.latestEvents(project.slug))[claim.ticket]?.at).toBe(at(6).toISOString());
  } finally {
    await db.end();
  }
});
