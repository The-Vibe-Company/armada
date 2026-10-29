import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { coordinatorTools } from "../coordinator/index.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

test("daemon refuses invalid coordinator configuration, releases failed startup and exposes missing tools as refusals", async () => {
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
      fauxAssistantMessage(fauxToolCall("worker.launch", {}), { stopReason: "toolUse", timestamp: 0 }),
      async (transcript) => {
        assert.match(JSON.stringify(transcript.messages), /tool_unavailable/);
        return fauxAssistantMessage("Launching is unavailable", { timestamp: 0 });
      },
    ]);
    const server = await startServer({ store, projects, coordinators: [config] });
    try {
      const coordinator = server.coordinators.get("p");
      assert.ok(coordinator);
      const submission = await coordinator.conversation.submit({ type: "input", content: "Launch work" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      assert.equal(faux.state.callCount, 2);
    } finally {
      await Promise.all([server.close(), server.close()]);
    }
    assert.ok(store.sequence > 0, "the server does not close its caller's store");
  } finally {
    store.close();
  }
});
