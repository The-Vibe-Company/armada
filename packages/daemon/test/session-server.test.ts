import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import type { EventInput } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { startServer } from "../src/server/index.ts";
import { outputLines } from "../src/server/session.ts";
import { EventStore } from "../src/store.ts";
import { fakeWorkers } from "./support/fake-worker.ts";

// A session's page acts (THE-2045) over the real server and the daemon's own
// Workers, on a fake runtime: the owner answers a blocked worker's question,
// reads its output and releases it, each fenced to the generation it names.

const project = "orchard";
const projects = [{ id: project, name: "Orchard", repository: "example/orchard" }];
const AT = "2030-01-01T10:00:00.000Z";
const ticket = (id: string): EventInput => ({
  project,
  kind: "ticket.seen",
  at: AT,
  actor: "tracker",
  payload: {
    id,
    title: `Plant ${id}`,
    status: "unstarted",
    labels: ["ready-for-agent"],
    blockers: [],
    branchName: `feature/${id.toLowerCase()}`,
  },
});

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
  return {
    ws,
    async ask(body: Record<string, unknown>): Promise<ServerMessage> {
      const id = `r${++n}`;
      ws.send(JSON.stringify({ version, id, ...body }));
      for (;;) {
        const k = frames.findIndex((f) => "id" in f && f.id === id);
        if (k >= 0) return frames.splice(k, 1)[0] as ServerMessage;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

async function fixture(t: import("node:test").TestContext) {
  const store = new EventStore(":memory:");
  for (const id of ["ORC-1", "ORC-2"]) store.append(ticket(id));
  // A V1 session: the tracker's reading of a worker on another runtime.
  store.append({
    project,
    kind: "ticket.seen",
    at: AT,
    actor: "tracker",
    payload: { id: "ORC-9", title: "Prune", status: "started", phase: "implementing" },
  });
  const live = fakeWorkers(store, projects);
  const server = await startServer({ store, projects, workers: live.workers });
  const client = await connect(server.wsUrl);
  t.after(async () => {
    client.ws.close();
    await server.close();
    await live.workers.close();
    store.close();
  });
  const session = (id: string) =>
    fold(store.readSince(0, project)).projects[project]?.sessions.find((s) => s.ticket === id);
  return { store, live, client, session };
}

test("the owner answers a blocked worker's question once: delivered to its generation, then recorded", async (t) => {
  const { store, live, client, session } = await fixture(t);
  const worker = await live.launch(project, "ORC-1");
  await worker.ask("Sunrise or a fixed hour?\n\nOptions:\n- sunrise\n- fixed");
  assert.equal(session("ORC-1")?.state, "blocked");
  const item = fold(store.readSince(0, project)).projects[project]?.inbox.find((i) => i.kind === "question")?.id;
  assert.ok(item);

  const answer = { type: "owner.answer", project, item, choice: "sunrise", note: "Use the harbour's table" };
  assert.deepEqual(await client.ask(answer), { type: "owner.answered", version, id: "r1", project, item });
  const answered = live.fake.delivered.filter((d) => d.key === `owner-answer:${item}`);
  assert.deepEqual(
    answered.map((d) => [d.session, d.message]),
    [[worker.session, "sunrise\n\nNote: Use the harbour's table"]],
  );
  assert.equal(store.readSince(0, project).findLast((e) => e.kind === "inbox.answered")?.actor, "owner");

  // The same answer again is answered, not delivered again; another one is refused.
  assert.equal((await client.ask(answer)).type, "owner.answered");
  assert.equal(live.fake.delivered.filter((d) => d.key === `owner-answer:${item}`).length, 1);
  const other = await client.ask({ ...answer, choice: "fixed" });
  assert.equal(other.type === "error" && other.message, "This question was already answered");
});

test("a question from an earlier claim, or of an ended worker, is not delivered", async (t) => {
  const { store, live, client } = await fixture(t);
  const worker = await live.launch(project, "ORC-1");
  await worker.ask("Which orchard row first?");
  const item = fold(store.readSince(0, project)).projects[project]?.inbox[0]?.id;
  assert.ok(item);
  const released = await client.ask({
    type: "session.release",
    project,
    ticket: "ORC-1",
    session: worker.session,
    generation: worker.generation,
    reason: "Asked the wrong row",
  });
  assert.equal(released.type, "session.release.result");
  const late = await client.ask({ type: "owner.answer", project, item, choice: "The first" });
  assert.equal(late.type === "error" && late.message, "The runtime worker has ended; no answer was delivered");
  assert.equal(live.fake.delivered.filter((d) => d.key.startsWith("owner-answer:")).length, 0);
});

test("the owner reads a worker's output: its last lines, cleaned and masked, from the runtime's observe", async (t) => {
  const { live, client } = await fixture(t);
  const worker = await live.launch(project, "ORC-1");
  live.fake.output.set(
    worker.session,
    `${Array.from({ length: 250 }, (_, k) => `line ${k}`).join("\n")}\n\x1b[32mtests pass\x1b[0m\nprogress 10%\rprogress 100%\ntoken ${worker.token}\n`,
  );
  const read = await client.ask({ type: "session.output", project, ticket: "ORC-1", session: worker.session });
  assert.equal(read.type, "session.output.result");
  if (read.type !== "session.output.result") return;
  assert.equal(read.state, "running");
  assert.equal(read.lines.length, 200);
  assert.deepEqual(read.lines.slice(-4), ["line 249", "tests pass", "progress 100%", "token [redacted]"]);
  assert.equal(read.lines.join("\n").includes(worker.token), false);

  const other = await client.ask({ type: "session.output", project, ticket: "ORC-1", session: "s-another" });
  assert.equal(other.type === "error" && other.message, "ORC-1's worker generation changed; open its current session");
});

test("the owner releases exactly the named generation, never a replacement nor a V1 session", async (t) => {
  const { live, client, session } = await fixture(t);
  const worker = await live.launch(project, "ORC-2");
  const release = {
    type: "session.release",
    project,
    ticket: "ORC-2",
    session: worker.session,
    generation: worker.generation,
    reason: "Superseded by ORC-1",
  };
  const stale = await client.ask({ ...release, generation: worker.generation + 1 });
  assert.equal(stale.type === "error" && stale.message, "ORC-2's worker generation changed; nothing was released");
  assert.equal(live.fake.stopped.length, 0);

  const released = await client.ask(release);
  assert.deepEqual(released, {
    type: "session.release.result",
    version,
    id: "r2",
    project,
    ticket: "ORC-2",
    session: worker.session,
    disposed: true,
  });
  assert.deepEqual(
    live.fake.stopped.map((r) => [r.session, r.generation]),
    [[worker.session, worker.generation]],
  );
  assert.equal(session("ORC-2")?.phase, "released");
  assert.equal(session("ORC-2")?.reason, "Superseded by ORC-1");
  const again = await client.ask(release);
  assert.equal(again.type === "error" && again.message, "ORC-2's worker is already released");

  const v1 = session("ORC-9");
  assert.equal(v1?.runtime, "tracker");
  const refused = await client.ask({ ...release, ticket: "ORC-9", session: v1?.session, generation: 1 });
  assert.equal(
    refused.type === "error" && refused.message,
    "ORC-9 runs on a V1 runtime: release it there with armada stop",
  );
  assert.equal(live.fake.stopped.length, 1);
});

test("a terminal's output reads as its screen: control sequences out, a carriage return's last write kept", () => {
  assert.deepEqual(outputLines("\x1b]0;title\x07a\tb \x1b[1mbold\x1b[22m\r\nloading…\rdone\n\n"), [
    "a\tb bold",
    "done",
  ]);
});
