import { afterAll, beforeAll, expect, test } from "bun:test";
import { recordMerge, recordRelease } from "@armada/core/read";
import type { Database } from "../lib/db.ts";
import { fleetStore } from "../lib/fleet-store.ts";
import { tempDatabase } from "./support.ts";

let db: Database;
const at = new Date("2026-04-01T10:00:00Z");
beforeAll(async () => {
  db = await tempDatabase();
});
afterAll(() => db.end());

async function project(slug: string) {
  const store = fleetStore(db);
  await store.ensureProject({ slug, name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" }, at);
  return store;
}

test("simultaneous next allocations serialize an empty key; releases free values while merges keep them used", async () => {
  const projectId = "numbered";
  const store = await project(projectId);
  const allocate = (ticket: string) =>
    store.reserve({ project: projectId, ticket, key: "db-migration", next: true, floor: 22, at });
  const results = await Promise.all([allocate("WID-2"), allocate("WID-3")]);
  expect(results.map((r) => (r.reserved ? r.reservation.value : "conflict")).sort()).toEqual(["23", "24"]);
  const first = results.find((r) => r.reserved && r.reservation.value === "23");
  if (!first?.reserved) throw new Error("missing first reservation");
  await recordMerge(
    store,
    projectId,
    {
      ticket: first.reservation.ticket,
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      headSha: "a".repeat(40),
      mergeCommit: "b".repeat(40),
      decision: null,
    },
    at,
  );
  const conflict = await store.reserve({ project: projectId, ticket: "WID-4", key: "db-migration", value: "23", at });
  expect(conflict.reserved).toBe(false);
  if (conflict.reserved) throw new Error("merged value freed");
  expect(conflict.holder.merged).toBe(true);
  expect(await store.unreserve({ project: projectId, ticket: first.reservation.ticket, key: "db-migration", at })).toBe(
    0,
  );
  const second = results.find((r) => r.reserved && r.reservation.value === "24");
  if (!second?.reserved) throw new Error("missing second reservation");
  await recordRelease(store, projectId, { ticket: second.reservation.ticket, reason: "done", handle: null }, at);
  const reused = await allocate("WID-4");
  expect(reused.reserved && reused.reservation.value).toBe("24");
  expect((await store.reservations(projectId)).map((r) => [r.value, r.merged])).toEqual([
    ["23", true],
    ["24", false],
  ]);
});

test("exclusive keys and names name the holder, stay scoped to their project and only the holder can free them", async () => {
  const store = await project("names");
  await project("other-names");
  const first = await store.reserve({
    project: "names",
    ticket: "WID-2",
    key: "fixture",
    value: "sample",
    note: "demo data",
    at,
  });
  expect(first.reserved).toBe(true);
  const held = await store.reserve({ project: "names", ticket: "WID-3", key: "fixture", value: "sample", at });
  expect(!held.reserved && held.holder.ticket).toBe("WID-2");
  expect(
    (await store.reserve({ project: "other-names", ticket: "WID-3", key: "fixture", value: "sample", at })).reserved,
  ).toBe(true);
  expect(await store.unreserve({ project: "names", ticket: "WID-3", key: "fixture", at })).toBe(0);
  expect(await store.unreserve({ project: "names", ticket: "WID-2", key: "fixture", at })).toBe(1);
  expect(
    (await store.reserve({ project: "names", ticket: "WID-3", key: "fixture", value: "sample", at })).reserved,
  ).toBe(true);
  expect((await store.reserve({ project: "names", ticket: "WID-2", key: "release", at })).reserved).toBe(true);
  expect((await store.reserve({ project: "names", ticket: "WID-3", key: "release", at })).reserved).toBe(false);
  await store.saveRuntimeHandle({
    project: "names",
    ticket: "WID-2",
    runtime: "Conductor",
    handle: "new",
    branch: null,
    at,
  });
  expect(await recordRelease(store, "names", { ticket: "WID-2", handle: "old", reason: "stale" }, at)).toEqual({
    released: false,
  });
  expect((await store.reservations("names")).some((r) => r.key === "release")).toBe(true);
});

test("number allocation counts explicit integer formats, ignores names and keeps large integers precise", async () => {
  const store = await project("formats");
  for (const value of ["sample", "", "00023", "+24", "-25"])
    await store.reserve({ project: "formats", ticket: "WID-2", key: "port", value, at });
  const first = await store.reserve({ project: "formats", ticket: "WID-3", key: "port", next: true, at });
  expect(first.reserved && first.reservation.value).toBe("25");
  await store.reserve({ project: "formats", ticket: "WID-2", key: "port", value: "9007199254740993", at });
  const large = await store.reserve({ project: "formats", ticket: "WID-3", key: "port", next: true, at });
  expect(large.reserved && large.reservation.value).toBe("9007199254740994");
});

test("release frees and merge retains reservations even when the optional live claim write was missing", async () => {
  const store = await project("missing-claim");
  await store.reserve({ project: "missing-claim", ticket: "WID-2", key: "fixture", value: "sample", at });
  expect(
    await recordRelease(
      store,
      "missing-claim",
      { ticket: "WID-2", handle: "ws/session", workerSessionId: "worker", reason: "finished" },
      at,
    ),
  ).toEqual({ released: true });
  expect(await store.reservations("missing-claim")).toEqual([]);
  await store.reserve({ project: "missing-claim", ticket: "WID-3", key: "fixture", value: "sample", at });
  await recordMerge(
    store,
    "missing-claim",
    {
      ticket: "WID-3",
      number: 3,
      url: "https://github.com/acme/widgets/pull/3",
      mergeCommit: "merged",
      headSha: "head",
    },
    at,
  );
  expect(await store.reservations("missing-claim")).toEqual([
    expect.objectContaining({ ticket: "WID-3", value: "sample", merged: true, endedAt: at.toISOString() }),
  ]);
});

test("a claim arriving after an absent merge snapshot keeps its runtime, profile and reservations", async () => {
  const store = await project("merge-replacement");
  const claimed = new Date(at.getTime() + 1);
  const result = await recordMerge(
    {
      ...store,
      recordEvent: async (event) => {
        await store.recordEvent(event);
        await store.saveRuntimeHandle({
          project: "merge-replacement",
          ticket: "WID-2",
          runtime: "Conductor",
          handle: "new/session",
          branch: null,
          workerSessionId: "new-worker",
          at: claimed,
        });
        await store.saveWorkerProfile({
          project: "merge-replacement",
          ticket: "WID-2",
          at: claimed,
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
        });
        await store.reserve({
          project: "merge-replacement",
          ticket: "WID-2",
          key: "fixture",
          value: "new",
          at: claimed,
        });
      },
    },
    "merge-replacement",
    {
      ticket: "WID-2",
      number: 3,
      url: "https://github.com/acme/widgets/pull/3",
      mergeCommit: "merged",
      headSha: "head",
    },
    new Date(at.getTime() + 2),
  );
  expect(result.handle).toBeNull();
  expect(result.open).toEqual([expect.objectContaining({ handle: "new/session", releasedAt: null })]);
  expect((await store.getWorkerProfile("merge-replacement", "WID-2"))?.name).toBe("test");
  expect(await store.reservations("merge-replacement")).toEqual([
    expect.objectContaining({ ticket: "WID-2", value: "new", merged: false, endedAt: null }),
  ]);
});
