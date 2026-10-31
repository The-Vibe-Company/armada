import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { PROTOCOL_VERSION as version } from "@armada/protocol";
import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { WebSocket } from "ws";
import { Coordinators, coordinatorTools } from "../coordinator/index.ts";
import { fold } from "../src/fold.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

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

test("project removal closes an active coordinator before joining a pending model switch", {
  timeout: 5000,
}, async (t) => {
  const store = new EventStore(":memory:");
  const faux = fauxProvider({ models: [{ id: "old" }, { id: "new" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const tool = defineTool({
    name: "fleet.status",
    description: "A cancellable pending read",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, _api, callContext) {
      entered();
      await awaitWithContext(new Promise<void>(() => {}), callContext);
      return { output: [{ type: "text", text: "done" }] };
    },
  });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("fleet.status", {})], { stopReason: "toolUse" })]);
  const config = {
    project: "p",
    models,
    model: { provider: faux.getModel().provider, modelId: "old" },
    tools: { "fleet.status": tool },
  };
  const server = await startServer({
    store,
    projects: [{ id: "p", name: "Project", repository: "example/project" }],
    coordinators: [config],
    resolveCoordinator: async () => ({ ...config, model: { ...config.model, modelId: "new" } }),
  });
  const ws = new WebSocket(server.wsUrl);
  const opened = once(ws, "open");
  t.after(async () => {
    ws.close();
    await server.close();
    store.close();
  });
  const coordinator = server.coordinators.get("p");
  assert.ok(coordinator);
  await coordinator.conversation.submit({ type: "input", content: "Read until cancelled" }, context);
  await running;
  let waiting!: () => void;
  const switching = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const idle = coordinator.harness.waitForIdle.bind(coordinator.harness);
  t.mock.method(coordinator.harness, "waitForIdle", (ctx: Parameters<typeof idle>[0]) => {
    waiting();
    return idle(ctx);
  });
  await opened;
  ws.send(
    JSON.stringify({
      type: "chat.send",
      version,
      id: "queued",
      project: "p",
      requestId: "queued-input",
      body: "Switch model",
    }),
  );
  await switching;
  t.diagnostic("model switch is waiting for the active turn before removal");
  await server.closeProject("p");
  assert.equal(server.coordinators.has("p"), false);
});
