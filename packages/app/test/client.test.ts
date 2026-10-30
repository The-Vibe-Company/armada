import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  APP_TOO_OLD,
  type ClientMessage,
  DAEMON_TOO_OLD,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type ProtocolVersion,
} from "@armada/protocol";
import {
  createDaemonClient,
  LOG_BEHIND,
  NOT_FOLDED,
  type SocketLike,
  UNREADABLE,
  unusableAddress,
} from "../src/protocol/client";

const V = PROTOCOL_VERSION;

/** A daemon's socket the test drives: what the client sent, and frames to hand it. */
class FakeSocket implements SocketLike {
  sent: ClientMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.onclose?.();
  }
}

function setup({
  version = V,
  refuseOpen = false,
  url = "ws://daemon.test/",
}: {
  version?: ProtocolVersion;
  refuseOpen?: boolean;
  url?: string;
} = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number; canceled: boolean }[] = [];
  const client = createDaemonClient({
    url,
    version,
    open: (url) => {
      if (refuseOpen) throw new SyntaxError(`bad address ${url}`);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (run, ms) => {
      const timer = { run, ms, canceled: false };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
    backoff: [100, 400],
  });
  client.start();
  const socket = () => sockets.at(-1) as FakeSocket;
  socket()?.onopen?.();
  return { client, sockets, timers, socket };
}

const event = (seq: number, project: string, session: string, kind = "session.claimed"): ProtocolEvent => ({
  seq,
  project,
  kind,
  at: "2026-01-05T09:00:00.000Z",
  actor: "worker",
  payload: { ticket: "EX-1", session },
});
const projects = [
  { id: "alpha", name: "Alpha", repository: "example/alpha" },
  { id: "beta", name: "Beta", repository: "example/beta" },
];

function listAndSubscribe(socket: FakeSocket) {
  const list = socket.sent.find((m) => m.type === "projects.list");
  socket.receive({ type: "projects.result", version: V, id: list?.id, projects });
  for (const m of socket.sent)
    if (m.type === "project.subscribe")
      socket.receive({ ...m, type: "project.subscribed", subscriptionId: `sub-${m.project}` });
}

describe("the daemon client", () => {
  test("lists the projects, then subscribes to each from the beginning", () => {
    const { client, socket } = setup();
    expect(socket().sent.map((m) => m.type)).toEqual(["projects.list"]);
    expect(client.getState()).toMatchObject({ status: "connecting", projects: null });
    listAndSubscribe(socket());
    expect(client.getState()).toMatchObject({ status: "live", projects });
    expect(socket().sent.filter((m) => m.type === "project.subscribe")).toEqual([
      expect.objectContaining({ project: "alpha", after: 0 }),
      expect.objectContaining({ project: "beta", after: 0 }),
    ]);
  });

  test("applies each project's frames and moves its cursor, skipping a replayed event", () => {
    const { client, socket } = setup();
    listAndSubscribe(socket());
    const seen: number[] = [];
    client.subscribe(() => seen.push(client.getState().logs.alpha?.seq ?? 0));
    const batch = (seq: number, events: ProtocolEvent[]) =>
      socket().receive({ type: "events", version: V, subscriptionId: "sub-alpha", project: "alpha", seq, events });
    batch(3, [event(1, "alpha", "s1"), event(3, "alpha", "s2")]);
    batch(5, [event(3, "alpha", "s2"), event(5, "alpha", "s3")]);
    batch(7, []);
    expect(client.getState().logs.alpha?.events.map((e) => e.seq)).toEqual([1, 3, 5]);
    expect(client.getState().logs.alpha?.seq).toBe(7);
    expect(seen).toEqual([3, 5, 7]);
    // A frame under a subscription this connection never got changes nothing.
    socket().receive({ type: "events", version: V, subscriptionId: "sub-old", project: "beta", seq: 9, events: [] });
    expect(client.getState().logs.beta).toBeUndefined();
  });

  test("keeps each project's folded state, from its subscription and then each frame, never an older one", () => {
    const { client, socket } = setup();
    const list = socket().sent.find((m) => m.type === "projects.list");
    socket().receive({ type: "projects.result", version: V, id: list?.id, projects });
    const subscribe = socket().sent.find((m) => m.type === "project.subscribe" && m.project === "alpha");
    const state = (n: number) => ({ sessions: [{ ticket: `EX-${n}` }] });
    socket().receive({
      ...subscribe,
      type: "project.subscribed",
      subscriptionId: "sub-alpha",
      snapshot: { seq: 2, state: state(2) },
    });
    expect(client.getState().fleets.alpha).toEqual({ seq: 2, state: state(2) });
    // The history that follows is at the snapshot's own cursor and carries none: nothing is missing.
    socket().receive({
      type: "events",
      version: V,
      subscriptionId: "sub-alpha",
      project: "alpha",
      seq: 2,
      events: [event(1, "alpha", "s1"), event(2, "alpha", "s2")],
    });
    expect(client.getState().logs.alpha?.seq).toBe(2);
    expect(client.getState().problem).toBeNull();
    const changes: unknown[] = [];
    client.subscribe(() => changes.push(client.getState().fleets.alpha));
    const frame = (seq: number, snapshot?: { seq: number; state: unknown }, subscriptionId = "sub-alpha") =>
      socket().receive({
        type: "events",
        version: V,
        subscriptionId,
        project: "alpha",
        seq,
        events: [event(seq, "alpha", `s${seq}`)],
        ...(snapshot ? { snapshot } : {}),
      });
    frame(4, { seq: 4, state: state(4) });
    // One change per frame: its events and its folded state together.
    expect(changes).toEqual([{ seq: 4, state: state(4) }]);
    // A resubscription's snapshot older than the one held is not taken.
    socket().receive({
      ...subscribe,
      type: "project.subscribed",
      subscriptionId: "sub-alpha-2",
      snapshot: { seq: 3, state: state(3) },
    });
    expect(client.getState().fleets.alpha).toEqual({ seq: 4, state: state(4) });
    expect(client.getState().fleets.beta).toBeUndefined();
    expect(client.getState().problem).toBeNull();
    // Events past the held state without a newer one: the list would freeze, so the app says why.
    frame(5, undefined, "sub-alpha-2");
    expect(client.getState().fleets.alpha).toEqual({ seq: 4, state: state(4) });
    expect(client.getState().problem).toBe(NOT_FOLDED);
  });

  test("after a drop, waits, reconnects and resumes each project at its last cursor, keeping the projects", () => {
    const { client, sockets, timers, socket } = setup();
    listAndSubscribe(socket());
    socket().receive({
      type: "events",
      version: V,
      subscriptionId: "sub-alpha",
      project: "alpha",
      seq: 4,
      events: [event(4, "alpha", "s1")],
    });
    socket().drop();
    expect(client.getState()).toMatchObject({ status: "reconnecting", projects });
    expect(timers.map((t) => t.ms)).toEqual([100]);
    expect(sockets).toHaveLength(1);

    timers[0]?.run();
    expect(sockets).toHaveLength(2);
    socket().drop(); // the daemon is still down: the next wait is longer
    expect(timers.map((t) => t.ms)).toEqual([100, 400]);
    timers[1]?.run();
    socket().onopen?.();
    listAndSubscribe(socket());
    expect(socket().sent.filter((m) => m.type === "project.subscribe")).toEqual([
      expect.objectContaining({ project: "alpha", after: 4 }),
      expect.objectContaining({ project: "beta", after: 0 }),
    ]);
    expect(client.getState().status).toBe("live");
    expect(client.getState().logs.alpha?.events).toHaveLength(1);
  });

  test("refuses a daemon of another major with one line, closes and never reconnects", () => {
    const { client, timers, socket } = setup();
    listAndSubscribe(socket());
    expect(client.getState().status).toBe("live");
    // A newer daemon: its frame's shape is not read, its major is.
    socket().receive({ type: "projects.result", version: { major: V.major + 1, minor: 0 }, shape: "unknown" });
    expect(client.getState()).toMatchObject({ status: "refused", problem: APP_TOO_OLD });
    expect(socket().closed).toBe(true);
    socket().drop();
    expect(timers).toHaveLength(0);
  });

  test("refuses an older daemon with its own line", () => {
    const { client, socket } = setup({ version: { major: V.major + 1, minor: 0 } });
    expect(client.getState().status).toBe("connecting");
    socket().receive({ type: "projects.result", version: V, id: "r1", projects });
    expect(client.getState()).toMatchObject({ status: "refused", problem: DAEMON_TOO_OLD, projects: null });
  });

  test("a key status that fails never hides the fleet's own line", () => {
    const failing = (problem: string | null) => {
      const { client, socket } = setup();
      listAndSubscribe(socket());
      if (problem) {
        const frame = (seq: number, events: ProtocolEvent[]) =>
          socket().receive({ type: "events", version: V, subscriptionId: "sub-alpha", project: "alpha", seq, events });
        frame(6, [event(6, "alpha", "s1")]);
        frame(3, []);
        expect(client.getState().problem).toBe(problem);
      }
      const status = socket().sent.find((m) => m.type === "credentials.status");
      expect(status).toBeDefined();
      socket().receive({
        type: "error",
        version: V,
        id: status?.id,
        code: "internal",
        message: "Could not access credential storage",
      });
      return client.getState().problem;
    };
    // Alone, the failure is said.
    expect(failing(null)).toBe("Could not access credential storage");
    // After the fleet's line (here the log behind the app), that line and its Reload stay.
    expect(failing(LOG_BEHIND)).toBe(LOG_BEHIND);
  });

  test("takes the daemon's own refusal as final", () => {
    const { client, timers, socket } = setup();
    listAndSubscribe(socket());
    const status = socket().sent.find((m) => m.type === "credentials.status");
    socket().receive({
      type: "credentials.result",
      version: V,
      id: status?.id,
      provider: "openai",
      storage: "os-keychain",
    });
    expect(client.getState().credentials?.provider).toBe("openai");
    socket().receive({ type: "error", version: V, code: "app-too-old", message: APP_TOO_OLD });
    expect(client.getState()).toMatchObject({ status: "refused", problem: APP_TOO_OLD, credentials: null });
    socket().drop();
    expect(timers).toHaveLength(0);
  });

  test("drops the connection on a frame it cannot read and resumes from the last applied cursor", () => {
    const { client, sockets, timers, socket } = setup();
    listAndSubscribe(socket());
    const batch = (seq: number, events: ProtocolEvent[]) =>
      socket().receive({ type: "events", version: V, subscriptionId: "sub-alpha", project: "alpha", seq, events });
    batch(2, [event(2, "alpha", "s1")]);
    expect(client.getState().problem).toBeNull();
    // Events out of order break the frame's own rule: what it carried is not applied, nor skipped.
    batch(5, [event(5, "alpha", "s2"), event(4, "alpha", "s3")]);
    expect(client.getState()).toMatchObject({ status: "reconnecting", problem: UNREADABLE, projects });
    expect(sockets[0]?.closed).toBe(true);
    // The old socket's late frames and close change nothing.
    sockets[0]?.receive({
      type: "events",
      version: V,
      subscriptionId: "sub-alpha",
      project: "alpha",
      seq: 9,
      events: [],
    });
    sockets[0]?.drop();
    expect(timers).toHaveLength(1);
    expect(client.getState().logs.alpha?.seq).toBe(2);

    timers[0]?.run();
    socket().onopen?.();
    listAndSubscribe(socket());
    expect(socket().sent.find((m) => m.type === "project.subscribe" && m.project === "alpha")).toMatchObject({
      after: 2,
    });
    expect(client.getState()).toMatchObject({ status: "live", problem: null });
    // Not JSON at all: the same. A daemon that keeps sending such frames waits longer each time.
    socket().onmessage?.({ data: "not json" });
    expect(timers.map((t) => t.ms)).toEqual([100, 400]);
  });

  test("says when the daemon's log is behind the app's cursor, and keeps what it had", () => {
    const { client, socket } = setup();
    listAndSubscribe(socket());
    socket().receive({
      type: "events",
      version: V,
      subscriptionId: "sub-alpha",
      project: "alpha",
      seq: 6,
      events: [event(6, "alpha", "s1")],
    });
    expect(client.getState().problem).toBeNull();
    socket().receive({ type: "events", version: V, subscriptionId: "sub-alpha", project: "alpha", seq: 3, events: [] });
    expect(client.getState()).toMatchObject({ status: "live", problem: LOG_BEHIND });
    expect(client.getState().logs.alpha?.seq).toBe(6);
  });

  test("refuses an address the browser cannot open, without retrying", () => {
    const { client, timers } = setup({ refuseOpen: true });
    expect(client.getState()).toMatchObject({ status: "refused", problem: unusableAddress("ws://daemon.test/") });
    expect(timers).toHaveLength(0);
  });

  test("stops: closes the socket and cancels a pending reconnect", () => {
    const { client, sockets, timers, socket } = setup();
    socket().drop();
    expect(timers).toHaveLength(1);
    client.stop();
    expect(timers[0]?.canceled).toBe(true);
    client.start();
    expect(sockets).toHaveLength(2);
    client.stop();
    expect(socket().closed).toBe(true);
    socket().drop();
    expect(timers).toHaveLength(1);
  });
});

test("saves a key once, keeps only status, and never replays the key across reconnects", async () => {
  const { client, socket, timers } = setup({ url: "ws://127.0.0.1:4824/" });
  const models = [{ kind: "custom-model", description: "Custom model", config: {} }];
  const readStatus = (provider: "custom-model" | null) => {
    const status = socket().sent.find((m) => m.type === "credentials.status");
    socket().receive({
      type: "credentials.result",
      version: V,
      id: status?.id,
      models,
      provider,
      storage: "os-keychain",
    });
  };
  listAndSubscribe(socket());
  readStatus(null);
  const key = randomBytes(24).toString("hex");
  const saved = client.saveCredentials("custom-model", key);
  const write = socket().sent.find((m) => m.type === "credentials.set");
  expect(write).toMatchObject({ provider: "custom-model", key });
  socket().receive({
    type: "credentials.result",
    version: V,
    id: write?.id,
    provider: "custom-model",
    models,
    storage: "os-keychain",
  });
  await saved;
  expect(client.getState().credentials).toEqual({ provider: "custom-model", models, storage: "os-keychain" });
  expect(JSON.stringify(client.getState())).not.toContain(key);
  // Losing a write acknowledgement rejects the attempt; only status is requested on reconnect.
  const unconfirmed = client.saveCredentials("custom-model", key);
  socket().drop();
  await expect(unconfirmed).rejects.toThrow("not confirmed saved");
  const reconnect = timers.findLast((t) => !t.canceled);
  reconnect?.run();
  socket().onopen?.();
  listAndSubscribe(socket());
  readStatus("custom-model");
  expect(socket().sent.some((m) => m.type === "credentials.status")).toBe(true);
  expect(socket().sent.some((m) => m.type === "credentials.set")).toBe(false);
  expect(JSON.stringify(socket().sent)).not.toContain(key);
  client.stop();
});

test("refuses credential writes to a remote daemon even when its fleet connection is live", async () => {
  const { client, socket } = setup();
  listAndSubscribe(socket());
  expect(client.getState().status).toBe("live");
  const status = socket().sent.find((m) => m.type === "credentials.status");
  socket().receive({ type: "credentials.result", version: V, id: status?.id, provider: null, storage: "os-keychain" });
  await expect(client.saveCredentials("anthropic", randomBytes(24).toString("hex"))).rejects.toThrow("on this device");
  expect(socket().sent.some((m) => m.type === "credentials.set")).toBe(false);
  client.stop();
});

test("a screen's request gets its own reply, its error's line, or a refusal when the connection drops", async () => {
  const { client, socket } = setup();
  await expect(client.request({ type: "chat.read", project: "p" })).rejects.toThrow(/not connected/);
  socket().receive({ type: "projects.result", version: V, id: "r1", projects: [] });
  expect(client.getState().minor).toBe(V.minor);
  const read = client.request({ type: "chat.read", project: "p" });
  const sent = socket().sent.at(-1) as ClientMessage & { id: string };
  expect(sent).toEqual({ type: "chat.read", project: "p", version: V, id: sent.id });
  // Another request's reply is not this one's; its own resolves it.
  socket().receive({ type: "chat.sent", version: V, id: "other", project: "p", requestId: "m" });
  socket().receive({
    type: "chat.result",
    version: V,
    id: sent.id,
    project: "p",
    seq: 3,
    coordinator: false,
    items: [],
  });
  expect((await read).seq).toBe(3);
  const refused = client.request({ type: "chat.send", project: "p", requestId: "m", body: "Hi" });
  const asked = socket().sent.at(-1) as { id: string };
  socket().receive({ type: "error", version: V, id: asked.id, code: "not-found", message: "No coordinator" });
  await expect(refused).rejects.toThrow("No coordinator");
  // A request's error is not the fleet's problem.
  expect(client.getState().problem).toBeNull();
  const dropped = client.request({ type: "owner.answer", project: "p", item: "q", choice: "Yes" });
  socket().drop();
  await expect(dropped).rejects.toThrow(/connection dropped/);
});

test("the live turn's frames reach the room's listeners, and Stop resolves on chat.stopped", async () => {
  const { client, socket } = setup();
  socket().receive({ type: "projects.result", version: V, id: "r1", projects: [] });
  const heard: string[] = [];
  let changes = 0;
  client.subscribe(() => changes++);
  const leave = client.chat((frame) => heard.push(`${frame.type} ${frame.project}`));
  socket().receive({
    type: "chat.turn",
    version: V,
    project: "p",
    state: "thinking",
    since: "2026-03-10T09:00:00.000Z",
    queued: 0,
  });
  socket().receive({ type: "chat.delta", version: V, project: "p", id: "g1:1", kind: "text", text: "On it" });
  expect(heard).toEqual(["chat.turn p", "chat.delta p"]);
  // A live frame is not the fleet's state: the screens reading it are not told of a change.
  expect(changes).toBe(0);
  leave();
  socket().receive({
    type: "chat.turn",
    version: V,
    project: "p",
    state: "idle",
    since: "2026-03-10T09:00:00.000Z",
    queued: 0,
  });
  expect(heard).toHaveLength(2);
  const stop = client.request({ type: "chat.stop", project: "p" });
  const asked = socket().sent.at(-1) as ClientMessage & { id: string };
  expect(asked).toEqual({ type: "chat.stop", project: "p", version: V, id: asked.id });
  socket().receive({ type: "chat.stopped", version: V, id: asked.id, project: "p" });
  expect((await stop).type).toBe("chat.stopped");
  client.stop();
});

test("model sign-in delivers generic auth prompts, settles on catalog, and never replays answers across a drop", async () => {
  const { client, socket, timers } = setup();
  listAndSubscribe(socket());
  const catalog = { providers: [], selected: null };
  const list = socket().sent.find((m) => m.type === "models.providers");
  socket().receive({ type: "models.catalog", version: V, id: list?.id, ...catalog });
  expect(client.getState().catalog).toEqual(catalog);
  const frames: unknown[] = [];
  client.auth((frame) => frames.push(frame));
  const login = client.login("openai-codex", "oauth");
  const flow = client.getState().authFlow;
  expect(typeof flow).toBe("string");
  socket().receive({
    type: "auth.event",
    version: V,
    flow,
    event: { type: "auth_url", url: "https://example.test/sign-in" },
  });
  socket().receive({
    type: "auth.prompt",
    version: V,
    flow,
    id: "prompt-1",
    promptType: "manual_code",
    message: "Paste code",
  });
  expect(frames).toHaveLength(2);
  const answer = randomBytes(24).toString("hex");
  client.answer(flow as string, "prompt-1", answer);
  expect(socket().sent.at(-1)?.type).toBe("auth.answer");
  socket().receive({ type: "models.catalog", version: V, id: flow, ...catalog });
  await login;
  expect(client.getState().authFlow).toBeNull();
  const selection = client.select("openai-codex", "small");
  const request = socket().sent.at(-1);
  expect(request?.type).toBe("models.select");
  // An unrelated broadcast must update state without completing this request.
  socket().receive({ type: "models.catalog", version: V, id: "push:other", ...catalog });
  socket().receive({ type: "error", version: V, id: request?.id, code: "invalid-message", message: "Connect first" });
  await expect(selection).rejects.toThrow("Connect first");
  const pending = client.login("openai-codex", "oauth");
  socket().drop();
  await expect(pending).rejects.toThrow("connection dropped");
  expect(client.getState().authFlow).toBeNull();
  timers.findLast((timer) => !timer.canceled)?.run();
  socket().onopen?.();
  listAndSubscribe(socket());
  expect(socket().sent.some((m) => m.type === "auth.answer" || m.type === "models.login")).toBe(false);
  client.stop();
  for (const request of [
    client.login("openai", "api_key"),
    client.logout("openai"),
    client.select("openai", "small"),
    client.cancel("old-flow"),
  ])
    await expect(request).rejects.toThrow("Connect to a daemon");
});

test("account login exposes its device code, settles on approval, applies pushes and keeps account errors separate", async () => {
  const { client, socket } = setup();
  listAndSubscribe(socket());
  expect(socket().sent.some((m) => m.type === "account.status")).toBe(true);
  const login = client.login();
  const request = socket().sent.findLast((m) => m.type === "account.login");
  expect(request).toBeDefined();
  socket().receive({
    type: "account.device",
    version: V,
    id: request?.id,
    code: "ABCD-EFGH",
    verificationUrl: "https://armada.example/device",
    expiresAt: "2026-10-01T12:15:00Z",
  });
  expect(client.getState().accountDevice?.code).toBe("ABCD-EFGH");
  const account = {
    signedIn: true,
    apiUrl: "https://armada.example",
    email: "owner@example.test",
    organization: { name: "Orchard", slug: "orchard" },
    projects: [],
    keys: { linear: true, github: false },
  };
  socket().receive({ type: "account.result", version: V, id: request?.id, ...account });
  await login;
  expect(client.getState().account).toEqual(account);
  expect(client.getState().accountDevice).toBeNull();
  const logout = client.logout();
  const out = socket().sent.findLast((m) => m.type === "account.logout");
  socket().receive({ type: "account.result", version: V, signedIn: false, apiUrl: account.apiUrl });
  socket().receive({ type: "account.result", version: V, id: out?.id, signedIn: false, apiUrl: account.apiUrl });
  await logout;
  expect(client.getState().account?.signedIn).toBe(false);
  const denied = client.login();
  const deniedRequest = socket().sent.findLast((m) => m.type === "account.login");
  socket().receive({ type: "error", version: V, id: deniedRequest?.id, code: "denied", message: "Sign-in was denied" });
  await expect(denied).rejects.toThrow("Sign-in was denied");
  expect(client.getState().accountProblem).toBe("Sign-in was denied");
  expect(client.getState().problem).toBeNull();
  const dropped = client.login();
  socket().drop();
  await expect(dropped).rejects.toThrow("connection dropped");
  client.stop();
});
