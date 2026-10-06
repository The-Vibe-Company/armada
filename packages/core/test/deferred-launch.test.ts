import { expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { serveFleet } from "../src/fleet-api.ts";
import { type HandBackSnapshot, readInbox, recordClaim, serveInbox } from "../src/live.ts";
import { requestDeferredLaunch } from "../src/requests.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_PROJECT, DEMO_TOML, issue, NOW } from "./support.ts";

const config = parseConfig(`${DEMO_TOML}
[conductor.profiles.codex]
agent = "codex"
model = "gpt-6"
effort = "high"
`);
const snapshot = (): HandBackSnapshot => {
  const issues = [
    issue("DEMO-1", { parentId: null }),
    issue("DEMO-7", { parentId: "DEMO-1" }),
    issue("DEMO-9", {
      parentId: "DEMO-1",
      labels: [config.tracker.readyLabel],
      blockedBy: [{ id: "DEMO-7", statusType: "unstarted" }],
    }),
  ];
  return {
    repository: DEMO_PROJECT.repository,
    issues,
    prs: [],
    parkedLabel: config.tracker.parkedLabel,
    flight: {
      program: { rootId: "DEMO-1", issues, comments: [], fetchedAt: NOW.toISOString(), warnings: [] },
      forge: null,
      after: NOW.toISOString(),
    },
  };
};

test("deferred launches wait for every blocker in the stored reading, wake with a stable id and clear on claim", async () => {
  const store = memoryFleet();
  const reading = snapshot();
  const program = reading.flight?.program;
  if (!program) throw new Error("missing program");
  program.issues.push(issue("DEMO-8", { parentId: "DEMO-1" }));
  const ticket = program.issues.find((i) => i.id === "DEMO-9");
  if (!ticket) throw new Error("missing ticket");
  ticket.blockedBy.push({ id: "DEMO-8", statusType: "unstarted" });
  const { id } = await requestDeferredLaunch(store, {
    config,
    snapshot: reading,
    ticket: "DEMO-9",
    profile: "codex",
    author: "Ada",
    now: NOW,
  });
  const options = { project: "widgets", now: NOW, silentAfterMinutes: 15 };
  expect(await readInbox(store, options)).toEqual([]);
  const query = { coordinator: null, silentAfterMinutes: 15, etag: null };
  const hidden = await serveInbox(store, "widgets", query, NOW);
  expect(hidden?.inFlight).toContain("DEMO-9");
  expect(hidden?.items).toEqual([]);
  expect(await readInbox(store, { ...options, snapshot: { ...reading, flight: undefined } })).toEqual([]);
  expect(await readInbox(store, { ...options, snapshot: reading })).toEqual([]);
  const first = program.issues.find((i) => i.id === "DEMO-7");
  const second = program.issues.find((i) => i.id === "DEMO-8");
  if (!first || !second) throw new Error("missing blockers");
  first.statusType = "completed";
  expect(await readInbox(store, { ...options, snapshot: reading })).toEqual([]);
  second.statusType = "canceled";
  ticket.labels.push(config.tracker.parkedLabel);
  expect(await readInbox(store, { ...options, snapshot: reading })).toEqual([]);
  ticket.labels.pop();
  const awakened = await serveInbox(store, "widgets", { ...query, etag: hidden?.etag ?? null }, NOW, null, reading);
  expect(awakened?.items).toMatchObject([{ id }]);
  expect(awakened?.etag).not.toBe(hidden?.etag);
  const awake = await readInbox(store, { ...options, snapshot: reading });
  expect(awake).toMatchObject([
    { id, kind: "launch-request", ticket: "DEMO-9", request: { deferred: true, profile: "codex" } },
  ]);
  expect(awake[0]?.body).toContain("DEMO-9 is unblocked (DEMO-7, DEMO-8 done): launch it now: armada launch DEMO-9");
  await recordClaim(
    store,
    "widgets",
    {
      ticket: "DEMO-9",
      runtime: "Conductor",
      handle: "ws/9",
      branch: null,
      phase: null,
      resuming: false,
      profile: null,
    },
    NOW,
  );
  expect(await readInbox(store, { ...options, snapshot: reading })).toEqual([]);
});

test("deferred requests refuse unblocked tickets with an ordinary launch command, missing readings and false --after assertions", async () => {
  const store = memoryFleet();
  const reading = snapshot();
  const input = { config, snapshot: reading, ticket: "DEMO-9", profile: null, author: "Ada", now: NOW };
  await expect(requestDeferredLaunch(store, { ...input, after: "DEMO-8" })).rejects.toThrow("DEMO-8 is not a blocker");
  await expect(requestDeferredLaunch(store, { ...input, snapshot: undefined })).rejects.toThrow("stored reading");
  const blocker = reading.flight?.program.issues.find((i) => i.id === "DEMO-7");
  if (!blocker) throw new Error("missing blocker");
  blocker.statusType = "completed";
  await expect(requestDeferredLaunch(store, input)).rejects.toThrow("armada launch DEMO-9");
  expect(store.items).toEqual([]);
});

test("fleet checks deferred requests against server facts and reports ownership without accepting a supplied author", async () => {
  const store = memoryFleet();
  const deps = { now: () => NOW, config, snapshot: snapshot() };
  const call = (op: string, author: string, input: unknown = {}) =>
    serveFleet(store, { op, project: DEMO_PROJECT, caller: { kind: "organization", author }, input }, deps);
  expect(
    (
      await call("request", "Ada [user:synthetic-1]", {
        kind: "launch-when-unblocked",
        ticket: "DEMO-9",
        profile: "codex",
        author: "Other",
        coordinatorName: "front",
      })
    ).status,
  ).toBe(200);
  expect(store.items[0]?.coordinator).toBe("front");
  expect((await call("launch-requests", "Ada [user:synthetic-1]", { coordinatorName: "backend" })).body.result).toEqual(
    [],
  );
  expect(
    (await call("launch-requests", "Ada [user:synthetic-1]", { coordinatorName: "front" })).body.result,
  ).toMatchObject([{ owned: true }]);
  expect((await call("launch-requests", "Renamed [user:synthetic-1]")).body.result).toMatchObject([
    { owned: true, blockers: ["DEMO-7"], author: "Ada [user:synthetic-1]" },
  ]);
  expect((await call("launch-requests", "Ada [user:synthetic-2]")).body.result).toMatchObject([{ owned: false }]);
  store.items[0]!.author = "Old key [api-key:synthetic-1]";
  expect((await call("launch-requests", "New key [api-key:synthetic-1]")).body.result).toMatchObject([{ owned: true }]);
  expect((await call("launch-requests", "Old key [user:synthetic-1]")).body.result).toMatchObject([{ owned: false }]);
  expect(
    (
      await serveFleet(
        store,
        {
          op: "request",
          project: DEMO_PROJECT,
          caller: { kind: "worker", ticket: "DEMO-9" },
          input: { kind: "launch-when-unblocked", ticket: "DEMO-9" },
        },
        deps,
      )
    ).status,
  ).toBe(403);
});

test("deferred requests refuse held work and the inbox withholds it after blockers close", async () => {
  for (const heldBy of ["label", "report", "pr"] as const) {
    const store = memoryFleet();
    const reading = snapshot();
    const ticket = reading.flight?.program.issues.find((i) => i.id === "DEMO-9");
    if (!ticket) throw new Error("missing ticket");
    const input = { config, snapshot: reading, ticket: ticket.id, profile: null, author: "Ada", now: NOW };
    await requestDeferredLaunch(store, input);
    if (heldBy === "label") ticket.agentPhase = "planning";
    if (heldBy === "report")
      await store.recordEvent({
        project: "widgets",
        ticket: ticket.id,
        kind: "report",
        phase: "planning",
        message: null,
        at: new Date(NOW.getTime() + 1),
      });
    if (heldBy === "pr") ticket.prs.push({ number: 9, state: "open" } as (typeof ticket.prs)[number]);
    await expect(requestDeferredLaunch(store, input)).rejects.toThrow("already in flight");
    const blocker = reading.issues.find((i) => i.id === "DEMO-7");
    if (!blocker) throw new Error("missing blocker");
    blocker.statusType = "completed";
    expect(
      (await readInbox(store, { project: "widgets", now: NOW, silentAfterMinutes: 15, snapshot: reading })).some(
        (i) => i.kind === "launch-request",
      ),
    ).toBe(false);
  }
});

test("guided deferred profiles advertise usable commands in summaries and external-close wakes", async () => {
  const store = memoryFleet();
  const guidedConfig = {
    ...config,
    conductor: {
      ...config.conductor,
      profiles: {
        ...config.conductor.profiles,
        codex: { ...config.conductor.profiles.codex!, runtime: "claude-code" as const },
      },
    },
  };
  const reading = { ...snapshot(), guidedProfiles: ["codex"] };
  const saved = await requestDeferredLaunch(store, {
    config: guidedConfig,
    snapshot: reading,
    ticket: "DEMO-9",
    profile: "codex",
    author: "Ada",
    now: NOW,
  });
  expect(saved.command).toContain("armada brief DEMO-9 --profile codex --reason");
  expect(saved.command).toEndWith(" --prompt");
  const result = await serveFleet(
    store,
    { project: DEMO_PROJECT, op: "launch-requests", caller: { kind: "organization", author: "Ada" }, input: {} },
    { config: guidedConfig, snapshot: reading, now: () => NOW },
  );
  expect(result.body.result).toMatchObject([{ command: saved.command }]);
  const blocker = reading.flight?.program.issues.find((i) => i.id === "DEMO-7");
  if (!blocker) throw new Error("missing blocker");
  blocker.statusType = "completed";
  const items = await readInbox(store, { project: "widgets", snapshot: reading, now: NOW, silentAfterMinutes: 15 });
  expect(items).toMatchObject([{ id: saved.id, body: expect.stringContaining(saved.command) }]);
});
