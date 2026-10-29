import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  admitRequest,
  eventSchema,
  type Project,
  type ProtocolError,
  projectSchema,
  type ServerMessage,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { fold, type ProjectTables } from "../fold.ts";
import type { EventStore } from "../store.ts";
import { serveStatic } from "./static.ts";

export interface ServerOptions {
  store: EventStore;
  projects: readonly Project[];
  /** 0 asks the OS for a free port. Always bound to IPv4 loopback. */
  port?: number;
  /** Defaults to packages/app/dist, built by Vite. Missing builds return 404. */
  staticDir?: string;
  /** Additional trusted browser origins, e.g. a separate local Vite dev server. */
  allowedOrigins?: readonly string[];
}
export interface DaemonServer {
  url: string;
  wsUrl: string;
  /** Closes connections/listeners; the caller still owns and closes the store. Idempotent. */
  close(): Promise<void>;
}
interface Subscription {
  id: string;
  after: number;
}
const emptyProject = (): ProjectTables => ({
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
  holds: [],
  validations: [],
});

/** Node-only transport adapter. One daemon owns all appends through this EventStore. */
export async function startServer(options: ServerOptions): Promise<DaemonServer> {
  const { store } = options;
  const projects = options.projects.map((p) => projectSchema.parse(p));
  if (new Set(projects.map((p) => p.id)).size !== projects.length) throw new Error("Duplicate project id");
  const known = new Set(projects.map((p) => p.id));
  const staticDir = options.staticDir ?? fileURLToPath(new URL("../../../app/dist/", import.meta.url));
  let authority = "";
  let closing = false;
  const server = createServer((req, res) => {
    if (req.headers.host !== authority) {
      res.writeHead(403);
      res.end();
      return;
    }
    void serveStatic(req, res, staticDir);
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const connections = new Map<WebSocket, Map<string, Subscription>>();

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    // A slow client resumes from its last applied cursor instead of growing memory without limit.
    if (ws.bufferedAmount > 8 * 1024 * 1024) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message), (error) => {
      if (error) ws.terminate();
    });
  }
  const error = (ws: WebSocket, id: string | undefined, code: ProtocolError["code"], message: string) =>
    send(ws, { type: "error", version, ...(id ? { id } : {}), code, message });

  function batch(ws: WebSocket, project: string, subscription: Subscription): void {
    // Synchronous store reads and registration cannot interleave with an append in this process.
    const seq = store.sequence;
    const events = store.readSince(subscription.after, project).map((event) => eventSchema.parse(event));
    send(ws, { type: "events", version, project, subscriptionId: subscription.id, seq, events });
    subscription.after = seq;
  }
  const unsubscribe = store.subscribe(() => {
    for (const [ws, subscriptions] of connections) {
      try {
        for (const [project, subscription] of subscriptions) batch(ws, project, subscription);
      } catch {
        // The write is already committed; this client can recover by replaying it.
        ws.terminate();
      }
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    const trusted = !origin || origin === `http://${authority}` || options.allowedOrigins?.includes(origin);
    if (closing || req.headers.host !== authority || !trusted || req.url !== "/") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
  });
  sockets.on("connection", (ws) => {
    const subscriptions = new Map<string, Subscription>();
    connections.set(ws, subscriptions);
    let refused = false;
    ws.on("error", () => ws.terminate());
    ws.on("close", () => connections.delete(ws));
    ws.on("message", (data, binary) => {
      if (closing || refused) return;
      let input: unknown = null;
      if (!binary) {
        try {
          input = JSON.parse(String(data));
        } catch {
          /* Admission handles invalid JSON. */
        }
      }
      const admitted = admitRequest(input);
      if (!admitted.ok) {
        send(ws, admitted.error);
        if (admitted.close) {
          refused = true;
          subscriptions.clear();
          ws.close(1008);
        }
        return;
      }
      const request = admitted.request;
      try {
        if (request.type === "projects.list") {
          send(ws, { type: "projects.result", version, id: request.id, projects });
          return;
        }
        if (!known.has(request.project)) return error(ws, request.id, "not-found", "No such project");
        if (request.type === "project.subscribe") {
          const seq = store.sequence;
          if (request.after > seq)
            return error(ws, request.id, "invalid-message", "Replay cursor is ahead of the daemon log");
          const subscription = { id: randomUUID(), after: request.after };
          const snapshot =
            request.after === 0
              ? {
                  seq,
                  // JSON serialization is the boundary from daemon types to the protocol's JSON value.
                  state: JSON.parse(
                    JSON.stringify(
                      fold(store.readSince(0, request.project)).projects[request.project] ?? emptyProject(),
                    ),
                  ),
                }
              : undefined;
          subscriptions.set(request.project, subscription);
          send(ws, {
            ...request,
            type: "project.subscribed",
            version,
            subscriptionId: subscription.id,
            ...(snapshot ? { snapshot } : {}),
          });
          batch(ws, request.project, subscription);
          return;
        }
        const seq = store.sequence;
        const events = store
          .readSince(0, request.project)
          .filter((event) => "session" in event.payload && event.payload.session === request.sessionId)
          .map((event) => eventSchema.parse(event));
        if (!events.length) return error(ws, request.id, "not-found", "No such session");
        send(ws, {
          type: "session.result",
          version,
          id: request.id,
          project: request.project,
          sessionId: request.sessionId,
          seq,
          events,
        });
      } catch {
        error(ws, request.id, "internal", "The daemon could not read the fleet");
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    unsubscribe();
    sockets.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Daemon did not bind a TCP port");
  authority = `127.0.0.1:${address.port}`;
  let closed: Promise<void> | undefined;
  return {
    url: `http://${authority}`,
    wsUrl: `ws://${authority}/`,
    close() {
      closed ??= new Promise<void>((resolve, reject) => {
        closing = true;
        unsubscribe();
        for (const ws of sockets.clients) ws.terminate();
        connections.clear();
        sockets.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
