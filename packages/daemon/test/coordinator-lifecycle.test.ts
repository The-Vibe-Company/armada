import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Coordinators, coordinatorTools } from "../coordinator/index.ts";
import { fold } from "../src/fold.ts";
import { dispatchChat } from "../src/server/chat.ts";
import { ChatLive } from "../src/server/chat-live.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

test("the room names the actual configured model once per coordinator lifetime, including after restart", async (t) => {
  const store = new EventStore(":memory:");
  const faux = fauxProvider({ provider: "orchard", models: [{ id: "first" }, { id: "second" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const live = new ChatLive();
  let manager = new Coordinators(store);
  t.after(async () => {
    await live.close();
    await manager.close();
    store.close();
  });
  let now = 1000;
  const config = {
    project: "p",
    models,
    model: { provider: "orchard", modelId: "first" },
    now: () => now,
    setTimer: () => () => {},
  };
  const first = await manager.open(config);
  assert.equal(await manager.open(config), first);
  assert.deepEqual(
    store
      .readSince(0)
      .filter((event) => event.kind === "coordinator.message")
      .map((event) => event.payload.body),
    ["Coordinator uses orchard/first."],
  );
  faux.setResponses([fauxAssistantMessage("Ready", { timestamp: now })]);
  assert.equal(
    (await (await first.conversation.submit({ type: "input", content: "Hello" }, context)).wait(context)).status,
    "done",
  );
  await manager.close();

  now = 2000;
  manager = new Coordinators(store);
  const second = await manager.open({ ...config, model: { provider: "orchard", modelId: "second" } });
  assert.equal((await second.conversation.agent(context)).model?.modelId, "second");
  const reading = await dispatchChat(
    { type: "chat.read", version: PROTOCOL_VERSION, id: "read", project: "p" },
    { store, coordinator: second, live },
  );
  assert.ok(reading.type === "chat.result");
  assert.deepEqual(
    reading.items.filter((item) => item.kind === "line").map((item) => item.body),
    ["Coordinator uses orchard/first.", "Coordinator uses orchard/second."],
  );
  await manager.open(config);
  assert.equal(store.readSince(0).filter((event) => event.kind === "coordinator.message").length, 2);
});

test("daemon refuses invalid coordinator configuration, releases failed startup and exposes unavailable actions as refusals", async () => {
  const store = new EventStore(":memory:");
  const faux = fauxProvider({ models: [{ id: "lifecycle" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const config = {
    project: "p",
    models,
    model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    now: () => 0,
    setTimer: () => () => {},
  };
  const projects = [{ id: "p", name: "Project", repository: "example/project" }];
  try {
    await assert.rejects(startServer({ store, projects, coordinators: [config, config] }), /Duplicate coordinator/);
    await assert.rejects(startServer({ store, projects: [], coordinators: [config] }), /Unknown coordinator/);
    const tool = coordinatorTools()[0];
    assert.ok(tool);
    await assert.rejects(
      startServer({ store, projects, coordinators: [{ ...config, tools: { "inbox.list": tool } }] }),
      /name mismatch/,
    );
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("fleet.status", {}),
          fauxToolCall("hold.add", { reason: "Main red" }),
          fauxToolCall("worker.launch", { ticket: "SEED-1", branch: "worker/seed", brief: "Plant" }),
        ],
        { stopReason: "toolUse", timestamp: 0 },
      ),
      async (transcript) => {
        assert.match(JSON.stringify(transcript.messages), /not_available_yet/);
        return fauxAssistantMessage("Launching is unavailable", { timestamp: 0 });
      },
    ]);
    const server = await startServer({ store, projects, coordinators: [config] });
    try {
      const second = new Coordinators(store);
      await assert.rejects(second.open(config), /already open/);
      await second.close();
      const coordinator = server.coordinators.get("p");
      assert.ok(coordinator);
      const submission = await coordinator.conversation.submit({ type: "input", content: "Launch work" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      assert.equal(faux.state.callCount, 2);
      assert.equal(fold(store.readSince(0)).projects.p?.holds[0]?.reason, "Main red");
    } finally {
      await Promise.all([server.close(), server.close()]);
    }
    assert.ok(store.sequence > 0, "the server does not close its caller's store");
  } finally {
    store.close();
  }
});
