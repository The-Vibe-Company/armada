// A daemon host with an injected fake model. Parent kills it at stdout gates, never a clock delay.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

const [file, mode, interruption] = process.argv.slice(2);
if (!file) throw new Error("database required");
const store = new EventStore(file);
const faux = fauxProvider({ models: [{ id: "coordinator-test" }] });
const models = createModels();
models.setProvider(faux.provider);
const send = (value: unknown) => console.log(JSON.stringify(value));
const paused = () => new Promise<never>(() => {});
const now = () => Date.parse("2026-10-29T18:45:00.000Z");
const tool = defineTool({
  name: "fleet.status",
  description: "Read the test fleet",
  parameters: Type.Object({}),
  replay: "unsafe",
  async execute() {
    send({ type: "tool" });
    if (interruption === "tool") {
      send({ type: "paused" });
      return paused();
    }
    return { output: [{ type: "text", text: '{"sessions":1}' }] };
  },
});
const final = fauxAssistantMessage("All done", { timestamp: now() });
if (mode === "start") {
  faux.setResponses([
    fauxAssistantMessage("I will check the fleet", { timestamp: now() }),
    fauxAssistantMessage(fauxToolCall("fleet.status", {}, { id: "fleet-call" }), {
      stopReason: "toolUse",
      timestamp: now(),
    }),
    async (transcript) => {
      send({ type: "paused", messages: transcript.messages });
      return paused();
    },
  ]);
} else {
  faux.setResponses([
    async (transcript) => {
      send({ type: "resumed-context", messages: transcript.messages });
      return final;
    },
  ]);
}
const options = {
  project: "p",
  models,
  model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
  tools: { "fleet.status": tool },
  now,
  setTimer: () => () => {},
};
const server = await startServer({
  store,
  projects: [{ id: "p", name: "Project", repository: "example/project" }],
  coordinators: [options],
});
const coordinator = server.coordinators.get("p");
if (!coordinator) throw new Error("coordinator missing from server");
const { conversation, harness } = coordinator;
if (mode === "start") {
  await (await conversation.submit({ type: "input", content: "Plan the work", requestId: "first" }, context)).wait(
    context,
  );
  await conversation.submit({ type: "input", content: "Check the fleet", requestId: "second" }, context);
} else {
  await harness.waitForIdle(context);
  // Retrying an admitted request after a client reconnect must not start another run.
  await (await conversation.submit({ type: "input", content: "Check the fleet", requestId: "second" }, context)).wait(
    context,
  );
  const history = await conversation.entries({ order: "ascending" }, 100, undefined, context);
  send({ type: "done", entries: history.items, calls: faux.state.callCount });
  await server.close();
  store.close();
}
