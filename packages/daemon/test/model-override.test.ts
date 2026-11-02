import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { fold } from "../src/fold.ts";
import { Keychain } from "../src/keychain.ts";
import { ModelRegistry } from "../src/models/registry.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { startServer } from "../src/server/index.ts";
import { coordinatorModels } from "../src/server/models.ts";
import { EventStore } from "../src/store.ts";
import { FakeKeychain } from "./support/keychain.ts";

// The room's model picker (THE-2128, protocol minor 24): `models.select` naming
// a project whose rules hold their own coordinator model edits that override,
// as one rules checkpoint, and the project's next turn runs on it; a project
// without one changes the shared selection, as Settings does.

const projects = [
  { id: "orchard", name: "Orchard", repository: "example/orchard" },
  { id: "meadow", name: "Meadow", repository: "example/meadow" },
];
const AT = "2030-01-01T10:00:00.000Z";

async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: ServerMessage[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (data) => {
    frames.push(serverMessageSchema.parse(JSON.parse(String(data))));
    wake?.();
  });
  await once(ws, "open");
  let n = 0;
  async function ask(body: Record<string, unknown>): Promise<ServerMessage> {
    const id = `r${++n}`;
    ws.send(JSON.stringify({ version, id, ...body }));
    for (;;) {
      const k = frames.findIndex((f) => "id" in f && f.id === id);
      if (k >= 0) return frames.splice(k, 1)[0] as ServerMessage;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return { ws, ask };
}

test("a project's own coordinator model is edited from its room; another project's choice is the shared one", {
  timeout: 10000,
}, async (t) => {
  const first = fauxProvider({ provider: "orchard-one", models: [{ id: "small" }] });
  const second = fauxProvider({ provider: "orchard-two", models: [{ id: "large" }] });
  first.setResponses([fauxAssistantMessage("First provider answer")]);
  second.setResponses([fauxAssistantMessage("Second provider answer")]);
  const keychain = new Keychain(new FakeKeychain());
  const pi = new ModelRegistry({ keychain, env: {}, providers: [first.provider, second.provider] });
  const store = new EventStore(":memory:");
  // Orchard's rules name their own model (and a policy the edit must keep).
  store.append({
    project: "orchard",
    kind: "coordinator.checkpoint",
    at: AT,
    actor: "coordinator",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: {
          revision: 1,
          value: { coordinatorModel: { provider: "orchard-one", model: "small" }, policy: { quietMinutes: 30 } },
        },
        reason: "triage on the small model",
      },
    },
  });
  const registry = new PluginRegistry();
  const server = await startServer({
    store,
    projects,
    keychain,
    modelRegistry: pi,
    resolveCoordinator: async (project) =>
      coordinatorModels({
        projects: projects.filter((p) => p.id === project),
        store,
        registry,
        pi,
        selected: (await pi.selection()) ?? undefined,
      })[0],
  });
  const client = await connect(server.wsUrl);
  t.after(async () => {
    client.ws.terminate();
    await server.close();
    store.close();
  });
  const rulesOf = (project: string) => fold(store.readSince(0)).projects[project]?.rules;

  // A shared selection exists; orchard's override is what its room edits.
  assert.equal(
    (await client.ask({ type: "models.select", provider: "orchard-one", model: "small" })).type,
    "models.catalog",
  );
  assert.equal(
    (await client.ask({ type: "models.select", provider: "orchard-two", model: "large", project: "orchard" })).type,
    "models.catalog",
  );
  assert.deepEqual(rulesOf("orchard"), {
    revision: 2,
    value: { coordinatorModel: { provider: "orchard-two", model: "large" }, policy: { quietMinutes: 30 } },
  });
  assert.deepEqual(await keychain.coordinator(), { provider: "orchard-one", model: "small" });
  const edit = store.readSince(0, "orchard").findLast((e) => JSON.stringify(e.payload).includes('"type":"rules"'));
  assert.equal(edit?.actor, "owner");

  // The project's next turn runs on its new model, without a restart.
  assert.equal(
    (await client.ask({ type: "chat.send", project: "orchard", requestId: "one", body: "Status?" })).type,
    "chat.sent",
  );
  await server.coordinators.get("orchard")?.harness.waitForIdle(context);
  assert.equal(second.state.callCount, 1);
  assert.equal(first.state.callCount, 0);

  // Meadow has no override: its room changes the shared selection, and writes no rules.
  assert.equal(
    (await client.ask({ type: "models.select", provider: "orchard-two", model: "large", project: "meadow" })).type,
    "models.catalog",
  );
  assert.deepEqual(await keychain.coordinator(), { provider: "orchard-two", model: "large" });
  assert.equal(rulesOf("meadow")?.revision ?? 0, 0);

  // An unknown model is refused before anything is written.
  const refused = await client.ask({
    type: "models.select",
    provider: "orchard-two",
    model: "huge",
    project: "orchard",
  });
  assert.equal(refused.type, "error");
  assert.equal(rulesOf("orchard")?.revision, 2);
});
