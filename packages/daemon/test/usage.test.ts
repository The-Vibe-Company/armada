import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createSession } from "@earendil-works/pi-durable";
import { Coordinators } from "../coordinator/index.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import { wakeups } from "../coordinator/wake.ts";
import { evaluateBudget } from "../src/budget.ts";
import { fold } from "../src/fold.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

const at = "2030-01-02T02:00:00.000Z";
const counters = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 };
function rules(store: EventStore, budget: Record<string, string | number>, project = "p") {
  store.append({
    project,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: {
          revision: 1,
          value: { policy: { budget } },
        },
      },
    },
  });
}

test("real model completions meter daily and session usage once, across replay and projects", async (t) => {
  const store = new EventStore(":memory:");
  const coordinators = new Coordinators(store);
  t.after(async () => {
    await coordinators.close();
    store.close();
  });
  const faux = fauxProvider({ models: [{ id: "meter-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const message = fauxAssistantMessage("Done");
  faux.setResponses([message, message]);
  for (const project of ["p", "other"]) {
    const c = await coordinators.open({
      project,
      models,
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      now: () => Date.parse(at),
      setTimer: () => () => {},
    });
    await (await c.conversation.submit({ type: "input", content: "Read" }, context)).wait(context);
  }
  for (const project of ["p", "other"]) {
    const c = await coordinators.open({
      project,
      models,
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    });
    const expected = Object.values((await c.harness.usage(context)).models)[0];
    assert.ok(expected);
    const usage = fold(store.readSince(0)).projects[project]?.usage;
    assert.ok(usage);
    assert.equal(usage.days[0]?.coordinator.input, expected.input);
    assert.equal(usage.days[0]?.coordinator.output, expected.output);
    assert.equal(usage.days[0]?.coordinator.cacheRead, expected.cacheRead);
    assert.equal(usage.days[0]?.coordinator.cacheWrite, expected.cacheWrite);
    assert.equal(usage.days[0]?.coordinator.unknown, 0);
    assert.equal(usage.sessions[0]?.totals.input, expected.input);
    assert.ok(expected.input > 0);
    assert.deepEqual(fold(store.readSince(0, project)).projects[project]?.usage, usage);
  }
});

test("a completed turn with no reported counters is unknown rather than zero", async (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  const storage = openCoordinatorStorage({ store, project: "p", now: () => at });
  const session = createSession(storage);
  const conversation = await session.commit(
    (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
    context,
  );
  await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [] }), context);
  await session.close(context);
  const totals = fold(store.readSince(0)).projects.p?.usage?.days[0]?.coordinator;
  assert.ok(totals);
  assert.equal(totals.input, null);
  assert.equal(totals.output, null);
  assert.equal(totals.unknown, 1);
});

test("pure budget decisions return one hold and owner item, survive repeats and honor a reasoned clear", (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  rules(store, { coordinatorTokensPerDay: 150, zone: "UTC" });
  store.append({
    project: "p",
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {},
      turn: { id: "1", session: "root" },
      usage: { ...counters, input: 1_000_000, model: "meter-model", provider: "test" },
    },
  });
  const events = store.readSince(0);
  const effects = evaluateBudget({ project: "p", events, now: at });
  assert.equal(store.sequence, events.length, "evaluation does not mutate storage");
  assert.deepEqual(
    effects.map((e) => e.kind),
    ["hold.opened", "inbox.opened"],
  );
  const request = effects.find((event) => event.kind === "inbox.opened");
  assert.ok(request?.kind === "inbox.opened");
  assert.match(request.payload.body, /Budget reached: 1\.0M tokens today\. Raise to 2\.0M/);
  for (const e of effects) store.append(e);
  const afterBudget = store.readSince(0);
  const candidates = wakeups(
    { tables: fold(events).projects.p, events },
    { tables: fold(afterBudget).projects.p, events: afterBudget },
  );
  assert.equal(candidates.length, 1, "the daemon hold wakes the coordinator beside its owner request");
  assert.equal(candidates[0]?.facts.state, "open");
  assert.deepEqual(evaluateBudget({ project: "p", events: store.readSince(0), now: at }), []);
  const hold = fold(store.readSince(0)).projects.p?.holds[0];
  assert.ok(hold);
  store.append({
    project: "p",
    at,
    actor: "owner",
    kind: "hold.cleared",
    payload: { id: hold.id, reason: "Allow one more batch" },
  });
  assert.deepEqual(evaluateBudget({ project: "p", events: store.readSince(0), now: at }), []);
  assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 0);
  assert.deepEqual(evaluateBudget({ project: "other", events: store.readSince(0), now: at }), []);
});

for (const [now, expected] of [
  ["2030-01-02T04:59:00Z", 0], // 21:59 in Denver, outside the night.
  ["2030-01-02T05:00:00Z", 2], // 22:00: start included.
  ["2030-01-02T13:59:00Z", 2], // 06:59 next civil day, same night.
  ["2030-01-02T14:00:00Z", 0], // 07:00: end excluded.
] as const) {
  test(`night launch budget uses the configured zone at ${now}`, (t) => {
    const store = new EventStore(":memory:");
    t.after(() => store.close());
    rules(store, { workerLaunchesPerNight: 1, zone: "America/Denver" });
    store.append({
      project: "p",
      actor: "coordinator",
      at: "2030-01-02T05:00:00Z",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.worker",
          version: 1,
          type: "launch",
          step: "launched",
          ticket: "SEED-1",
          session: "worker-1",
          runtime: "claude",
          generation: 1,
        },
      },
    });
    assert.equal(evaluateBudget({ project: "p", events: store.readSince(0), now }).length, expected);
  });
}

test("the repeated DST hour stays in one night, and the next night gets a new allowance", (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  rules(store, { workerLaunchesPerNight: 1, zone: "America/New_York" });
  store.append({
    project: "p",
    actor: "coordinator",
    at: "2030-11-03T05:30:00Z",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.worker",
        version: 1,
        type: "launch",
        step: "launched",
        ticket: "SEED-1",
        session: "worker-1",
        runtime: "claude",
        generation: 1,
      },
    },
  });
  const effects = evaluateBudget({ project: "p", events: store.readSince(0), now: "2030-11-03T05:45:00Z" });
  assert.equal(effects.length, 2);
  for (const e of effects) store.append(e);
  assert.deepEqual(evaluateBudget({ project: "p", events: store.readSince(0), now: "2030-11-03T06:45:00Z" }), []);
  assert.deepEqual(evaluateBudget({ project: "p", events: store.readSince(0), now: "2030-11-04T03:00:00Z" }), []);
});

test("worker cumulative observations retain generation sums without charging them twice", (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  for (const [session, input] of [
    ["one", 100],
    ["one", 100],
    ["one", 150],
    ["two", 20],
  ] as const) {
    store.append({
      project: "p",
      at,
      actor: "daemon",
      kind: "session.usage",
      payload: {
        ticket: "SEED-1",
        session,
        generation: session === "one" ? 1 : 2,
        usage: { input, output: null, cacheRead: null, cacheWrite: null, model: null, provider: null },
      },
    });
  }
  const usage = fold(store.readSince(0)).projects.p?.usage;
  assert.equal(usage?.days[0]?.workers.input, 170);
  assert.equal(usage?.days[0]?.workers.output, null);
  assert.equal(usage?.days[0]?.workersReported, 2);
  assert.deepEqual(
    usage?.sessions.map((s) => s.totals.input),
    [150, 20],
  );
});

test("budget enforcement runs on a real completion and recovers a missing owner item after restart", async (t) => {
  const store = new EventStore(":memory:");
  const coordinators = new Coordinators(store);
  t.after(async () => {
    await coordinators.close();
    store.close();
  });
  rules(store, { coordinatorTokensPerDay: 1, zone: "UTC" });
  const faux = fauxProvider({ models: [{ id: "meter-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("Done again")]);
  const c = await coordinators.open({
    project: "p",
    models,
    model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    now: () => Date.parse(at),
    setTimer: () => () => {},
  });
  assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 0);
  await (await c.conversation.submit({ type: "input", content: "Read" }, context)).wait(context);
  assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 1);
  await (await c.conversation.submit({ type: "input", content: "Read again" }, context)).wait(context);
  assert.equal(store.readSince(0).filter((e) => e.kind === "hold.opened").length, 1);
  assert.equal(store.readSince(0).filter((e) => e.kind === "inbox.opened").length, 1);
  const recovery = new EventStore(":memory:");
  for (const e of store.readSince(0)) if (e.kind !== "inbox.opened") recovery.append(e);
  const restored = openCoordinatorStorage({ store: recovery, project: "p", now: () => at });
  assert.equal(fold(recovery.readSince(0)).projects.p?.inbox.length, 1);
  assert.equal(recovery.readSince(0).filter((e) => e.kind === "hold.opened").length, 1);
  await restored.close(context);
  recovery.close();
});

test("pre-metering pi logs recover usage and missing counters from their durable assistant entries", () => {
  const usage = fold([
    {
      seq: 1,
      project: "p",
      at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.pi",
          type: "commit",
          writes: [
            {
              type: "entry",
              value: {
                id: 1,
                conversationId: 1,
                kind: "pi.assistant",
                model: [{ role: "assistant", model: "oak", provider: "fixture", usage: counters }],
              },
            },
            { type: "entry", value: { id: 2, conversationId: 1, kind: "pi.assistant", model: [] } },
          ],
        },
      },
    },
  ]).projects.p?.usage;
  assert.equal(usage?.days[0]?.coordinator.input, 100);
  assert.equal(usage?.days[0]?.coordinator.unknown, 1);
});

test("unknown completed usage holds a configured ceiling instead of spending unmetered tokens", (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  rules(store, { coordinatorTokensPerDay: 1000, zone: "UTC" });
  store.append({
    project: "p",
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: { checkpoint: {}, turn: { id: "unreported", session: "root" }, usage: "unknown" },
  });
  const effects = evaluateBudget({ project: "p", events: store.readSince(0), now: at });
  assert.equal(effects.length, 2);
  assert.match(JSON.stringify(effects), /usage.*unknown/);
  assert.doesNotMatch(JSON.stringify(effects), /0 tokens today/);
});

test("changing a worker night window does not duplicate the daily token hold", (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  rules(store, { coordinatorTokensPerDay: 0, zone: "UTC" });
  for (const e of evaluateBudget({ project: "p", events: store.readSince(0), now: at })) store.append(e);
  rules(store, { coordinatorTokensPerDay: 0, nightStart: "21:00", nightEnd: "06:00", zone: "UTC" });
  assert.deepEqual(evaluateBudget({ project: "p", events: store.readSince(0), now: at }), []);
});

test("compaction model usage is checkpointed and included in the same daily ceiling without charging turns twice", async (t) => {
  const store = new EventStore(":memory:");
  const coordinators = new Coordinators(store);
  t.after(async () => {
    await coordinators.close();
    store.close();
  });
  const faux = fauxProvider({ models: [{ id: "meter-model", contextWindow: 1_000_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("One"),
    fauxAssistantMessage("Two"),
    fauxAssistantMessage("Three"),
    fauxAssistantMessage("Summary of earlier facts"),
  ]);
  const c = await coordinators.open({
    project: "p",
    models,
    model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    now: () => Date.parse(at),
    setTimer: () => () => {},
  });
  for (let i = 0; i < 3; i++)
    await (
      await c.conversation.submit({ type: "input", content: `Facts ${i}: ` + "orchard ".repeat(10000) }, context)
    ).wait(context);
  const before = Object.values((await c.harness.usage(context)).models)[0];
  assert.ok(before);
  assert.equal(faux.state.callCount, 3);
  const beforeTokens = before.input + before.output + before.cacheRead + before.cacheWrite;
  rules(store, { coordinatorTokensPerDay: beforeTokens + 1, zone: "UTC" });
  const task = await c.conversation.compact("Keep the facts", context);
  await c.harness.waitForTask(task, context);
  await c.harness.waitForIdle(context);
  assert.equal(faux.state.callCount, 4, "a real summarizer model call ran");
  const expected = Object.values((await c.harness.usage(context)).models)[0];
  assert.ok(expected);
  const totals = fold(store.readSince(0)).projects.p?.usage?.days[0]?.coordinator;
  assert.equal(totals?.input, expected.input);
  assert.equal(totals?.output, expected.output);
  assert.equal(totals?.reported, 4);
  assert.equal(
    fold(store.readSince(0)).projects.p?.holds.length,
    1,
    JSON.stringify({
      before,
      expected,
      totals,
      effects: evaluateBudget({ project: "p", events: store.readSince(0), now: at }),
    }),
  );
  assert.ok(
    store.readSince(0).some((e) => e.kind === "coordinator.checkpoint" && e.payload.turn?.id.startsWith("pi:")),
  );
});

for (const known of [true, false]) {
  test(`plugin model usage preserves ${known ? "cache splits" : "unknown provider counters"} through the real SDK bridge`, async (t) => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { pluginModels } = await import("../src/model-sdk.ts");
    const sdk = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: "Done" }],
        finishReason: { unified: "stop", raw: "stop" },
        warnings: [],
        usage: {
          inputTokens: {
            total: known ? 160 : undefined,
            noCache: known ? 100 : undefined,
            cacheRead: known ? 30 : undefined,
            cacheWrite: known ? 30 : undefined,
          },
          outputTokens: { total: known ? 20 : undefined, text: known ? 20 : undefined, reasoning: undefined },
        },
      },
    });
    const store = new EventStore(":memory:");
    const coordinators = new Coordinators(store);
    t.after(async () => {
      await coordinators.close();
      store.close();
    });
    const shared = pluginModels("fixture", "oak", sdk);
    for (const project of ["p", "other"]) {
      const c = await coordinators.open({
        project,
        ...shared,
        now: () => Date.parse(at),
        setTimer: () => () => {},
      });
      await (await c.conversation.submit({ type: "input", content: "Read" }, context)).wait(context);
      const totals = fold(store.readSince(0)).projects[project]?.usage?.days[0]?.coordinator;
      assert.ok(totals);
      if (known)
        assert.deepEqual(
          { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite },
          { input: 100, output: 20, cacheRead: 30, cacheWrite: 30 },
        );
      else {
        assert.equal(totals.input, null);
        assert.equal(totals.output, null);
        assert.equal(totals.unknown, 1);
      }
      assert.equal(
        store
          .readSince(0, project)
          .filter(
            (e) =>
              e.kind === "coordinator.checkpoint" &&
              typeof e.payload.checkpoint === "object" &&
              e.payload.checkpoint !== null &&
              !Array.isArray(e.payload.checkpoint) &&
              e.payload.checkpoint.format === "armada.usage",
          ).length,
        1,
      );
    }
  });
}

for (const output of [undefined, 10]) {
  test(`an SDK compaction with ${output === undefined ? "unknown" : "partial"} usage is held and counted once, including after replay`, async (t) => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { pluginModels } = await import("../src/model-sdk.ts");
    let calls = 0;
    const sdk = new MockLanguageModelV4({
      doGenerate: async () => {
        const compacting = ++calls === 4;
        return {
          content: [{ type: "text", text: "Done" }],
          finishReason: { unified: "stop", raw: "stop" },
          warnings: [],
          usage: {
            inputTokens: {
              total: compacting ? undefined : 30000,
              noCache: compacting ? undefined : 30000,
              cacheRead: compacting ? undefined : 0,
              cacheWrite: compacting ? undefined : 0,
            },
            outputTokens: { total: compacting ? output : 20, text: compacting ? output : 20, reasoning: undefined },
          },
        };
      },
    });
    const store = new EventStore(":memory:");
    t.after(async () => {
      await server.close();
      store.close();
    });
    const config = {
      project: "p",
      ...pluginModels("fixture", "oak", sdk),
      now: () => Date.parse(at),
      setTimer: () => () => {},
    };
    let server = await startServer({
      store,
      projects: [{ id: "p", name: "Orchard", repository: "example/orchard" }],
      coordinators: [config],
    });
    const c = server.coordinators.get("p");
    assert.ok(c);
    for (let i = 0; i < 3; i++)
      await (
        await c.conversation.submit({ type: "input", content: `Facts ${i}: ` + "orchard ".repeat(10000) }, context)
      ).wait(context);
    assert.equal(calls, 3);
    rules(store, { coordinatorTokensPerDay: 1000000, zone: "UTC" });
    assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 0);
    const task = await c.conversation.compact("Keep the facts", context);
    await c.harness.waitForTask(task, context);
    await c.harness.waitForIdle(context);
    assert.equal(calls, 4);
    const totals = fold(store.readSince(0)).projects.p?.usage?.days[0]?.coordinator;
    assert.equal(totals?.input, 90000);
    assert.equal(totals?.output, 60 + (output ?? 0));
    assert.equal(totals?.unknown, 1);
    assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 1);
    const usage = fold(store.readSince(0)).projects.p?.usage;
    await server.close();
    server = await startServer({
      store,
      projects: [{ id: "p", name: "Orchard", repository: "example/orchard" }],
      coordinators: [config],
    });
    assert.deepEqual(fold(store.readSince(0)).projects.p?.usage, usage);
  });
}

for (const failure of ["zero", "throw"])
  test(`native pi ${failure} usage is unknown for compaction and generations`, async (t) => {
    const { createProvider } = await import("@earendil-works/pi-ai/models");
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
    const base = fauxProvider({ models: [{ id: "native" }] }).getModel();
    const model = { ...base, api: "native-meter", provider: "native-meter", contextWindow: 1000000 };
    let calls = 0;
    const stream = () => {
      const message = fauxAssistantMessage("Done");
      Object.assign(message, {
        provider: model.provider,
        model: model.id,
        api: model.api,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      if (++calls <= 3)
        Object.assign(message.usage, { input: 30000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30020 });
      if (calls >= 4 && failure === "throw") throw new Error("Synthetic provider failure");
      // The fourth response omits optional provider usage metadata: pi's mandatory counters remain initialized zero.
      const result = createAssistantMessageEventStream();
      result.push({ type: "done", reason: "stop", message });
      result.end(message);
      return result;
    };
    const models = createModels();
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: {} }) } },
        api: { stream, streamSimple: stream },
      }),
    );
    const store = new EventStore(":memory:");
    const server = await startServer({
      store,
      projects: [{ id: "p", name: "Orchard", repository: "example/orchard" }],
      coordinators: [
        {
          project: "p",
          models,
          model: { provider: model.provider, modelId: model.id },
          now: () => Date.parse(at),
          setTimer: () => () => {},
        },
      ],
    });
    t.after(async () => {
      await server.close();
      store.close();
    });
    const c = server.coordinators.get("p");
    assert.ok(c);
    for (let i = 0; i < 3; i++)
      await (
        await c.conversation.submit({ type: "input", content: `Facts ${i}: ` + "orchard ".repeat(10000) }, context)
      ).wait(context);
    rules(store, { coordinatorTokensPerDay: 1000000, zone: "UTC" });
    const task = await c.conversation.compact("Keep the facts", context);
    await c.harness.waitForTask(task, context);
    await c.harness.waitForIdle(context);
    assert.equal(calls, 4);
    assert.equal(fold(store.readSince(0)).projects.p?.usage?.days[0]?.coordinator.unknown, 1);
    assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 1);
    if (failure === "throw") return;
    await (
      await c.conversation.submit({ type: "input", content: "A fifth response without provider counters" }, context)
    ).wait(context);
    assert.equal(fold(store.readSince(0)).projects.p?.usage?.days[0]?.coordinator.unknown, 2);
    assert.equal(store.readSince(0).filter((e) => e.kind === "hold.opened").length, 1);
  });

for (const runtime of ["native", "sdk", "sdk-unknown"] as const) {
  test(`watchdog ${runtime} completions enter the project ceiling once, without charging another project`, async (t) => {
    const store = new EventStore(":memory:");
    const coordinators = new Coordinators(store);
    t.after(async () => {
      await coordinators.close();
      store.close();
    });
    rules(store, { coordinatorTokensPerDay: 1, zone: "UTC" });
    const ref = { ticket: "ORC-1", session: "worker-1", generation: 1 };
    const append = (kind: "session.claimed" | "session.reported" | "session.heartbeat", payload: object) =>
      store.append({ project: "p", at, actor: "worker", kind, payload } as import("@armada/protocol").EventInput);
    append("session.claimed", { ...ref, runtime: "claude", owner: "coordinator", handle: "worker" });
    for (let i = 0; i < 3; i++) append("session.reported", { ...ref, phase: "implementing", reason: "Same retry" });
    append("session.heartbeat", ref);
    let called!: () => void;
    const request = new Promise<void>((resolve) => {
      called = resolve;
    });
    let calls = 0;
    const verdict = JSON.stringify({ verdict: "progressing", evidence: "Making progress" });
    const { createProvider } = await import("@earendil-works/pi-ai/models");
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
    const base = fauxProvider({ models: [{ id: "watchdog-meter" }] }).getModel();
    const model = { ...base, api: "watchdog-meter", provider: "watchdog-meter" };
    const models = createModels();
    const stream = () => {
      calls++;
      called();
      const message = fauxAssistantMessage(verdict);
      Object.assign(message, { provider: model.provider, model: model.id, api: model.api });
      message.usage = { ...message.usage, ...counters, totalTokens: 160 };
      const result = createAssistantMessageEventStream();
      result.push({ type: "done", reason: "stop", message });
      result.end(message);
      return result;
    };
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: {} }) } },
        api: { stream, streamSimple: stream },
      }),
    );
    let config = { models, model: { provider: model.provider, modelId: model.id } };
    if (runtime !== "native") {
      const { MockLanguageModelV4 } = await import("ai/test");
      const { pluginModels } = await import("../src/model-sdk.ts");
      const known = runtime === "sdk";
      const sdk = new MockLanguageModelV4({
        doGenerate: async () => {
          calls++;
          called();
          return {
            content: [{ type: "text", text: verdict }],
            finishReason: { unified: "stop", raw: "stop" },
            warnings: [],
            usage: {
              inputTokens: {
                total: known ? 140 : undefined,
                noCache: known ? 100 : undefined,
                cacheRead: known ? 30 : undefined,
                cacheWrite: known ? 10 : undefined,
              },
              outputTokens: { total: known ? 20 : undefined, text: known ? 20 : undefined, reasoning: undefined },
            },
          };
        },
      });
      config = pluginModels("fixture", "watchdog-meter", sdk);
    }
    // Both coordinators share one registry; only the watchdog's project owns this request.
    await coordinators.open({ project: "other", ...config, now: () => Date.parse(at), setTimer: () => () => {} });
    const timers = new Set<{ run: () => void; delay: number }>();
    const c = await coordinators.open({
      project: "p",
      ...config,
      now: () => Date.parse(at),
      setTimer: () => () => {},
      wakeClock: {
        now: () => Date.parse(at),
        setTimer(run, delay) {
          const timer = { run, delay };
          timers.add(timer);
          return () => {
            timers.delete(timer);
          };
        },
      },
    });
    assert.equal(fold(store.readSince(0)).projects.p?.holds.length, 0);
    const due = [...timers].find((timer) => timer.delay === 1);
    assert.ok(due, "repeated live reports schedule a watchdog judgment");
    due.run();
    await request;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await c.waker.close();
    assert.equal(calls, 1, "one real watchdog request ran without a coordinator conversation turn");
    const tables = fold(store.readSince(0));
    const usage = tables.projects.p?.usage?.days[0]?.coordinator;
    assert.ok(usage, "the completed watchdog request is metered");
    if (runtime === "sdk-unknown") {
      assert.equal(usage.input, null);
      assert.equal(usage.unknown, 1);
    } else {
      assert.deepEqual(
        { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
        counters,
      );
      assert.equal(usage.reported, 1);
    }
    assert.equal(tables.projects.p?.holds.length, 1);
    assert.equal(tables.projects.p?.inbox.filter((item) => item.kind === "owner-request").length, 1);
    assert.equal(tables.projects.other?.usage, undefined);
  });
}

test("reattached Claude usage retains the generation floor and marks a bounded replay prefix unknown", async (t) => {
  const { claudeRuntime } = await import("../../plugins/claude/src/index.ts");
  const ref = { project: "p", ticket: "SEED-1", session: "same-generation", generation: 1, handle: "native" };
  const workspace = { id: "workspace", path: "/fixture", node: "local" };
  const result = (input: number, uuid: string) =>
    `${JSON.stringify({
      type: "result",
      uuid,
      session_id: uuid === "before" ? "before-clear" : "after-clear",
      modelUsage: {
        oak: { inputTokens: input, outputTokens: input / 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    })}\n`;
  let output = result(1000, "before");
  let launches = 0;
  const node: import("@armada/plugin-api").NodeProvider = {
    prepare: async () => workspace,
    launch: async () => {
      launches++;
      return ref;
    },
    adopt: async () => ({ deliveries: 1 }),
    deliver: async () => {},
    observe: async () => ({ state: "running", reply: output }),
    stop: async () => {},
  };
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  const record = async (runtime: ReturnType<typeof claudeRuntime>) => {
    const observed = await runtime.observe(ref);
    store.append({
      project: "p",
      at,
      actor: "daemon",
      kind: "session.usage",
      payload: {
        ticket: ref.ticket,
        session: ref.session,
        generation: ref.generation,
        usage: observed.usage ?? "unknown",
      },
    });
    return observed.usage;
  };
  const first = claudeRuntime({}, node);
  await first.launch({ workspace, worker: ref, command: "", args: [], env: {} });
  const initial = await record(first);
  assert.notEqual(initial, "unknown");
  assert.equal(typeof initial === "object" ? initial.input : null, 1000);
  // A restarted daemon sees a bounded node tail, not evidence of the earlier clear or its counters.
  output = "";
  const recovered = claudeRuntime({}, node);
  await recovered.adopt?.(ref, workspace, first.checkpoint?.(ref));
  assert.equal(await record(recovered), "unknown");
  output = result(150, "recovered");
  const partial = await record(recovered);
  assert.equal(typeof partial === "object" ? partial.input : null, 150);
  assert.equal(typeof partial === "object" ? partial.incomplete : false, true);
  const session = () => fold(store.readSince(0)).projects.p?.usage?.sessions.find((row) => row.session === ref.session);
  assert.equal(session()?.totals.input, 1000, "an incomplete replay cannot erase already observed tokens");
  assert.equal(session()?.totals.unknown, 1);
  output += result(1200, "later");
  await record(recovered);
  assert.equal(session()?.totals.input, 1200);
  assert.equal(session()?.totals.unknown, 1);
  assert.equal(
    fold(store.readSince(0)).projects.p?.usage?.days[0]?.workers.input,
    1200,
    "cumulative lower bounds are not charged twice",
  );
  assert.equal(launches, 1, "adoption never creates another worker");
});

test("a running coordinator observes a budget enabled outside its storage owner before its next commit", async (t) => {
  const store = new EventStore(":memory:");
  const storage = openCoordinatorStorage({ store, project: "p", now: () => at });
  t.after(async () => {
    await storage.close(context);
    store.close();
  });
  await storage.commit([], context);
  assert.equal(store.fold("p").projects.p?.holds.length, 0);
  // Server-side rule changes do not pass through storage.appendEvents.
  rules(store, { coordinatorTokensPerDay: 0, zone: "UTC" });
  await storage.commit([], context);
  const state = store.fold("p").projects.p;
  assert.equal(state?.holds.length, 1);
  assert.match(state?.holds[0]?.reason ?? "", /budget:.*0.*limit/);
  assert.equal(state?.inbox[0]?.kind, "owner-request");
});
