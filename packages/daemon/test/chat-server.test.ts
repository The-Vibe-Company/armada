import assert from "node:assert/strict";
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
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

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
      setTimer: () => () => {},
    },
  };
}

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
