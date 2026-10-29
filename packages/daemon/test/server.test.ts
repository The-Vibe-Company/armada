import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import type { EventInput } from "../src/events.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

const projects = [
  { id: "orchard", name: "Orchard", repository: "example/orchard" },
  { id: "harbor", name: "Harbor", repository: "example/harbor" },
];
const hold = (project = "orchard", id = "rain"): EventInput => ({
  project,
  kind: "hold.opened",
  at: "2030-01-01T10:00:00Z",
  actor: "Mira",
  payload: { id, reason: "Wait for CI" },
});

// Queue frames immediately, including replies that arrive together. No sleeps or polling.
async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: unknown[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (data) => {
    frames.push(JSON.parse(String(data)));
    wake?.();
  });
  await once(ws, "open");
  return {
    ws,
    send: (body: Record<string, unknown>) => ws.send(JSON.stringify({ version, id: "r1", ...body })),
    async next(): Promise<ServerMessage> {
      if (!frames.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
      return serverMessageSchema.parse(frames.shift());
    },
  };
}

test("armadad announces its address, serves without an app build and quits cleanly on SIGTERM", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-process-"));
  const catalog = join(dir, "projects.json");
  writeFileSync(catalog, JSON.stringify(projects));
  const child = spawn(
    "node",
    [
      new URL("../src/server/main.ts", import.meta.url).pathname,
      "--database",
      join(dir, "data", "fleet.sqlite"),
      "--projects",
      catalog,
      "--static-dir",
      join(dir, "missing"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const [ready] = await once(lines, "line");
  lines.close();
  const address = JSON.parse(ready);
  assert.equal((await fetch(address.url)).status, 404);
  const client = await connect(address.wsUrl);
  client.send({ type: "projects.list" });
  assert.deepEqual(await client.next(), { type: "projects.result", version, id: "r1", projects });
  const closed = once(client.ws, "close");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await closed;
  const reopened = new EventStore(join(dir, "data", "fleet.sqlite"));
  assert.deepEqual(reopened.readSince(0), []);
  reopened.close();
});

// Each transport scenario owns a real SQLite store and an OS-assigned loopback port.
test("subscription returns folded state then committed batches, isolated and replaced by project", async (t) => {
  const store = new EventStore(":memory:");
  const first = store.append(hold());
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "projects.list" });
  assert.deepEqual(await client.next(), { type: "projects.result", version, id: "r1", projects });
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  const subscribed = await client.next();
  assert.equal(subscribed.type, "project.subscribed");
  if (subscribed.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.deepEqual(subscribed.snapshot, {
    seq: first.seq,
    state: {
      tickets: [],
      pullRequests: [],
      sessions: [],
      sessionsByState: {
        blocked: [],
        "waiting-for-owner": [],
        "in-progress": [],
        "ready-to-merge": [],
        merged: [],
        released: [],
      },
      inbox: [],
      queue: [],
      holds: [{ id: "rain", reason: "Wait for CI", at: first.at, actor: "Mira" }],
      validations: [],
    },
  });
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: first.seq,
    events: [first],
  });
  const foreign = store.append(hold("harbor"));
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: foreign.seq,
    events: [],
  });
  const later = store.append(hold("orchard", "sun"));
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: later.seq,
    events: [later],
  });
  client.send({ type: "project.subscribe", project: "orchard", after: later.seq });
  const replacement = await client.next();
  assert.equal(replacement.type, "project.subscribed");
  if (replacement.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.notEqual(replacement.subscriptionId, subscribed.subscriptionId);
  assert.equal(replacement.snapshot, undefined);
  assert.equal((await client.next()).type, "events");
  const newest = store.append(hold("orchard", "snow"));
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: replacement.subscriptionId,
    project: "orchard",
    seq: newest.seq,
    events: [newest],
  });
  // An ordered reply is a barrier: no duplicate delivery from the old subscription.
  client.send({ type: "projects.list", id: "barrier" });
  assert.equal((await client.next()).type, "projects.result");
});

test("reconnect after daemon/store restart replays only later events and refuses a future cursor", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-server-"));
  const path = join(dir, "fleet.sqlite");
  let store = new EventStore(path);
  let server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = store.append(hold());
  const client = await connect(server.wsUrl);
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  assert.equal((await client.next()).type, "project.subscribed");
  const initial = await client.next();
  assert.equal(initial.type, "events");
  if (initial.type !== "events") throw new Error("Expected events");
  assert.equal(initial.seq, first.seq);
  await server.close();
  store.close();
  store = new EventStore(path);
  store.append(hold("harbor"));
  const later = store.append(hold("orchard", "sun"));
  server = await startServer({ store, projects });
  const resumed = await connect(server.wsUrl);
  resumed.send({ type: "project.subscribe", project: "orchard", after: initial.seq });
  const subscribed = await resumed.next();
  assert.equal(subscribed.type, "project.subscribed");
  if (subscribed.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.equal(subscribed.after, initial.seq);
  assert.equal(subscribed.snapshot, undefined);
  assert.deepEqual(await resumed.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: later.seq,
    events: [later],
  });
  resumed.send({ type: "project.subscribe", project: "orchard", after: later.seq + 1 });
  const refused = await resumed.next();
  assert.equal(refused.type, "error");
  if (refused.type !== "error") throw new Error("Expected error");
  assert.equal(refused.code, "invalid-message");
  const live = store.append(hold("orchard", "wind"));
  const frame = await resumed.next();
  assert.equal(frame.type, "events");
  if (frame.type !== "events") throw new Error("Expected events");
  assert.deepEqual(frame.events, [live]);
  assert.equal(frame.subscriptionId, subscribed.subscriptionId);
});

test("session history includes only the requested session and not-found does not install subscriptions", async (t) => {
  const store = new EventStore(":memory:");
  const event = store.append({
    project: "orchard",
    kind: "session.claimed",
    at: hold().at,
    actor: "Mira",
    payload: {
      ticket: "ORC-1",
      session: "s1",
      generation: 1,
      owner: "Mira",
      runtime: "codex",
      handle: "local",
    },
  });
  assert.equal(event.kind, "session.claimed");
  if (event.kind !== "session.claimed") throw new Error("Expected claim");
  store.append({ ...event, payload: { ...event.payload, session: "s2", generation: 2 } });
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "session.read", project: "orchard", sessionId: "s1" });
  assert.deepEqual(await client.next(), {
    type: "session.result",
    version,
    id: "r1",
    project: "orchard",
    sessionId: "s1",
    seq: 2,
    events: [event],
  });
  for (const request of [
    { type: "session.read", project: "orchard", sessionId: "missing" },
    { type: "session.read", project: "harbor", sessionId: "s1" },
    { type: "project.subscribe", project: "missing", after: 0 },
  ]) {
    client.send(request);
    const reply = await client.next();
    assert.equal(reply.type, "error");
    if (reply.type !== "error") throw new Error("Expected error");
    assert.equal(reply.code, "not-found");
  }
  store.append(hold());
  client.send({ type: "projects.list", id: "barrier" });
  assert.equal((await client.next()).type, "projects.result");
});

test("invalid requests recover; version refusal sends one line and closes before queued dispatch", async (t) => {
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  for (const raw of [
    "{",
    JSON.stringify({ version, id: "bad", type: "project.subscribe", project: "orchard", after: -1 }),
  ]) {
    client.ws.send(raw);
    const reply = await client.next();
    assert.equal(reply.type, "error");
    if (reply.type !== "error") throw new Error("Expected error");
    assert.equal(reply.code, "invalid-message");
  }
  client.send({ type: "projects.list" });
  assert.equal((await client.next()).type, "projects.result");
  const received: unknown[] = [];
  client.ws.on("message", (data) => received.push(JSON.parse(String(data))));
  const closed = once(client.ws, "close");
  client.send({ type: "obsolete", version: { major: 0, minor: 99 } });
  client.send({ type: "projects.list", id: "must-not-dispatch" });
  await closed;
  assert.deepEqual(received, [
    {
      type: "error",
      version,
      id: "r1",
      code: "app-too-old",
      message: "Armada app is older than the daemon: update it",
    },
  ]);
});

test("HTTP serves built assets and SPA routes, refuses escapes and foreign browser origins", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-static-"));
  const secret = join(tmpdir(), `armada-outside-${process.pid}.txt`);
  writeFileSync(join(dir, "index.html"), "<html>Armada</html>");
  writeFileSync(join(dir, "app.js"), "window.armada = true;");
  writeFileSync(secret, "private");
  symlinkSync(secret, join(dir, "escape.txt"));
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects, staticDir: dir });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret);
  });
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await page.text(), "<html>Armada</html>");
  const asset = await fetch(`${server.url}/app.js`);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await asset.text(), "window.armada = true;");
  assert.equal((await fetch(`${server.url}/project/orchard`, { headers: { accept: "text/html" } })).status, 200);
  for (const path of ["/missing.js", "/escape.txt", "/..%2fprivate.txt", "/%00"]) {
    assert.equal((await fetch(`${server.url}${path}`)).status, 404, path);
  }
  const allowed = new WebSocket(server.wsUrl, { origin: server.url });
  await once(allowed, "open");
  allowed.terminate();
  // Exercise the rejected HTTP upgrade directly: Bun 1.4.2's ws compatibility
  // client does not expose ws's Node-only unexpected-response event.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      server.url,
      {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          Origin: "https://foreign.example",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Foreign origin unexpectedly upgraded"));
    });
    request.end();
  });
  assert.equal(status, 403);
});
