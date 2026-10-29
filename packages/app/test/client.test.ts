import { describe, expect, test } from "bun:test";
import { APP_TOO_OLD, type ClientMessage, PROTOCOL_VERSION, type ProtocolEvent } from "@armada/protocol";
import { createDaemonClient, type SocketLike, UNREADABLE } from "../src/protocol/client";

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

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number; canceled: boolean }[] = [];
  const client = createDaemonClient({
    url: "ws://daemon.test/",
    open: () => {
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
  socket().onopen?.();
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

  test("takes the daemon's own refusal as final", () => {
    const { client, timers, socket } = setup();
    socket().receive({ type: "error", version: V, code: "app-too-old", message: APP_TOO_OLD });
    expect(client.getState()).toMatchObject({ status: "refused", problem: APP_TOO_OLD });
    socket().drop();
    expect(timers).toHaveLength(0);
  });

  test("says when a frame cannot be read, and keeps what it had", () => {
    const { client, socket } = setup();
    listAndSubscribe(socket());
    expect(client.getState().problem).toBeNull();
    socket().onmessage?.({ data: "not json" });
    expect(client.getState()).toMatchObject({ status: "live", problem: UNREADABLE, projects });
    // Events out of order break the frame's own rule.
    socket().receive({
      type: "events",
      version: V,
      subscriptionId: "sub-alpha",
      project: "alpha",
      seq: 5,
      events: [event(5, "alpha", "s1"), event(2, "alpha", "s2")],
    });
    expect(client.getState().logs.alpha).toBeUndefined();
  });

  test("stops: closes the socket and cancels a pending reconnect", () => {
    const { client, timers, socket } = setup();
    socket().drop();
    expect(timers).toHaveLength(1);
    client.stop();
    expect(timers[0]?.canceled).toBe(true);
  });
});
