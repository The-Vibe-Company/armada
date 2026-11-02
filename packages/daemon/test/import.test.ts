import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import { activate as internal } from "../../plugins/internal-tracker/src/index.ts";
import { activate as linear } from "../../plugins/linear/src/index.ts";
import { comment, issue, page, recorded, t0, t1 } from "../../plugins/linear/test/support/program.ts";
import type { EventInput } from "../src/events.ts";
import { Imports } from "../src/import/service.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

function providers(store: EventStore) {
  const trackers = new Map<string, TrackerProvider>();
  const ctx = {
    config: { tracker: { linear: { projects: {}, quotaProjects: ["orchard", "harbor"] } } },
    secrets: { get: async () => "synthetic-import-key" },
    register: { tracker: (kind: string, provider: TrackerProvider) => trackers.set(kind, provider) },
    events: {
      append: async (e: EventInput) => store.append(e),
      read: async (project: string, after: number) => store.readSince(after, project),
      appendWith: async (project: string, build: (tables: unknown) => EventInput[]) => store.appendWith(project, build),
      fold: async (project: string) => store.fold(project),
    },
    log: { info() {}, error() {} },
  } as unknown as PluginContext;
  internal(ctx);
  linear(ctx);
  return trackers;
}

test("recorded Linear program imports once, preserving relationships, states, labels and comment provenance", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  const root = { ...issue("SEED-1"), parent: { identifier: "OUT-1" } };
  const child = {
    ...issue("SEED-2", "implementing"),
    labels: page([
      { name: "implementing", parent: { name: "Agent phase" } },
      { name: "ready-for-agent", parent: null },
    ]),
    inverseRelations: page([{ type: "blocks", issue: { identifier: "SEED-3", state: { type: "completed" } } }]),
  };
  const done = { ...issue("SEED-3"), state: { type: "completed" } };
  const canceled = { ...issue("SEED-4"), state: { type: "canceled" } };
  const response = recorded({
    Root: [{ issue: root }],
    Children: [{ issues: page([child, done, canceled]) }, { issues: page([]) }, { issues: page([]) }],
    Comments: [
      {
        issues: {
          nodes: [root, child, done, canceled].map((i) => ({
            identifier: i.identifier,
            comments: page(i.identifier === "SEED-2" ? [comment("comment-1", "Keep the seedlings warm.")] : []),
          })),
        },
      },
      { issues: { nodes: [{ identifier: "SEED-5", comments: page([]) }] } },
    ],
    Changed: [{ issues: page([]) }, { issues: page([issue("SEED-5")]) }],
    ChangedComments: [{ comments: page([]) }, { comments: page([]) }],
  });
  t.mock.method(globalThis, "fetch", response.fetch);
  const imports = new Imports({
    store,
    project: (id) => ({ id, tracker: "internal" }),
    tracker: (kind) => trackers.get(kind),
    now: () => t1,
  });
  t.after(async () => {
    await imports.close();
    store.close();
  });
  const premature: string[] = [];
  const unsubscribe = store.subscribe(() => {
    const tickets = store.fold("orchard").projects.orchard?.tickets ?? [];
    const ready = tickets.find((ticket) => ticket.source === "SEED-2");
    if (!ready?.labels?.includes("ready-for-agent")) return;
    const blocker = tickets.find((ticket) => ticket.source === "SEED-3");
    if (!blocker || ready.blockers?.[0]?.id !== blocker.id || ready.comments?.[0]?.body !== "Keep the seedlings warm.")
      premature.push("Ready before import prerequisites were committed");
  });
  t.after(unsubscribe);
  const first = await imports.start("orchard", "SEED-1").done;
  assert.deepEqual(premature, []);
  assert.equal(first.state, "completed");
  assert.equal(first.imported, 4);
  const tables = store.fold("orchard").projects.orchard!;
  assert.equal(tables.tickets.length, 4);
  const bySource = new Map(tables.tickets.map((ticket) => [ticket.source, ticket]));
  const imported = bySource.get("SEED-2")!;
  assert.equal(imported.title, child.title);
  assert.equal(imported.description, child.description);
  assert.equal(imported.url, child.url);
  assert.deepEqual(imported.labels, ["implementing", "ready-for-agent"]);
  assert.equal(imported.phase, "implementing");
  assert.equal(imported.parent, bySource.get("SEED-1")!.id);
  assert.equal(bySource.get("SEED-1")!.parent, null);
  assert.deepEqual(imported.blockers, [{ id: bySource.get("SEED-3")!.id, status: "completed" }]);
  assert.equal(bySource.get("SEED-4")!.status, "canceled");
  assert.deepEqual(imported.comments, [{ body: "Keep the seedlings warm.", author: "Mira", at: t0 }]);
  assert.equal(tables.sessions.length, 0);
  const authored = () =>
    store.readSince(0).filter((e) => ["ticket.created", "ticket.edited", "ticket.commented"].includes(e.kind));
  const count = authored().length;
  const second = await imports.start("orchard", "SEED-1").done;
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 4);
  assert.equal(authored().length, count);
  const third = await imports.start("orchard", "SEED-1").done;
  assert.equal(third.imported, 1);
  assert.equal(store.fold("orchard").projects.orchard!.tickets.length, 5);
  assert.equal(authored().filter((e) => e.kind === "ticket.commented").length, 1);
  assert.ok(response.calls.every((call) => ["Root", "Children", "Comments", "Changed"].includes(call.operation)));
});

test("Linear targets refuse before reading; rate-limited imports persist a pause and never import a partial reading", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("", { status: 429, headers: { "retry-after": "3600" } });
  });
  const imports = new Imports({
    store,
    project: (id) => ({ id, tracker: id === "live" ? "linear" : "internal" }),
    tracker: (kind) => trackers.get(kind),
    now: () => t0,
  });
  t.after(async () => {
    await imports.close();
    store.close();
  });
  assert.throws(
    () => imports.start("live", "SEED-1"),
    /this project reads Linear live; add it without Linear to import/,
  );
  assert.equal(requests, 0);
  const paused = await imports.start("orchard", "SEED-1").done;
  assert.equal(paused.state, "paused");
  assert.ok(paused.pausedUntil);
  const count = requests;
  const again = await imports.start("orchard", "SEED-1").done;
  assert.equal(again.state, "paused");
  assert.equal(requests, count);
  // A cold activation must restore an import's cooldown for another project sharing the key.
  const cold = providers(store);
  const restarted = new Imports({
    store,
    project: (id) => ({ id, tracker: "internal" }),
    tracker: (kind) => cold.get(kind),
    now: () => t1,
  });
  const other = await restarted.start("harbor", "SEED-1").done;
  assert.equal(other.state, "paused");
  assert.equal(requests, count);
  await restarted.close();
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 0);
});

test("an interrupted create recovers its id and finishes comments; concurrent imports join and completed sources keep local edits", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  const tracker = trackers.get("internal")!;
  const create = tracker.create!.bind(tracker);
  let loseReply = true;
  tracker.create = async (request) => {
    const result = await create(request);
    if (loseReply) {
      loseReply = false;
      throw new Error("Lost create response");
    }
    return result;
  };
  const reading = {
    tickets: [
      {
        id: "SEED-1",
        title: "Grow",
        description: "Requirements",
        labels: ["ready-for-agent"],
        state: "backlog" as const,
        parent: null,
        blockers: [],
      },
    ],
    comments: [{ id: "comment-1", ticket: "SEED-1", body: "Plant now", author: "Mira", at: t0 }],
  };
  trackers.get("linear")!.readProgram = async () => ({ reading });
  const options = {
    store,
    project: (id: string) => ({ id, tracker: "internal" }),
    tracker: (kind: string) => trackers.get(kind),
    projects: ["orchard"],
    now: () => t1,
  };
  const imports = new Imports(options);
  t.after(() => store.close());
  const first = imports.start("orchard", "SEED-1");
  assert.equal(imports.start("orchard", "SEED-1").id, first.id);
  assert.equal((await first.done).state, "failed");
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 1);
  await imports.close();
  const incomplete = store.fold("orchard").projects.orchard!.tickets[0]!;
  await tracker.update!({
    project: "orchard",
    ticket: incomplete.id,
    patch: { parent: "LOCAL-9", blockers: ["LOCAL-8"] },
  });
  const restarted = new Imports(options);
  const recovered = await restarted.start("orchard", "SEED-1").done;
  assert.equal(recovered.state, "completed");
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 1);
  const ticket = store.fold("orchard").projects.orchard!.tickets[0]!;
  assert.equal(ticket.comments?.[0]?.author, "Mira");
  assert.equal(ticket.parent, "LOCAL-9");
  assert.equal(ticket.blockers?.[0]?.id, "LOCAL-8");
  await tracker.update!({ project: "orchard", ticket: ticket.id, patch: { title: "Owner's new title" } });
  assert.equal((await restarted.start("orchard", "SEED-1").done).skipped, 1);
  assert.equal(store.fold("orchard").projects.orchard!.tickets[0]!.title, "Owner's new title");
  await restarted.close();
});

test("owner import requests acknowledge the chore and subscriptions expose counts; Linear projects refuse", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  trackers.get("linear")!.readProgram = async () => ({
    reading: {
      tickets: [
        {
          id: "SEED-1",
          title: "Grow",
          description: "Requirements",
          labels: [],
          state: "backlog",
          parent: null,
          blockers: [],
        },
      ],
      comments: [],
    },
  });
  const projects = [
    { id: "orchard", name: "Orchard", repository: "example/orchard", tracker: "internal" },
    { id: "live", name: "Live", repository: "example/live", tracker: "linear" },
  ];
  const imports = new Imports({
    store,
    project: (id) => projects.find((p) => p.id === id),
    tracker: (kind) => trackers.get(kind),
    now: () => t1,
  });
  const server = await startServer({ store, projects, imports });
  t.after(async () => {
    await server.close();
    await imports.close();
    store.close();
  });
  const ws = new WebSocket(server.wsUrl);
  t.after(() => ws.terminate());
  await once(ws, "open");
  const request = async (body: object) => {
    const result = new Promise<any>((resolve) => {
      const receive = (data: unknown) => {
        const frame = JSON.parse(String(data));
        if (frame.id !== (body as { id: string }).id) return;
        ws.off("message", receive);
        resolve(frame);
      };
      ws.on("message", receive);
    });
    ws.send(JSON.stringify({ version, ...body }));
    return result;
  };
  const acknowledged = await request({
    type: "tracker.import",
    id: "import",
    project: "orchard",
    programRoot: "SEED-1",
  });
  assert.equal(acknowledged.type, "tracker.import.result");
  const subscribed = await request({ type: "project.subscribe", id: "progress", project: "orchard", after: 0 });
  assert.equal(subscribed.snapshot.state.trackerImport.id, acknowledged.importId);
  assert.equal(subscribed.snapshot.state.trackerImport.state, "completed");
  assert.equal(subscribed.snapshot.state.trackerImport.imported, 1);
  const refused = await request({ type: "tracker.import", id: "refuse", project: "live", programRoot: "SEED-1" });
  assert.equal(refused.type, "error");
  assert.equal(refused.message, "this project reads Linear live; add it without Linear to import");
});

test("a recorded incomplete program is never authored and a crash leaves an interrupted chore after restart", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  const response = recorded({
    Root: [{ issue: issue("SEED-1") }],
    Children: [{ issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }],
  });
  t.mock.method(globalThis, "fetch", response.fetch);
  const options = {
    store,
    project: (id: string) => ({ id, tracker: "internal" }),
    tracker: (kind: string) => trackers.get(kind),
    projects: ["orchard"],
    now: () => t1,
  };
  const imports = new Imports(options);
  assert.equal((await imports.start("orchard", "SEED-1").done).state, "failed");
  assert.ok(response.calls.some((c) => c.operation === "Children"));
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 0);
  await imports.close();
  store.append({
    project: "orchard",
    actor: "coordinator",
    at: t0,
    kind: "tracker.import-started",
    payload: { id: "crashed", programRoot: "SEED-1", state: "running", imported: 0, skipped: 0, total: 0, comments: 0 },
  });
  const restarted = new Imports(options);
  restarted.recover();
  assert.equal(store.fold("orchard").projects.orchard!.trackerImport?.state, "interrupted");
  await restarted.close();
  store.close();
});

test("removal fences admission through teardown and aborts the old read before a replacement project can import", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  trackers.get("linear")!.readProgram = async () => {
    await gate;
    return {
      reading: {
        tickets: [
          {
            id: "SEED-1",
            title: "Grow",
            description: "Requirements",
            labels: [],
            state: "backlog",
            parent: null,
            blockers: [],
          },
        ],
        comments: [],
      },
    };
  };
  const imports = new Imports({
    store,
    project: (id) => ({ id, tracker: "internal" }),
    tracker: (kind) => trackers.get(kind),
    now: () => t1,
  });
  t.after(async () => {
    release();
    await imports.close();
    store.close();
  });
  imports.start("orchard", "SEED-1");
  const stopping = imports.stopProject("orchard");
  assert.throws(() => imports.start("orchard", "SEED-1"), /being removed/);
  release();
  await stopping;
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 0);
  assert.throws(() => imports.start("orchard", "SEED-1"), /being removed/);
  imports.openProject("orchard");
  assert.equal((await imports.start("orchard", "SEED-1").done).imported, 1);
});

test("retry counts an already committed comment when source completion was interrupted", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  trackers.get("linear")!.readProgram = async () => ({
    reading: {
      tickets: [
        {
          id: "SEED-1",
          title: "Grow",
          description: "Requirements",
          labels: [],
          state: "backlog",
          parent: null,
          blockers: [],
        },
      ],
      comments: [{ id: "comment-1", ticket: "SEED-1", body: "Plant now", author: "Mira", at: t0 }],
    },
  });
  const append = store.append.bind(store);
  let interrupt = true;
  t.mock.method(store, "append", (event: EventInput) => {
    if (interrupt && event.kind === "tracker.import-progress" && event.payload.source) {
      interrupt = false;
      throw new Error("Interrupted before source completion");
    }
    return append(event);
  });
  const options = {
    store,
    project: (id: string) => ({ id, tracker: "internal" }),
    tracker: (kind: string) => trackers.get(kind),
    now: () => t1,
  };
  const imports = new Imports(options);
  t.after(async () => {
    await imports.close();
    store.close();
  });
  const interrupted = await imports.start("orchard", "SEED-1").done;
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.comments, 1);
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.commented").length, 1);
  const result = await imports.start("orchard", "SEED-1").done;
  assert.equal(result.imported, 1);
  assert.equal(result.comments, 1);
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.commented").length, 1);
});

test("an owner edit arriving at the provider commit boundary wins over an in-flight import patch", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  const tracker = trackers.get("internal")!;
  const update = tracker.update!.bind(tracker);
  let editAtCommit = true;
  tracker.update = async (request) => {
    if (editAtCommit) {
      editAtCommit = false;
      await update({ project: request.project, ticket: request.ticket, actor: "owner", patch: { parent: "LOCAL-9" } });
    }
    await update(request);
  };
  trackers.get("linear")!.readProgram = async () => ({
    reading: {
      tickets: [
        {
          id: "SEED-1",
          title: "Grow",
          description: "Requirements",
          labels: [],
          state: "backlog",
          parent: null,
          blockers: [],
        },
      ],
      comments: [],
    },
  });
  const imports = new Imports({
    store,
    project: (id) => ({ id, tracker: "internal" }),
    tracker: (kind) => trackers.get(kind),
    now: () => t1,
  });
  t.after(async () => {
    await imports.close();
    store.close();
  });
  assert.equal((await imports.start("orchard", "SEED-1").done).state, "failed");
  assert.equal(store.fold("orchard").projects.orchard!.tickets[0]!.parent, "LOCAL-9");
  assert.equal((await imports.start("orchard", "SEED-1").done).state, "completed");
  assert.equal(store.fold("orchard").projects.orchard!.tickets[0]!.parent, "LOCAL-9");
});

test("a durable internal update intent without an event can retry instead of permanently wedging the import", async (t) => {
  const store = new EventStore(":memory:");
  const trackers = providers(store);
  const tracker = trackers.get("internal")!;
  const update = tracker.update!.bind(tracker);
  let failBeforeCommit = true;
  tracker.update = async (request) => {
    if (failBeforeCommit) {
      failBeforeCommit = false;
      throw new Error("Interrupted before append");
    }
    await update(request);
  };
  trackers.get("linear")!.readProgram = async () => ({
    reading: {
      tickets: [
        {
          id: "SEED-1",
          title: "Grow",
          description: "Requirements",
          labels: ["ready-for-agent"],
          state: "backlog",
          parent: null,
          blockers: [],
        },
      ],
      comments: [],
    },
  });
  const imports = new Imports({
    store,
    project: (id) => ({ id, tracker: "internal" }),
    tracker: (kind) => trackers.get(kind),
    now: () => t1,
  });
  t.after(async () => {
    await imports.close();
    store.close();
  });
  assert.equal((await imports.start("orchard", "SEED-1").done).state, "failed");
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 1);
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.edited").length, 0);
  assert.equal((await imports.start("orchard", "SEED-1").done).state, "completed");
  assert.equal(store.readSince(0).filter((e) => e.kind === "ticket.created").length, 1);
  assert.deepEqual(store.fold("orchard").projects.orchard!.tickets[0]!.labels, ["ready-for-agent"]);
});
