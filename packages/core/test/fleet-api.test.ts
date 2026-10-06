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
  test("generated merge notes are resolved records and leave pending plans and questions open", async () => {
    const { fleet, store } = tempFleet();
    const plan = await store.addInboxItem({
      project: "widgets",
      ticket: "DEMO-7",
      kind: "plan",
      recipient: "coordinator",
      author: null,
      body: "Review this plan",
      at: NOW,
    });
    await fleet.ask({ ticket: "DEMO-7", body: "Which design?" });
    expect(await fleet.prepareMergeNotice("merge-9")).toBe("reserved");
    expect(await fleet.prepareMergeNotice("merge-9")).toBe("attempted");
    const note = {
      ticket: "DEMO-7",
      note: true,
      item: null,
      text: "main moved: PR #9",
      generated: true,
      deliveryKey: "merge-9",
    };
    await fleet.answer(note);
    await fleet.answer(note);
    expect(await fleet.prepareMergeNotice("merge-9")).toBe("delivered");
    expect((await store.getInboxItem("widgets", plan))?.resolvedAt).toBeNull();
    expect((await fleet.ticketItems("DEMO-7")).map((i) => i.kind)).toEqual(["plan", "question"]);
    expect(store.items.find((i) => i.kind === "note")?.resolvedAt).toBe(NOW.toISOString());
    expect(store.items.filter((i) => i.kind === "note")).toHaveLength(1);
  });
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
      () => fleet.prepareMergeNotice("merge-9"),
      () =>
        fleet.answer({
          text: "main moved",
          note: true,
          generated: true,
          deliveryKey: "merge-9",
          ticket: "DEMO-7",
          item: null,
        }),
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

test("a worker's declared paths appear in the plan with overlaps from the stored reading", async () => {
  const { issue } = await import("./support.ts");
  const store = memoryFleet();
  const repository = DEMO_PROJECT.repository;
  const pr = {
    number: 45,
    repo: repository,
    state: "open" as const,
    url: `https://github.com/${repository}/pull/45`,
    title: "Change the merge flow",
    files: [{ path: "packages/core/src/merge.ts", additions: 1, deletions: 0 }],
    filesComplete: false,
  };
  const issues = [
    issue("DEMO-1"),
    issue("DEMO-8", { parentId: "DEMO-1", statusType: "started", agentPhase: "implementing", prs: [pr] }),
  ];
  const snapshot = {
    repository,
    issues,
    prs: [pr],
    flight: {
      program: { rootId: "DEMO-1", fetchedAt: NOW.toISOString(), issues, comments: [], warnings: [] },
      forge: { repo: repository, prs: [pr], warnings: [], fetchedAt: NOW.toISOString() },
      after: NOW.toISOString(),
    },
  };
  await store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-8",
    runtime: "conductor",
    handle: "ws/other",
    branch: null,
    at: NOW,
  });
  await store.saveTicketPaths("widgets", "DEMO-8", ["skills/**"], NOW);
  const req = {
    op: "report",
    project: DEMO_PROJECT,
    caller: { kind: "worker" as const, ticket: "DEMO-7" },
    input: {
      ticket: "DEMO-7",
      phase: "awaiting-approval",
      previous: "planning",
      summary: "Plan",
      message: "Change the merge flow",
      paths: ["packages/core/src/merge.ts", "skills/worker.md"],
    },
  };
  const answer = await serveFleet(store, req, { now: () => NOW, snapshot });
  expect(answer.status).toBe(200);
  expect(answer.body.result).toMatchObject({
    overlaps: [
      { ticket: "DEMO-8", pr: 45, paths: ["packages/core/src/merge.ts", "skills/worker.md"], incomplete: true },
    ],
  });
  const plans = await store.openInboxItems({ project: "widgets", recipient: "coordinator" });
  expect(plans[0]?.body).toContain("Overlaps DEMO-8 (PR #45): packages/core/src/merge.ts, skills/worker.md");
  expect(plans[0]?.body).toContain("Comparison incomplete for DEMO-8 (PR #45)");
  expect(await store.ticketPaths("widgets")).toMatchObject({ "DEMO-7": req.input.paths });
  expect(
    (
      await serveFleet(
        store,
        { ...req, op: "overlap", input: { ticket: "DEMO-7", paths: [] } },
        { now: () => NOW, snapshot },
      )
    ).body.result,
  ).toMatchObject({ workers: [{ ticket: "DEMO-8", plan: ["skills/**"] }] });
  expect(
    (
      await serveFleet(
        store,
        { ...req, op: "overlap", input: { ticket: "DEMO-8", paths: [] } },
        { now: () => NOW, snapshot },
      )
    ).status,
  ).toBe(403);
  for (const paths of [
    ["../secret"],
    ["/absolute"],
    ["C:/windows"],
    ["a\\b"],
    ["a\nline"],
    ["a".repeat(201)],
    Array(51).fill("a"),
    "a",
  ]) {
    expect(
      (await serveFleet(store, { ...req, input: { ...req.input, paths } }, { now: () => NOW, snapshot })).status,
    ).toBe(400);
  }
});

test("merge cleanup keeps paths declared by a replacement claim when the generation guard refuses release", async () => {
  const { recordMerge } = await import("../src/live.ts");
  const store = memoryFleet();
  await store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-7",
    runtime: "conductor",
    handle: "ws/old",
    branch: null,
    at: NOW,
  });
  await store.saveTicketPaths("widgets", "DEMO-7", ["old/**"], NOW);
  const release = store.releaseRuntimeHandle.bind(store);
  store.releaseRuntimeHandle = async (project, ticket, at, guard) => {
    const later = new Date(at.getTime() + 1);
    await store.saveRuntimeHandle({ project, ticket, runtime: "conductor", handle: "ws/new", branch: null, at: later });
    await store.saveTicketPaths(project, ticket, ["new/**"], later);
    return release(project, ticket, at, guard);
  };
  const result = await recordMerge(
    store,
    "widgets",
    {
      ticket: "DEMO-7",
      number: 45,
      url: "https://github.com/acme/widgets/pull/45",
      headSha: "a".repeat(40),
      mergeCommit: "b".repeat(40),
    },
    NOW,
  );
  expect(result.handle).toBeNull();
  expect(await store.ticketPaths("widgets")).toEqual({ "DEMO-7": ["new/**"] });
  expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
});
