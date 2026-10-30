import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { nativeTools } from "../coordinator/native.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { startReaders } from "../src/server/readers.ts";
import { EventStore } from "../src/store.ts";

const project = { id: "orchard", name: "Orchard", repository: "example/orchard" };
const first = "2026-03-10T09:00:00.000Z";
const next = "2026-03-10T09:04:00.000Z";
const pr = {
  number: 41,
  ticket: "SEED-2",
  head: "a".repeat(40),
  state: "open" as const,
  ci: "failure" as const,
  conflicting: true,
};

test("fleet and inbox refresh their project's readers, see a merge immediately and retain successful read times on timeout", async () => {
  const store = new EventStore(":memory:");
  const scope = openCoordinatorStorage({ store, project: project.id, now: () => next });
  const registry = new PluginRegistry();
  const activation = registry.activation({
    id: "fixture",
    version: "1.0.0",
    pluginApi: "^0.2.0",
    enabledByDefault: true,
    description: "Synthetic readers",
    contributions: {
      tracker: { linear: { config: true, secrets: [] } },
      forge: { github: { config: true, secrets: [] } },
    },
  });
  let now = first;
  let reads = 0;
  let hanging = false;
  let signal: AbortSignal | undefined;
  let settle: () => void = () => {};
  activation.register.tracker("linear", { read: async () => {}, write: async () => {} });
  activation.register.forge("github", {
    read: async (request) => {
      reads++;
      if (hanging) {
        signal = request.signal;
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
        return;
      }
      assert.equal(request.project, project.id);
      store.append({ project: project.id, kind: "pull-request.seen", at: now, actor: "forge", payload: pr });
      if (reads > 1)
        store.append({
          project: project.id,
          kind: "pull-request.merged",
          at: now,
          actor: "forge",
          payload: {
            ...pr,
            state: "merged",
            repository: project.repository,
            title: "Plant seeds",
            url: "https://example.test/pull/41",
            headRef: "seed",
            draft: false,
            review: "approved",
            checks: [],
            checksComplete: true,
          },
        });
    },
    merge: async () => ({ merged: false }),
  });
  activation.commit();
  store.append({
    project: project.id,
    kind: "ticket.seen",
    at: first,
    actor: "tracker",
    payload: { id: "SEED-2", title: "Plant seeds", status: "started", phase: "ready-to-merge" },
  });
  const timers = new Map<() => void, number>();
  const readers = await startReaders({
    registry,
    projects: [project],
    store,
    now: () => now,
    schedule: (fn, ms) => {
      timers.set(fn, ms);
      return () => {
        timers.delete(fn);
      };
    },
  });
  try {
    await setImmediate();
    const tools = nativeTools(scope, { now: () => now, refresh: () => readers.refresh(project.id) });
    const run = async (name: "fleet.status" | "inbox.list") =>
      (await tools[name].execute({}, {} as ToolExecutionApi, context)).details as unknown as {
        readAt: Record<string, string>;
        at: string;
        tables: { pullRequests: { state: string }[]; sessions: { state: string; flowStep: string; reason: string }[] };
        items: { id: string }[];
      };
    now = next;
    const result = await run("fleet.status");
    assert.equal(result.tables.pullRequests[0]?.state, "merged");
    assert.equal(result.tables.sessions[0]?.state, "merged");
    assert.equal(result.tables.sessions[0]?.flowStep, "merged");
    assert.doesNotMatch(result.tables.sessions[0]?.reason ?? "", /conflict/i);
    assert.deepEqual(result.readAt, { linear: next, github: next });
    assert.equal(result.at, next);
    store.append({
      project: project.id,
      kind: "inbox.opened",
      at: next,
      actor: "worker",
      payload: { id: "q", ticket: "SEED-2", kind: "question", body: "Which seeds?" },
    });
    assert.deepEqual(
      (await run("inbox.list")).items.map((i) => i.id),
      ["q"],
    );
    assert.equal(reads, 3, "each tool requests a read, even between scheduled polls");
    hanging = true;
    now = "2026-03-10T09:08:00.000Z";
    const pending = run("fleet.status");
    await setImmediate();
    const deadline = [...timers].find(([, ms]) => ms === 3000)?.[0];
    assert.ok(deadline);
    deadline();
    const stale = await pending;
    assert.equal(stale.readAt.github, next);
    assert.equal(stale.readAt.linear, now);
    assert.equal(signal?.aborted, true);
    const joined = run("inbox.list");
    await setImmediate();
    [...timers].find(([, ms]) => ms === 3000)?.[0]();
    await joined;
    assert.equal(reads, 4, "an uncooperative read is joined, never duplicated");
    assert.deepEqual(await readers.refresh("other"), undefined);
  } finally {
    readers.stop();
    settle();
    await setImmediate();
    await scope.close(context);
    store.close();
  }
});

test("the coordinator model receives stale read times and an instruction to qualify its answer with their age", async () => {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { Coordinators } = await import("../coordinator/index.ts");
  const store = new EventStore(":memory:");
  const coordinators = new Coordinators(store);
  const faux = fauxProvider({ models: [{ id: "freshness" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  store.append({
    project: project.id,
    kind: "coordinator.checkpoint",
    actor: "reader",
    at: first,
    payload: { checkpoint: { format: "armada.readers", version: 1, provider: "github" } },
  });
  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fleet.status", {}), { stopReason: "toolUse" }),
      async (transcript) => {
        const prompt = JSON.stringify(transcript.messages.filter((message) => message.role === "system"));
        assert.match(prompt, /more than three minutes old/);
        assert.match(prompt, /say its age or time/);
        assert.match(prompt, /missing reading time means freshness is unknown/i);
        const result = transcript.messages.find((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult");
        const content = result.content.find((block) => block.type === "text");
        assert.ok(content && content.type === "text");
        const facts = JSON.parse(content.text);
        assert.equal(facts.readAt.github, first);
        const age = Math.floor((Date.parse(facts.at) - Date.parse(facts.readAt.github)) / 60_000);
        return fauxAssistantMessage(`GitHub last read ${age} min ago. No pull requests recorded.`);
      },
    ]);
    const coordinator = await coordinators.open({
      project: project.id,
      models,
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      now: () => Date.parse(next),
      setTimer: () => () => {},
    });
    const submission = await coordinator.conversation.submit({ type: "input", content: "What is blocked?" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    const history = await coordinator.conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.match(JSON.stringify(history.items), /GitHub last read 4 min ago/);
    assert.equal(faux.state.callCount, 2);
  } finally {
    await coordinators.close();
    store.close();
  }
});

test("only configured built-in providers publish successful read times", async (t) => {
  const { readerRegistry } = await import("./support/reader-plugins.ts");
  const { github, issue, page, project: configured } = await import("./support/reader-recordings.ts");
  const store = new EventStore(":memory:");
  const bodies: Record<string, unknown[]> = {
    Root: [{ issue: issue("SEED-1") }],
    Children: [{ issues: page([issue("SEED-2", "implementing")]) }, { issues: page([]) }],
    Comments: [{ issues: { nodes: ["SEED-1", "SEED-2"].map((identifier) => ({ identifier, comments: page([]) })) } }],
    Pulls: [github],
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    const op = /query\s+(\w+)/.exec(query)?.[1] ?? "?";
    const data = bodies[op]?.shift();
    assert.ok(data, `unexpected ${op}`);
    return Response.json({ data });
  });
  const registry = await readerRegistry(store, [configured]);
  const readers = await startReaders({
    registry,
    store,
    projects: [configured, { ...configured, id: "other" }],
    now: () => first,
    schedule: () => () => {},
    log: () => {},
  });
  try {
    await readers.refresh(configured.id);
    assert.deepEqual(
      Object.keys(
        (await import("../src/fold.ts")).fold(store.readSince(0)).projects[configured.id]?.readAt ?? {},
      ).sort(),
      ["github", "linear"],
    );
    await readers.refresh("other");
    assert.deepEqual(store.readSince(0, "other"), [], "unconfigured sources cannot claim freshness without reading");
  } finally {
    readers.stop();
    store.close();
  }
});
