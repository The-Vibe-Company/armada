import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { fleetClient, parseProject, serveFleet } from "../src/fleet-api.ts";
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
  test("only a coordinator records validated Linear chores, scoped to its project and ticket", async () => {
    const { fleet, store } = tempFleet();
    const chore = { ticket: "DEMO-7", kind: "linear-pending" as const, pr: 11, body: "Finish Linear for #11" };
    await fleet.chore(chore);
    await fleet.chore({ ...chore, body: "Run: armada merge --finish 11" });
    expect(await fleet.ticketItems("DEMO-7")).toMatchObject([
      {
        project: "widgets",
        ticket: "DEMO-7",
        kind: "linear-pending",
        recipient: "coordinator",
        body: "Run: armada merge --finish 11",
      },
    ]);
    expect(store.items).toHaveLength(1);
    expect(
      (
        await serveFleet(
          store,
          { op: "chore", project: DEMO_PROJECT, caller: { kind: "worker", ticket: "DEMO-7" }, input: chore },
          { now: () => NOW },
        )
      ).status,
    ).toBe(403);
    for (const invalid of [{ kind: "question" }, { ticket: "wrong" }, { pr: 0 }, { pr: 1.5 }, { body: " " }]) {
      const answer = await serveFleet(
        store,
        { op: "chore", project: DEMO_PROJECT, caller: { kind: "organization" }, input: { ...chore, ...invalid } },
        { now: () => NOW },
      );
      expect(answer.status).toBe(400);
    }
    expect(store.items).toHaveLength(1);
    const other = await serveFleet(
      store,
      {
        op: "chore",
        project: { ...DEMO_PROJECT, slug: "other" },
        caller: { kind: "organization", author: "Synthetic Coordinator" },
        input: { ...chore, coordinatorName: "night" },
      },
      { now: () => NOW },
    );
    expect(other.status).toBe(200);
    expect(store.items).toHaveLength(2);
    expect(
      (await store.openInboxItems({ project: "other", ticket: "DEMO-7", recipient: "coordinator" }))[0]?.author,
    ).toBe("Synthetic Coordinator");
    expect((await store.openInboxItems({ project: "other", recipient: "coordinator" }))[0]?.coordinator).toBe("night");
    for (const name of ["night", "day"]) {
      const inbox = await serveFleet(
        store,
        {
          op: "inbox",
          project: { ...DEMO_PROJECT, slug: "other" },
          caller: { kind: "organization" },
          input: { coordinatorName: name, coordinator: null, silentAfterMinutes: 15, etag: null },
        },
        { now: () => NOW },
      );
      expect((inbox.body.result as import("../src/live.ts").InboxRead).items).toHaveLength(name === "night" ? 1 : 0);
    }
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

describe("named coordinators", () => {
  test("worker ownership is authenticated, legacy workers stay unowned, and resume preserves a handover", async () => {
    const store = memoryFleet();
    const run = (input: object, coordinator?: string | null) =>
      serveFleet(
        store,
        {
          op: "claim",
          project: DEMO_PROJECT,
          caller: { kind: "worker", ticket: "DEMO-7", sessionId: "session", coordinator },
          input: { ...claim("DEMO-7"), ...input },
        },
        { now: () => NOW },
      );
    expect((await run({ coordinator: "spoof", coordinatorName: "INVALID NAME" }, "front")).status).toBe(200);
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.coordinator).toBe("front");
    expect(
      await store.transferTickets({ project: "widgets", tickets: ["DEMO-7"], from: "front", to: "back", at: NOW }),
    ).toBe(true);
    await run({ resuming: true }, "front");
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.coordinator).toBe("back");
    expect((await store.listSessions("widgets", { since: NOW }))[0]?.coordinator).toBe("back");
    await run({ handle: "legacy", coordinator: "front", coordinatorName: "front" });
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.coordinator).toBeNull();
  });

  test("names validate before writes; an older organization claim belongs to default", async () => {
    const store = memoryFleet();
    for (const name of ["Front", "a_b", "", null, "a".repeat(33)]) {
      expect(
        (
          await serveFleet(
            store,
            {
              op: "claim",
              project: DEMO_PROJECT,
              caller: { kind: "organization" },
              input: { ...claim("DEMO-7"), coordinatorName: name },
            },
            { now: () => NOW },
          )
        ).status,
      ).toBe(400);
    }
    expect(store.events).toHaveLength(0);
    await serveFleet(
      store,
      { op: "claim", project: DEMO_PROJECT, caller: { kind: "organization" }, input: claim("DEMO-7") },
      { now: () => NOW },
    );
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.coordinator).toBe("default");
  });

  test("take refuses the whole batch on missing or stale owners, then records handover without changing phase", async () => {
    const store = memoryFleet();
    for (const ticket of ["DEMO-7", "DEMO-8"])
      await serveFleet(
        store,
        {
          op: "claim",
          project: DEMO_PROJECT,
          caller: { kind: "organization" },
          input: { ...claim(ticket), coordinatorName: "front" },
        },
        { now: () => NOW },
      );
    store.launches.push({
      project: "widgets",
      ticket: "DEMO-9",
      coordinator: "front",
      launchedAt: NOW.toISOString(),
      tokenUsedAt: null,
      runtime: null,
      handle: null,
      endedAt: null,
    });
    const take = (tickets: string[], from: string) =>
      serveFleet(
        store,
        {
          op: "coordinators/take",
          project: DEMO_PROJECT,
          caller: { kind: "organization" },
          input: { tickets, from, coordinatorName: "back" },
        },
        { now: () => new Date(NOW.getTime() + 1000) },
      );
    expect((await take(["DEMO-7", "DEMO-8"], "stale")).status).toBe(409);
    expect((await take(["DEMO-7", "DEMO-99"], "front")).status).toBe(409);
    expect((await store.getRuntimeHandle("widgets", "DEMO-7"))?.coordinator).toBe("front");
    expect((await take(["DEMO-7", "DEMO-8", "DEMO-9"], "front")).body.result).toBe(true);
    expect((await store.pendingLaunches("widgets", new Date(0)))[0]?.coordinator).toBe("back");
    expect(store.events.filter((event) => event.kind === "handover")).toHaveLength(3);
    expect((await store.latestEvents("widgets"))["DEMO-7"]).toMatchObject({ phase: "planning", kind: "claim" });
    expect((await store.lastEventTimes("widgets"))["DEMO-7"]).toBe(NOW.toISOString());
  });

  test("inbox filters owners with active null taking precedence, and retains unowned and legacy reads", async () => {
    const store = memoryFleet();
    for (const [ticket, coordinator] of [
      ["DEMO-7", "front"],
      ["DEMO-8", "back"],
      ["DEMO-9", null],
    ] as const) {
      await store.saveRuntimeHandle({
        project: "widgets",
        ticket,
        coordinator,
        runtime: "Conductor",
        handle: ticket,
        branch: null,
        at: NOW,
      });
      await store.addInboxItem({
        project: "widgets",
        ticket,
        coordinator: "back",
        kind: "question",
        recipient: "coordinator",
        author: ticket,
        body: "Question",
        at: NOW,
      });
    }
    store.launches.push({
      project: "widgets",
      ticket: "DEMO-10",
      coordinator: "front",
      launchedAt: NOW.toISOString(),
      tokenUsedAt: null,
      runtime: null,
      handle: null,
      endedAt: null,
    });
    await store.addInboxItem({
      project: "widgets",
      ticket: "DEMO-10",
      coordinator: "back",
      kind: "launch-request",
      recipient: "coordinator",
      author: null,
      body: "Launch",
      at: NOW,
    });
    await store.addInboxItem({
      project: "widgets",
      ticket: null,
      coordinator: "front",
      kind: "merge-request",
      recipient: "coordinator",
      author: null,
      body: "Merge",
      at: NOW,
    });
    const inbox = async (coordinatorName?: string) => {
      const answer = await serveFleet(
        store,
        {
          op: "inbox",
          project: DEMO_PROJECT,
          caller: { kind: "organization" },
          input: { coordinator: null, coordinatorName, silentAfterMinutes: 15, etag: null },
        },
        { now: () => NOW },
      );
      return answer.body.result as import("../src/live.ts").InboxRead;
    };
    const front = await inbox("front");
    expect(front.items.map((item) => [item.ticket, item.owner])).toEqual([
      ["DEMO-7", "front"],
      ["DEMO-9", null],
      ["DEMO-10", "front"],
      [null, null],
    ]);
    expect(front.inFlight).toEqual(["DEMO-10", "DEMO-7", "DEMO-9"]);
    expect((await inbox("back")).items.map((item) => item.ticket)).toEqual(["DEMO-8", "DEMO-9", null]);
    expect((await inbox()).items).toHaveLength(5);
  });

  test("expired launch notifications are scoped and named presence keeps distinct sessions", async () => {
    const store = memoryFleet();
    const old = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    for (const coordinator of ["front", "back"])
      store.launches.push({
        project: "widgets",
        ticket: coordinator === "front" ? "DEMO-7" : "DEMO-8",
        coordinator,
        launchedAt: old,
        tokenUsedAt: null,
        runtime: null,
        handle: null,
        endedAt: null,
      });
    const response = await serveFleet(
      store,
      {
        op: "inbox",
        project: DEMO_PROJECT,
        caller: { kind: "organization" },
        input: { coordinatorName: "front", coordinator: "session-1", silentAfterMinutes: 15, etag: null },
      },
      { now: () => NOW },
    );
    expect(
      (response.body.result as import("../src/live.ts").InboxRead).items.map((item) => [item.ticket, item.owner]),
    ).toEqual([["DEMO-7", "front"]]);
    expect(store.launches.find((launch) => launch.ticket === "DEMO-8")?.endedAt).toBeNull();
    await store.recordCoordinatorSeen({
      project: "widgets",
      name: "front",
      handle: "session-2",
      at: new Date(NOW.getTime() + 1000),
    });
    const roles = await store.listCoordinators("widgets");
    const front = roles.find((role) => role.name === "front");
    expect(front?.sessions.map((session) => session.handle)).toEqual(["session-2", "session-1"]);
  });
});

test("scoped event reads exclude other owners before pagination, include unowned events and validate scope", async () => {
  const store = memoryFleet();
  for (const [ticket, coordinator] of [
    ["DEMO-7", "default"],
    ["DEMO-8", "front"],
    ["DEMO-9", null],
  ] as const) {
    await store.saveRuntimeHandle({
      project: "widgets",
      ticket,
      coordinator,
      runtime: "conductor",
      handle: `ws/${ticket}`,
      branch: null,
      at: NOW,
    });
    await store.recordEvent({ project: "widgets", ticket, kind: "report", phase: "ready-to-merge", at: NOW });
  }
  const request = {
    op: "events/since",
    project: DEMO_PROJECT,
    caller: { kind: "organization" as const },
    input: {
      afterId: 0,
      afterAt: NOW.toISOString(),
      kinds: ["report"],
      coordinatorName: "front",
      scope: "mine",
      limit: 1,
    },
  };
  const first = await serveFleet(store, request, { now: () => NOW });
  const page = first.body.result as import("../src/live.ts").EventsRead;
  expect(page.events.map((event) => event.ticket)).toEqual(["DEMO-8"]);
  const next = await serveFleet(
    store,
    { ...request, input: { ...request.input, afterId: page.events[0]?.id } },
    { now: () => NOW },
  );
  expect((next.body.result as import("../src/live.ts").EventsRead).events.map((event) => event.ticket)).toEqual([
    "DEMO-9",
  ]);
  const all = await serveFleet(
    store,
    { ...request, input: { ...request.input, scope: "all", limit: 200 } },
    { now: () => NOW },
  );
  expect((all.body.result as import("../src/live.ts").EventsRead).events).toHaveLength(3);
  for (const op of ["events/since", "inbox"])
    expect(
      (
        await serveFleet(
          store,
          {
            ...request,
            op,
            input: { ...request.input, coordinator: null, etag: null, silentAfterMinutes: 15, scope: "invalid" },
          },
          { now: () => NOW },
        )
      ).status,
    ).toBe(400);
});

test("fleet client resolves the coordinator preference for each request", async () => {
  const requests: unknown[] = [];
  let name = "front";
  const fleet = fleetClient({
    project: DEMO_PROJECT,
    signIn: { kind: "api-key", key: "armada_key_TEST" },
    coordinatorName: async () => name,
    api: {
      fleet: async (_signIn, _op, body) => {
        requests.push((body as { input: object }).input);
        return [];
      },
    },
  });
  await fleet.runtimeHandles();
  name = "back";
  await fleet.coordinators();
  expect(requests).toEqual([{ coordinatorName: "front" }, { coordinatorName: "back" }]);
});

test("inbox ETag refreshes ownership when an unowned ticket is taken without changing visible entries", async () => {
  const store = memoryFleet();
  await store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-77",
    runtime: "conductor",
    handle: "workspace/worker",
    branch: null,
    at: NOW,
  });
  await store.addInboxItem({
    project: "widgets",
    ticket: "DEMO-77",
    kind: "question",
    recipient: "coordinator",
    author: null,
    body: "Which option?",
    at: NOW,
  });
  const read = async (etag: string | null) =>
    serveFleet(
      store,
      {
        op: "inbox",
        project: DEMO_PROJECT,
        caller: { kind: "organization" },
        input: { coordinatorName: "front", coordinator: null, silentAfterMinutes: 15, etag },
      },
      { now: () => NOW },
    );
  const before = (await read(null)).body.result as import("../src/live.ts").InboxRead;
  expect(before.items[0]?.owner).toBeNull();
  expect(await store.transferTickets({ project: "widgets", tickets: ["DEMO-77"], to: "front", at: NOW })).toBe(true);
  const after = await read(before.etag);
  expect(after.status).toBe(200);
  expect((after.body.result as import("../src/live.ts").InboxRead).items[0]?.owner).toBe("front");
});

test("queue operations round trip through Armada and remain coordinator-only", async () => {
  const { fleet, store } = tempFleet();
  const entry = {
    pr: 12,
    ticket: "DEMO-7",
    noTicket: false,
    keepOpen: true,
    throughHold: "Fix main",
    reason: "Reviewed",
    headSha: "a".repeat(40),
    queuedBy: "coordinator",
  };
  expect(await fleet.queueAdd(entry)).toEqual({ id: 1, position: 1 });
  expect(await fleet.queueAdd(entry)).toMatchObject({ existing: { id: 1, pr: 12 } });
  expect(await fleet.queueList()).toMatchObject([{ ...entry, state: "queued", queuedAt: NOW.toISOString() }]);
  expect(await fleet.queueNext({ holder: "a" })).toEqual({ refused: true, held: null });
  await fleet.acquireLease({ name: "merge-queue", holder: "a", ttlMs: 60_000 });
  expect(await fleet.queueNext({ holder: "a" })).toMatchObject({ entry: { id: 1, state: "merging" }, holds: [] });
  expect(
    await fleet.queueFinish({ id: 1, holder: "a", outcome: "retry", detail: "CI", notBefore: NOW.toISOString() }),
  ).toBe(true);
  expect(await fleet.queueNext({ holder: "a" })).toMatchObject({ entry: { attempts: 1 } });
  expect(
    await fleet.queueFinish({ id: 1, holder: "a", outcome: "merged", detail: null, mergeCommit: "b".repeat(40) }),
  ).toBe(true);
  expect(await fleet.queueList()).toMatchObject([{ state: "merged", mergeCommit: "b".repeat(40) }]);
  expect(await fleet.queueList({ since: new Date(NOW.getTime() + 1).toISOString() })).toEqual([]);
  await fleet.queueAdd(entry);
  expect(await fleet.queueRemove({ pr: 12 })).toBe(true);
  expect(await fleet.queueRemove({ pr: 12 })).toBe(false);
  const worker = tempFleet({ caller: { kind: "worker", ticket: "DEMO-7" } }).fleet;
  for (const operation of [
    () => worker.queueAdd(entry),
    () => worker.queueList(),
    () => worker.queueNext({ holder: "a" }),
    () => worker.queueFinish({ id: 1, holder: "a", outcome: "refused", detail: "bad" }),
    () => worker.queueRemove({ pr: 12 }),
  ])
    expect((await refused(operation()))[0]).toBe(403);
  for (const [op, input] of [
    ["queue/add", { ...entry, headSha: "abc1234" }],
    ["queue/add", { ...entry, noTicket: true }],
    ["queue/add", { ...entry, keepOpen: "yes" }],
    ["queue/list", { since: "yesterday" }],
    ["queue/next", { holder: "" }],
    ["queue/finish", { id: 1, holder: "a", outcome: "bad" }],
    ["queue/finish", { id: 1, holder: "a", outcome: "retry", notBefore: "later" }],
    ["queue/remove", { pr: -1 }],
    ["queue/remove", { pr: 2147483648 }],
  ] as const)
    expect(
      (
        await serveFleet(
          store,
          { op, project: DEMO_PROJECT, caller: { kind: "organization" }, input },
          { now: () => NOW },
        )
      ).status,
    ).toBe(400);
});

test("workers reserve, list project holders and unreserve only their own ticket; malformed allocations are refused", async () => {
  const { fleet, store } = tempFleet({ caller: { kind: "worker", ticket: "DEMO-7" } });
  await store.reserve({ project: "widgets", ticket: "DEMO-8", key: "db-migration", next: true, floor: 22, at: NOW });
  expect((await fleet.reserve({ ticket: "DEMO-7", key: "db-migration", next: true, floor: 22 })).reserved).toBe(true);
  expect((await fleet.reservations("DEMO-7")).map((r) => r.ticket)).toEqual(["DEMO-8", "DEMO-7"]);
  for (const op of ["reserve", "unreserve", "reservations"]) {
    const answer = await serveFleet(
      store,
      {
        op,
        project: DEMO_PROJECT,
        caller: { kind: "worker", ticket: "DEMO-7" },
        input: { ticket: "DEMO-8", key: "db-migration" },
      },
      { now: () => NOW },
    );
    expect(answer.status).toBe(403);
  }
  for (const input of [{ next: true, value: "23" }, { floor: 22 }, { next: true, floor: -1 }, { value: 42 }]) {
    const answer = await serveFleet(
      store,
      {
        op: "reserve",
        project: DEMO_PROJECT,
        caller: { kind: "worker", ticket: "DEMO-7" },
        input: { ticket: "DEMO-7", key: "db-migration", ...input },
      },
      { now: () => NOW },
    );
    expect(answer.status).toBe(400);
  }
  expect(await fleet.unreserve({ ticket: "DEMO-7", key: "db-migration" })).toBe(1);
  expect((await fleet.reservations("DEMO-7")).map((r) => r.ticket)).toEqual(["DEMO-8"]);
});

test("events/since is a scoped safe read with bounded pages, filters, look-back and 304", async () => {
  const live = tempFleet();
  const query = { afterId: 0, afterAt: NOW.toISOString(), kinds: ["report"] as const, tickets: ["DEMO-2"], limit: 2 };
  for (let i = 0; i < 3; i++)
    await live.store.recordEvent({
      project: "widgets",
      ticket: "DEMO-2",
      kind: "report",
      at: new Date(NOW.getTime() + 1000),
      message: `report ${i}`,
    });
  await live.store.recordEvent({
    project: "widgets",
    ticket: "DEMO-2",
    kind: "heartbeat",
    at: new Date(NOW.getTime() + 1000),
  });
  const first = await live.fleet.eventsSince(query);
  expect(first?.events.map((e) => e.id)).toEqual([1, 2]);
  const second = await live.fleet.eventsSince({
    ...query,
    afterId: 2,
    afterAt: new Date(NOW.getTime() + 1000).toISOString(),
  });
  expect(second?.events.map((e) => e.id)).toEqual([3]);
  expect(
    await live.fleet.eventsSince({
      ...query,
      afterId: 3,
      afterAt: new Date(NOW.getTime() + 1000).toISOString(),
      seenIds: [1, 2, 3],
    }),
  ).toBeNull();
  for (const bad of [
    { limit: 201 },
    { kinds: ["heartbeat"] },
    { afterAt: "yesterday" },
    { tickets: ["bad"] },
    { seenIds: [-1] },
  ]) {
    const answer = await serveFleet(
      live.store,
      { op: "events/since", project: DEMO_PROJECT, caller: { kind: "organization" }, input: { ...query, ...bad } },
      { now: () => NOW },
    );
    expect(answer.status).toBe(400);
  }
  const worker = tempFleet({ caller: { kind: "worker", ticket: "DEMO-2" } });
  expect((await refused(worker.fleet.eventsSince(query)))[0]).toBe(403);
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

test("hold API is organization-only, validates reasons and refs, and preserves the clearer", async () => {
  const { fleet, store } = tempFleet();
  for (const op of ["holds", "hold/open", "hold/clear"] as const) {
    const answer = await serveFleet(
      store,
      { op, project: DEMO_PROJECT, caller: { kind: "worker", ticket: "DEMO-7" }, input: {} },
      { now: () => NOW },
    );
    expect(answer.status).toBe(403);
  }
  for (const input of [
    { kind: "manual", reason: " " },
    { kind: "unknown", reason: "stop" },
    { kind: "deploy", reason: "broken" },
  ]) {
    expect(
      (
        await serveFleet(
          store,
          { op: "hold/open", project: DEMO_PROJECT, caller: { kind: "organization" }, input },
          { now: () => NOW },
        )
      ).status,
    ).toBe(400);
  }
  const hold = await fleet.openHold({ kind: "manual", reason: "pause for investigation" });
  const item = (await store.openInboxItems({ project: DEMO_PROJECT.slug, recipient: "coordinator" }))[0];
  if (!item) throw new Error("expected the hold inbox item");
  expect(await refused(fleet.resolve({ id: item.id, resolution: "dismiss" }))).toContain(400);
  expect(await refused(fleet.answer({ item: item.id, ticket: null, note: false, text: "dismiss" }))).toContain(400);
  expect(await fleet.holds()).toEqual([hold]);
  expect((await fleet.inbox({ silentAfterMinutes: 15, coordinator: null, etag: null }))?.items[0]?.kind).toBe("hold");
  const result = await fleet.clearHold({ id: hold.id, reason: "verified the fix" });
  expect(result?.cleared).toBe(true);
  expect((await fleet.clearHold({ id: hold.id, reason: "repeat" }))?.hold).toEqual(result?.hold);
  expect(await fleet.holds()).toEqual([]);
  expect((await fleet.inbox({ silentAfterMinutes: 15, coordinator: null, etag: null }))?.items).toEqual([]);
});

test("a coordinator whose CLI does not read holds cannot acquire or renew the merge lease", async () => {
  const { fleet } = tempFleet();
  const lease = { name: "merge", holder: "older-coordinator", ttlMs: 60_000 };
  expect(await fleet.acquireLease(lease)).toEqual({ acquired: true });
  const hold = await fleet.openHold({ kind: "manual", reason: "deploy broken" });
  for (const result of [
    await refused(fleet.renewLease(lease)),
    await refused(fleet.acquireLease({ ...lease, holder: "another-coordinator" })),
  ]) {
    expect(result).toContain(409);
    expect(String(result)).toContain(`hold #${hold.id}`);
    expect(String(result)).toContain("deploy broken");
  }
  expect(await fleet.renewLease({ ...lease, throughHold: "fixes deploy" })).toBe(true);
  expect(await fleet.acquireLease({ name: "another-operation", holder: "a", ttlMs: 60_000 })).toEqual({
    acquired: true,
  });
  expect(await refused(fleet.renewLease({ ...lease, throughHold: " " }))).toContain(400);
  await fleet.clearHold({ id: hold.id, reason: "recovered" });
  expect(await fleet.renewLease(lease)).toBe(true);
});
