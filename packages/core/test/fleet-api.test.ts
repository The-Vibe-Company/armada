import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { parseProject, serveFleet } from "../src/fleet-api.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_PROJECT, fakeClock, NOW, tempFleet } from "./support.ts";

const refused = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => {
      if (!(err instanceof ArmadaApiError)) throw err;
      return [err.status, err.message, err.next];
    },
  );

const claim = (ticket: string) => ({
  ticket,
  runtime: "Conductor",
  handle: "ws-1/s-1",
  branch: null,
  phase: "planning" as const,
  resuming: false,
  profile: null,
});

describe("the fleet through Armada", () => {
  test("a worker session claims, reports, asks, validates and releases its own ticket, and nothing else", async () => {
    const { fleet, store } = tempFleet({ caller: { kind: "worker", ticket: "DEMO-7" } });
    expect(await fleet.claim(claim("DEMO-7"))).toEqual([]);
    expect(await fleet.ask({ ticket: "DEMO-7", body: "Which store?" })).toBe(1);

    const scope = "a worker session only claims, reports, asks, validates and releases its own ticket (DEMO-7)";
    expect(await refused(fleet.claim(claim("DEMO-8")))).toEqual([
      403,
      `Armada refused: ${scope}, not DEMO-8`,
      "the coordinator does it",
    ]);
    for (const call of [
      () => fleet.inbox({ coordinator: null, silentAfterMinutes: 15, etag: null }),
      () => fleet.inboxItem(1),
      () => fleet.pendingLaunches(),
      () => fleet.answer({ text: "yes", note: false, ticket: "DEMO-7", item: 1 }),
      () => fleet.acquireLease({ name: "merge", holder: "w", ttlMs: 60_000 }),
      () => fleet.register(),
    ])
      expect((await refused(call()))[0]).toBe(403);
    expect((await store.getInboxItem("widgets", 1))?.resolvedAt).toBeNull();
    await fleet.release({ ticket: "DEMO-7", reason: "done" });
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
  });

  test("times are the server's, whatever the terminal's clock says", async () => {
    const clock = fakeClock(new Date("2026-03-04T12:00:00.000Z"));
    const { fleet, store } = tempFleet({ clock });
    await fleet.claim(claim("DEMO-7"));
    expect(await store.lastEventTimes("widgets")).toEqual({ "DEMO-7": "2026-03-04T12:00:00.000Z" });
  });

  test("a malformed request is refused, and nothing is written", async () => {
    const store = memoryFleet();
    const deps = { now: () => NOW, sleep: async () => {} };
    const run = (op: string, input: unknown) =>
      serveFleet(store, { op, project: DEMO_PROJECT, caller: { kind: "organization" }, input }, deps);
    expect((await run("claim", { ...claim("not a ticket") })).body).toEqual({
      error: "fleet claim: ticket must be a ticket id such as ABC-12",
      next: "update the CLI: npm install -g @the-vibe-company/armada",
    });
    expect((await run("report", { ticket: "DEMO-7", phase: "dreaming", summary: "x" })).status).toBe(400);
    expect((await run("merge", { ticket: "DEMO-7", number: 9, url: "u", headSha: "not-a-sha" })).status).toBe(400);
    expect((await run("inbox", { silentAfterMinutes: 15, notStartedMinutes: "ten" })).status).toBe(400);
    expect((await run("unknown", {})).status).toBe(404);
    expect(store.events).toEqual([]);
    expect(parseProject({ ...DEMO_PROJECT, slug: "Not A Slug" })).toBeNull();
    expect(parseProject({ ...DEMO_PROJECT, repository: "no-owner" })).toBeNull();
    expect(parseProject({ ...DEMO_PROJECT, programRoot: "demo-1" })).toEqual({
      ...DEMO_PROJECT,
      programRoot: "DEMO-1",
    });
  });
});
