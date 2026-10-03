import { expect, test } from "bun:test";
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
