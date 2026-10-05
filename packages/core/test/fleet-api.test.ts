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
  test("release validates guards and always checks a worker caller's session identity", async () => {
    const { fleet, store } = tempFleet();
    await store.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-7",
      runtime: "Conductor",
      handle: "ws/new",
      branch: null,
      workerSessionId: "new",
      at: NOW,
    });
    for (const input of [{ claimedAt: "yesterday" }, { handle: 42 }]) {
      expect(
        (
          await serveFleet(
            store,
            {
              op: "release",
              project: DEMO_PROJECT,
              caller: { kind: "organization" },
              input: { ticket: "DEMO-7", reason: "late", ...input },
            },
            { now: () => NOW },
          )
        ).status,
      ).toBe(400);
    }
    const old = await serveFleet(
      store,
      {
        op: "release",
        project: DEMO_PROJECT,
        caller: { kind: "worker", ticket: "DEMO-7", sessionId: "old" },
        input: { ticket: "DEMO-7", reason: "late", workerSessionId: "new" },
      },
      { now: () => NOW },
    );
    expect(old.body.result).toEqual({ released: false });
    expect(await fleet.release({ ticket: "DEMO-7", reason: "late", handle: "ws/old" })).toEqual({ released: false });
    expect(store.events).toHaveLength(0);
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
    expect(
      await fleet.release({ ticket: "DEMO-7", reason: "done", handle: "ws/new", claimedAt: NOW.toISOString() }),
    ).toEqual({ released: true });
    expect(store.events).toHaveLength(1);
  });

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

  test("shipping detail crosses the API without changing the legacy timestamp response", async () => {
    const { fleet, store } = tempFleet();
    await fleet.report({
      ticket: "DEMO-7",
      phase: "shipping",
      previous: "implementing",
      shippingStage: "review",
      summary: "review",
      message: "review",
      prUrl: null,
      headSha: null,
    });
    expect((await fleet.latestEvents())["DEMO-7"]).toMatchObject({ phase: "shipping", shippingStage: "review" });
    expect(await fleet.lastEventTimes()).toEqual({ "DEMO-7": NOW.toISOString() });
    const before = store.events.length;
    for (const input of [
      { phase: "implementing", shippingStage: "review" },
      { phase: "shipping", shippingStage: "unknown" },
    ]) {
      const response = await serveFleet(
        store,
        {
          op: "report",
          project: DEMO_PROJECT,
          caller: { kind: "organization" },
          input: { ticket: "DEMO-7", summary: "x", ...input },
        },
        { now: () => NOW },
      );
      expect(response.status).toBe(400);
      expect(store.events.length).toBe(before);
    }
  });

  test("a repeated shipping report and same-session reclaim preserve explicit review; new work clears it", async () => {
    const clock = fakeClock(NOW);
    const { fleet, store } = tempFleet({ clock });
    await fleet.claim(claim("DEMO-7"));
    const report = {
      ticket: "DEMO-7",
      phase: "shipping" as const,
      previous: "shipping" as const,
      summary: "review",
      message: "review",
      prUrl: null,
      headSha: null,
    };
    clock.advance(1_000);
    await fleet.report({ ...report, shippingStage: "review" });
    clock.advance(1_000);
    await fleet.report(report);
    expect((await fleet.latestEvents())["DEMO-7"]?.shippingStage).toBe("review");
    clock.advance(1_000);
    await fleet.claim({ ...claim("DEMO-7"), phase: "shipping", resuming: true });
    expect((await fleet.latestEvents())["DEMO-7"]).toMatchObject({
      kind: "claim",
      phase: "shipping",
      shippingStage: "review",
    });
    clock.advance(1_000);
    await fleet.report({ ...report, phase: "implementing" });
    clock.advance(1_000);
    await fleet.report({ ...report, previous: "implementing" });
    expect((await fleet.latestEvents())["DEMO-7"]?.shippingStage).toBeNull();
    await fleet.report({ ...report, shippingStage: "review" });
    clock.advance(1_000);
    await fleet.claim({ ...claim("DEMO-7"), handle: "replacement", phase: "shipping", resuming: true });
    expect((await fleet.latestEvents())["DEMO-7"]?.shippingStage).toBeNull();
    await fleet.report({ ...report, shippingStage: "review" });
    clock.advance(1_000);
    // A new worker identity using the same runtime handle is a replacement too.
    const replaced = await serveFleet(
      store,
      {
        op: "claim",
        project: DEMO_PROJECT,
        caller: { kind: "worker", ticket: "DEMO-7", sessionId: "new-worker" },
        input: { ...claim("DEMO-7"), handle: "replacement", phase: "shipping", resuming: true },
      },
      { now: clock.now },
    );
    expect(replaced.status).toBe(200);
    expect((await fleet.latestEvents())["DEMO-7"]?.shippingStage).toBeNull();
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
