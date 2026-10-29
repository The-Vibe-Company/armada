// A stand-in for armadad's WebSocket server, for development and the app's
// browser test until packages/daemon serves the protocol: synthetic projects
// and events, every request admitted by @armada/protocol first. Bun only;
// never shipped in the app.
import {
  admitRequest,
  type EventBatch,
  PROTOCOL_VERSION,
  type Project,
  type ProtocolEvent,
  type ProtocolVersion,
  type ServerMessage,
} from "@armada/protocol";
import type { ServerWebSocket } from "bun";
import { dispatchCredentials } from "../../daemon/src/credentials.ts";
import { Keychain } from "../../daemon/src/keychain.ts";

export interface FakeDaemon {
  url: string;
  /** Append one event to the log and send it to the project's subscribers. */
  append(event: Omit<ProtocolEvent, "seq">): ProtocolEvent;
  stop(): void;
}

interface Socket {
  subscriptions: Map<string, string>;
}

export const SAMPLE_PROJECTS: Project[] = [
  { id: "harbor", name: "Harbor", repository: "example/harbor" },
  { id: "lantern", name: "Lantern", repository: "example/lantern" },
  { id: "tidewater", name: "Tidewater", repository: "example/tidewater" },
];

const AT = "2026-01-05T09:00:00.000Z";
const claim = (project: string, ticket: string, session: string): Omit<ProtocolEvent, "seq"> => ({
  project,
  kind: "session.claimed",
  at: AT,
  actor: "worker",
  payload: { ticket, session, generation: 1, owner: "default", runtime: "local", handle: session },
});

/** Two sessions in flight on Harbor, one on Lantern (another released), none on Tidewater. */
export const SAMPLE_EVENTS: Omit<ProtocolEvent, "seq">[] = [
  claim("harbor", "HAR-12", "s-har-12"),
  claim("harbor", "HAR-15", "s-har-15"),
  claim("lantern", "LAN-3", "s-lan-3"),
  claim("lantern", "LAN-4", "s-lan-4"),
  {
    project: "lantern",
    kind: "session.released",
    at: AT,
    actor: "worker",
    payload: { ticket: "LAN-4", session: "s-lan-4", reason: "superseded" },
  },
];

export function startFakeDaemon({
  port = 0,
  projects = SAMPLE_PROJECTS,
  events = SAMPLE_EVENTS,
  version = PROTOCOL_VERSION,
}: {
  port?: number;
  projects?: Project[];
  events?: Omit<ProtocolEvent, "seq">[];
  version?: ProtocolVersion;
} = {}): FakeDaemon {
  const entries = new Map<string, string>();
  const credentials = new Keychain({
    storage: "os-keychain",
    async read(service, account) {
      return entries.get(`${service}/${account}`) ?? null;
    },
    async write(service, account, value) {
      entries.set(`${service}/${account}`, value);
    },
  });
  const log: ProtocolEvent[] = [];
  const sockets = new Set<ServerWebSocket<Socket>>();
  let subscription = 0;
  const say = (ws: ServerWebSocket<Socket>, message: ServerMessage): void => {
    ws.send(JSON.stringify(message));
  };
  const frame = (subscriptionId: string, project: string, after: number): EventBatch => ({
    type: "events",
    version,
    subscriptionId,
    project,
    seq: log.at(-1)?.seq ?? 0,
    events: log.filter((e) => e.project === project && e.seq > after),
  });

  const server = Bun.serve<Socket>({
    hostname: "127.0.0.1",
    port,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: { subscriptions: new Map() } })) return;
      return new Response("Armada fake daemon: connect over WebSocket", { status: 426 });
    },
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      async message(ws, raw) {
        let input: unknown;
        try {
          input = JSON.parse(String(raw));
        } catch {
          input = null;
        }
        const admitted = admitRequest(input, version);
        if (!admitted.ok) {
          say(ws, admitted.error);
          if (admitted.close) ws.close();
          return;
        }
        const request = admitted.request;
        const known = (id: string) => projects.some((p) => p.id === id);
        switch (request.type) {
          case "credentials.status":
          case "credentials.set":
            return say(ws, await dispatchCredentials(request, credentials));
          case "projects.list":
            return say(ws, { type: "projects.result", version, id: request.id, projects });
          case "project.subscribe": {
            if (!known(request.project)) {
              return say(ws, { type: "error", version, id: request.id, code: "not-found", message: "No such project" });
            }
            const subscriptionId = `sub-${++subscription}`;
            ws.data.subscriptions.set(request.project, subscriptionId);
            say(ws, { ...request, type: "project.subscribed", version, subscriptionId });
            return say(ws, frame(subscriptionId, request.project, request.after));
          }
          case "session.read":
            return say(ws, { type: "error", version, id: request.id, code: "not-found", message: "No such session" });
        }
      },
    },
  });

  function append(event: Omit<ProtocolEvent, "seq">): ProtocolEvent {
    const stored = { ...event, seq: (log.at(-1)?.seq ?? 0) + 1 };
    log.push(stored);
    for (const ws of sockets) {
      const id = ws.data.subscriptions.get(event.project);
      if (id) say(ws, frame(id, event.project, stored.seq - 1));
    }
    return stored;
  }
  for (const event of events) append(event);

  return { url: `ws://127.0.0.1:${server.port}/`, append, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const daemon = startFakeDaemon({ port: Number(process.env.PORT ?? 4824) });
  console.log(`Fake daemon on ${daemon.url}: ${SAMPLE_PROJECTS.length} projects. Ctrl-C stops it.`);
  // A session claimed then released on Tidewater every few seconds, so the sidebar's count moves.
  let open = false;
  setInterval(() => {
    const payload = { ticket: "TID-7", session: "s-tid-7", reason: "demo" };
    daemon.append(
      open
        ? { project: "tidewater", kind: "session.released", at: new Date().toISOString(), actor: "worker", payload }
        : claim("tidewater", "TID-7", "s-tid-7"),
    );
    open = !open;
  }, 4000);
}
