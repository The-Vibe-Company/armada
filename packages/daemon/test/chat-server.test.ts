import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ChatItem, type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import type { EventInput } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { Keychain } from "../src/keychain.ts";
import { ModelRegistry } from "../src/models/registry.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { type ChatOptions, dispatchChat, textOf } from "../src/server/chat.ts";
import { startServer } from "../src/server/index.ts";
import { coordinatorModels } from "../src/server/models.ts";
import { EventStore } from "../src/store.ts";
import { FakeKeychain } from "./support/keychain.ts";

// A project's room (THE-1996) over the real server, a file log and a faux model:
// a message sent through the protocol becomes the coordinator's input, its answer
// and tool calls come back as the room's items, and they survive a restart.

const projects = [{ id: "orchard", name: "Orchard", repository: "example/orchard" }];
const NOW = Date.parse("2030-01-01T10:00:00.000Z");
/** The coordinator's clock: moved by hand, never read from the wall. */
let clock = NOW;
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const seed = (kind: EventInput["kind"], payload: unknown, minutes = 0, actor = "worker") =>
  ({ project: "orchard", kind, at: at(minutes), actor, payload }) as EventInput;

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
  /** Sends one request and returns its own reply; subscription frames are not asked for here. */
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

/** What the room reads, without ids (pi's own), times or the tools' JSON. */
const reading = (items: readonly ChatItem[]) =>
  items.map((i) =>
    i.kind === "tool" ? `tool ${i.name} ${i.failed ? "failed" : i.output ? "ok" : "running"}` : `${i.kind}: ${i.body}`,
  );

function coordinator(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ models: [{ id: "room" }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    config: {
      project: "orchard",
      models,
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      now: () => clock,
      setTimer: (_callback: () => void, _delay: number) => () => {},
    },
  };
}

test("a pi selection configures a room after startup, switches the next turn, and keeps provider errors out of checkpoints", {
  timeout: 10000,
}, async (t) => {
  const first = fauxProvider({ provider: "orchard-one", models: [{ id: "small" }] });
  const second = fauxProvider({ provider: "orchard-two", models: [{ id: "large" }] });
  const token = randomBytes(24).toString("hex");
  let releaseFirst = () => {};
  let firstStarted = () => {};
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let firstSignal: AbortSignal | undefined;
  first.setResponses([
    async (_transcript, options) => {
      firstSignal = options?.signal;
      firstStarted();
      return new Promise((resolve) => {
        releaseFirst = () => resolve(fauxAssistantMessage("First provider answer"));
      });
    },
  ]);
  second.setResponses([
    fauxAssistantMessage("Second provider answer"),
    {
      ...fauxAssistantMessage("", { stopReason: "error", errorMessage: token }),
      diagnostics: [
        { type: "provider-error", timestamp: NOW, error: { message: token, stack: token }, details: { body: token } },
      ],
    },
  ]);
  const keychain = new Keychain(new FakeKeychain());
  const pi = new ModelRegistry({ keychain, env: {}, providers: [first.provider, second.provider] });
  const store = new EventStore(":memory:");
  const registry = new PluginRegistry();
  const server = await startServer({
    store,
    projects,
    keychain,
    modelRegistry: pi,
    resolveCoordinator: async () =>
      coordinatorModels({
        projects,
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
  const before = await client.ask({ type: "chat.read", project: "orchard" });
  assert.equal(before.type === "chat.result" && before.coordinator, false);
  assert.equal(
    (await client.ask({ type: "models.select", provider: "orchard-one", model: "small" })).type,
    "models.catalog",
  );
  assert.equal(
    (await client.ask({ type: "chat.send", project: "orchard", requestId: "one", body: "First" })).type,
    "chat.sent",
  );
  await started;
  assert.equal(
    (await client.ask({ type: "models.select", provider: "orchard-two", model: "large" })).type,
    "models.catalog",
  );
  const nextTurn = client.ask({ type: "chat.send", project: "orchard", requestId: "two", body: "Second" });
  assert.equal(firstSignal?.aborted, false);
  assert.equal(second.state.callCount, 0);
  releaseFirst();
  assert.equal((await nextTurn).type, "chat.sent");
  await server.coordinators.get("orchard")?.harness.waitForIdle(context);
  const two = await client.ask({ type: "chat.read", project: "orchard" });
  assert.ok(two.type === "chat.result");
  assert.ok(two.items.some((i) => i.kind === "coordinator" && i.body === "First provider answer"));
  assert.ok(two.items.some((i) => i.kind === "coordinator" && i.body === "Second provider answer"));
  assert.equal(second.state.callCount, 1);
  assert.equal(first.state.callCount, 1);
  assert.deepEqual(await keychain.coordinator(), { provider: "orchard-two", model: "large" });
  assert.equal(
    (await client.ask({ type: "chat.send", project: "orchard", requestId: "failed", body: "Fail" })).type,
    "chat.sent",
  );
  await server.coordinators.get("orchard")?.harness.waitForIdle(context);
  assert.equal(JSON.stringify(store.readSince(0)).includes(token), false);
});

test("the room sends the owner's message to the coordinator and reads its answer and tool calls, after a restart too", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-room-"));
  const file = join(dir, "fleet.sqlite");
  let store = new EventStore(file);
  // Set below; closed here too when an assertion fails half way.
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  t.after(async () => {
    client?.ws.close();
    await server?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const event of [
    seed("ticket.seen", { id: "ORC-1", title: "Prune the orchard", status: "started" }, 0, "tracker"),
    seed("session.claimed", {
      ticket: "ORC-1",
      session: "s-orc-1",
      generation: 1,
      owner: "default",
      runtime: "codex",
      handle: "h",
    }),
    seed("inbox.opened", {
      id: "ask-1",
      ticket: "ORC-1",
      kind: "owner-request",
      body: "Which rows?\n\nOptions:\n1. North\n2. South",
    }),
    seed("inbox.opened", { id: "q-1", ticket: "ORC-1", kind: "question", body: "Which saw?" }),
  ])
    store.append(event);

  const { faux, config } = coordinator([
    fauxAssistantMessage(
      [
        { type: "text", text: "Reading the fleet first." },
        fauxToolCall("fleet.status", {}, { id: "status" }),
        fauxToolCall("hold.add", { reason: " " }, { id: "hold" }),
      ],
      { stopReason: "toolUse", timestamp: NOW + 1000 },
    ),
    fauxAssistantMessage("Merging #12 now; #14 after its checks.", { timestamp: NOW + 2000 }),
    fauxAssistantMessage("Telling ORC-1's worker: North.", { timestamp: NOW + 11 * 60_000 }),
  ]);
  server = await startServer({ store, projects, coordinators: [config] });
  client = await connect(server.wsUrl);
  const idle = () => server?.coordinators.get("orchard")?.harness.waitForIdle(context);

  const before = store.sequence;
  const send = { type: "chat.send", project: "orchard", requestId: "message-1", body: "Merge #12 first, then #14." };
  const sent = await client.ask(send);
  assert.equal(sent.type, "chat.sent");
  await idle();
  // The message is appended as the coordinator's checkpoint, in the one log.
  assert.ok(
    store.readSince(before, "orchard").some((e) => e.kind === "coordinator.checkpoint" && e.actor === "coordinator"),
  );

  // Sent again after a drop, the same requestId is the same input: no second run.
  assert.equal((await client.ask(send)).type, "chat.sent");
  await idle();
  assert.equal(faux.state.callCount, 2);

  store.append(seed("coordinator.message", { role: "coordinator", body: "#12 merged. ORC-1 done." }, 5, "coordinator"));
  const read = await client.ask({ type: "chat.read", project: "orchard" });
  assert.equal(read.type, "chat.result");
  if (read.type !== "chat.result") return;
  assert.equal(read.coordinator, true);
  assert.deepEqual(reading(read.items), [
    "owner: Merge #12 first, then #14.",
    "coordinator: Reading the fleet first.",
    "tool fleet.status ok",
    "tool hold.add failed",
    "coordinator: Merging #12 now; #14 after its checks.",
    "line: #12 merged. ORC-1 done.",
  ]);
  const status = read.items.find((i) => i.kind === "tool" && i.name === "fleet.status");
  assert.match(status?.kind === "tool" ? (status.output ?? "") : "", /ORC-1/);

  clock = NOW + 10 * 60_000;
  // The owner answers the pinned question: recorded as theirs, then handed to the coordinator.
  const worker = await client.ask({ type: "owner.answer", project: "orchard", item: "q-1", choice: "North" });
  assert.deepEqual(worker.type === "error" && worker.code, "not-found");
  const answered = await client.ask({
    type: "owner.answer",
    project: "orchard",
    item: "ask-1",
    choice: "North",
    note: "Start at the gate",
  });
  assert.equal(answered.type, "owner.answered");
  const inbox = fold(store.readSince(0, "orchard")).projects.orchard?.inbox ?? [];
  assert.deepEqual(
    inbox.map((i) => i.id),
    ["q-1"],
  );
  const answer = store.readSince(0, "orchard").find((e) => e.kind === "inbox.answered");
  assert.equal(answer?.actor, "owner");
  assert.deepEqual(answer?.payload, { id: "ask-1", answer: "North\n\nNote: Start at the gate" });
  await idle();
  const again = await client.ask({ type: "owner.answer", project: "orchard", item: "ask-1", choice: "South" });
  assert.match(again.type === "error" ? again.message : "", /already answered/);
  // The same answer again tells the coordinator again, which pi admits once: no new turn.
  const repeated = await client.ask({
    type: "owner.answer",
    project: "orchard",
    item: "ask-1",
    choice: "North",
    note: "Start at the gate",
  });
  assert.equal(repeated.type, "owner.answered");
  await idle();
  assert.equal(faux.state.callCount, 3);
  const after = await client.ask({ type: "chat.read", project: "orchard" });
  assert.ok(after.type === "chat.result");
  const conversation = after.type === "chat.result" ? after.items : [];
  assert.deepEqual(reading(conversation).slice(-2), [
    "owner: On ORC-1: North. Start at the gate",
    "coordinator: Telling ORC-1's worker: North.",
  ]);

  // Closed and reopened on the same file: the same conversation, nothing asked of the model.
  client.ws.close();
  await server.close();
  store.close();
  store = new EventStore(file);
  const reopened = coordinator([]);
  server = await startServer({ store, projects, coordinators: [reopened.config] });
  client = await connect(server.wsUrl);
  const restored = await client.ask({ type: "chat.read", project: "orchard" });
  assert.deepEqual(restored.type === "chat.result" && restored.items, conversation);
  assert.equal(reopened.faux.state.callCount, 0);
  client.ws.close();
  await server.close();
});

test("without a coordinator the room reads the log's lines and refuses to send", async (t) => {
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  store.append(seed("coordinator.message", { role: "coordinator", body: "ORC-2 handed back #9" }, 1, "coordinator"));
  const client = await connect(server.wsUrl);
  const read = await client.ask({ type: "chat.read", project: "orchard" });
  assert.deepEqual(read.type === "chat.result" && [read.coordinator, reading(read.items)], [
    false,
    ["line: ORC-2 handed back #9"],
  ]);
  const refused = await client.ask({ type: "chat.send", project: "orchard", requestId: "m", body: "Hello" });
  assert.equal(refused.type === "error" && refused.code, "not-found");
  assert.match(refused.type === "error" ? refused.message : "", /No coordinator runs for this project/);
  // The owner's answer is still recorded without a coordinator to tell.
  store.append(seed("inbox.opened", { id: "ask-2", ticket: "ORC-2", kind: "owner-request", body: "Ship it?" }));
  const answered = await client.ask({ type: "owner.answer", project: "orchard", item: "ask-2", choice: "Yes" });
  assert.equal(answered.type, "owner.answered");
  assert.deepEqual(fold(store.readSince(0, "orchard")).projects.orchard?.inbox, []);
  const unknown = await client.ask({ type: "chat.read", project: "nowhere" });
  assert.equal(unknown.type === "error" && unknown.code, "not-found");
  client.ws.close();
});

test("Stop preserves pi's committed partial and reasoning with the live id after restart", {
  timeout: 5000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-room-stop-"));
  const file = join(dir, "fleet.sqlite");
  let store = new EventStore(file);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  t.after(async () => {
    client?.ws.terminate();
    await server?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  const { faux, config } = coordinator([]);
  let providerAborts = 0;
  config.models.setProvider({
    ...faux.provider,
    streamSimple(_model, _transcript, options) {
      const stream = new AssistantMessageEventStream();
      const message = fauxAssistantMessage(
        [
          { type: "text", text: "Checking one tree" },
          { type: "thinking", thinking: "Count the rows" },
        ],
        { timestamp: NOW },
      );
      stream.push({ type: "start", partial: message });
      options?.signal?.addEventListener(
        "abort",
        () => {
          providerAborts++;
          stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
        },
        { once: true },
      );
      return stream;
    },
  });
  // Exercise the daemon registry's stream boundary too: Stop must retain the partial.
  config.models = new ModelRegistry({
    keychain: new Keychain(new FakeKeychain()),
    env: {},
    providers: config.models.getProviders(),
  }).models;
  // Flush pi's progress commit on an injected microtask, with no real-time sleep.
  config.setTimer = (callback: () => void, delay: number) => {
    let cancelled = false;
    if (delay === 100)
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
    return () => {
      cancelled = true;
    };
  };
  server = await startServer({
    store,
    projects,
    coordinators: [config],
    chatClock: {
      now: () => NOW,
      setTimer(callback) {
        queueMicrotask(callback);
        return () => {};
      },
    },
  });
  client = await connect(server.wsUrl);
  const live: ServerMessage[] = [];
  let sawPartial!: () => void;
  const partial = new Promise<void>((resolve) => {
    sawPartial = resolve;
  });
  client.ws.on("message", (data) => {
    const frame = serverMessageSchema.parse(JSON.parse(String(data)));
    live.push(frame);
    if (frame.type === "chat.delta" && frame.kind === "text") sawPartial();
  });
  await client.ask({ type: "project.subscribe", project: "orchard", after: 0 });
  await client.ask({ type: "chat.send", project: "orchard", requestId: "stop-message", body: "Check the trees" });
  await partial;
  const delta = live.find((f) => f.type === "chat.delta" && f.kind === "text");
  assert.ok(delta?.type === "chat.delta");
  const stopped = await client.ask({ type: "chat.stop", project: "orchard" });
  assert.equal(stopped.type, "chat.stopped");
  assert.equal(providerAborts, 1);
  const read = await client.ask({ type: "chat.read", project: "orchard" });
  assert.ok(read.type === "chat.result");
  const answer = read.items.find((i) => i.kind === "coordinator");
  assert.ok(answer?.kind === "coordinator");
  assert.equal(answer.id, delta.id);
  assert.equal(answer.body, "Checking one tree");
  assert.equal(answer.reasoning, "Count the rows");
  assert.equal(answer.aborted, true);
  client.ws.close();
  await server.close();
  store.close();
  store = new EventStore(file);
  server = await startServer({ store, projects, coordinators: [coordinator([]).config] });
  client = await connect(server.wsUrl);
  const restored = await client.ask({ type: "chat.read", project: "orchard" });
  assert.deepEqual(restored.type === "chat.result" && restored.items, read.items);
});

test("a message sent while the coordinator works steers it by default, and waits for the run's end when queued", async () => {
  const drafts: unknown[] = [];
  const coordinator = { conversation: { submit: async (draft: unknown) => void drafts.push(draft) } };
  const options = { coordinator, store: undefined, live: undefined } as unknown as ChatOptions;
  const send = { version, type: "chat.send", project: "orchard", body: "Merge #12 first." } as const;
  const steered = await dispatchChat({ ...send, id: "r1", requestId: "m1" }, options);
  assert.equal(steered.type, "chat.sent");
  const queued = await dispatchChat({ ...send, id: "r2", requestId: "m2", whenBusy: "queue" }, options);
  assert.equal(queued.type, "chat.sent");
  assert.deepEqual(
    drafts.map((d) => (d as { requestId: string; whenBusy: string }).whenBusy),
    ["steer", "followUp"],
  );
});

test("the harness carries a French ticket report and an idle wake's quiet line into the room", async (t) => {
  const timestamp = clock + 1000;
  const store = new EventStore(":memory:");
  for (const [id, title] of [
    ["ORC-1", "Plant seeds"],
    ["ORC-2", "Water seedlings"],
  ]) {
    store.append(seed("ticket.seen", { id, title, status: "started" }, 0, "tracker"));
    store.append(
      seed("session.claimed", {
        ticket: id,
        session: `s-${id}`,
        generation: 1,
        owner: "default",
        runtime: "codex",
        handle: `h-${id}`,
      }),
    );
  }
  // A faux model tests the harness/projection contract, not real-model instruction following.
  const { config } = coordinator([
    fauxAssistantMessage([fauxToolCall("fleet.status", {}, { id: "report-status" })], {
      stopReason: "toolUse",
      timestamp,
    }),
    fauxAssistantMessage([fauxToolCall("inbox.list", {}, { id: "report-inbox" })], {
      stopReason: "toolUse",
      timestamp,
    }),
    (transcript) => {
      const input = JSON.stringify(transcript);
      assert.match(input, /qu'est-ce qui tourne/);
      assert.match(input, /at most five lines/);
      const status = transcript.messages.find((m) => m.role === "toolResult" && m.toolName === "fleet.status");
      assert.ok(status?.role === "toolResult");
      const facts = JSON.parse(textOf(status.content));
      assert.equal(facts.ok, true);
      assert.deepEqual(
        facts.sessions.map((session: { ticket: string }) => session.ticket),
        ["ORC-1", "ORC-2"],
      );
      return fauxAssistantMessage(
        "Fusionné : aucun ticket.\nEn cours : ORC-1 et ORC-2.\nDécision : les sessions continuent.\nAucune action nécessaire.",
        { timestamp: timestamp + 1000 },
      );
    },
    fauxAssistantMessage("Rien de nouveau pour ORC-1 et ORC-2, aucune action nécessaire.", {
      timestamp: timestamp + 2000,
    }),
  ]);
  const server = await startServer({ store, projects, coordinators: [config] });
  const client = await connect(server.wsUrl);
  t.after(async () => {
    client.ws.terminate();
    await server.close();
    store.close();
  });
  assert.equal(
    (
      await client.ask({
        type: "chat.send",
        project: "orchard",
        requestId: "french-report",
        body: "qu'est-ce qui tourne ?",
      })
    ).type,
    "chat.sent",
  );
  const agent = server.coordinators.get("orchard");
  assert.ok(agent);
  await agent.harness.waitForIdle(context);
  const read = await client.ask({ type: "chat.read", project: "orchard" });
  assert.ok(read.type === "chat.result");
  assert.deepEqual(
    read.items.filter((i) => i.kind === "tool").map((i) => i.name),
    ["fleet.status", "inbox.list"],
  );
  const report = read.items.at(-1);
  assert.ok(report?.kind === "coordinator", JSON.stringify(reading(read.items)));
  const lines = report.body.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? "", /^Fusionné :/);
  assert.match(lines[1] ?? "", /^En cours : ORC-1 et ORC-2/);
  assert.match(lines[2] ?? "", /^Décision :/);
  assert.match(lines[3] ?? "", /^Aucune action nécessaire/);
  await agent.conversation.submit(
    {
      type: "input",
      content: "No fleet change requires action.",
      entry: { kind: "armada.fleet-wake", data: {} },
    },
    context,
  );
  await agent.harness.waitForIdle(context);
  const wake = await client.ask({ type: "chat.read", project: "orchard" });
  assert.ok(wake.type === "chat.result");
  const quiet = wake.items.at(-1);
  assert.ok(quiet?.kind === "line");
  assert.equal(quiet.body.split("\n").length, 1);
  assert.match(quiet.body, /^Rien de nouveau pour ORC-1 et ORC-2/);
});
