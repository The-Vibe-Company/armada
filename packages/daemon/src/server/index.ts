import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  admitRequest,
  eventSchema,
  type Project,
  type ProjectTables,
  type ProtocolError,
  projectSchema,
  projectTablesSchema,
  type ServerMessage,
  type Snapshot,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { CoordinatorOptions, ProjectCoordinator } from "../../coordinator/index.ts";
import { dispatchCredentials } from "../credentials.ts";
import { fold } from "../fold.ts";
import { type Keychain, systemKeychain } from "../keychain.ts";
import type { EventStore } from "../store.ts";
import type { Workers } from "../workers/service.ts";
import { dispatchChat } from "./chat.ts";
import { dispatchPlugins, isPluginsRequest, type PluginHost } from "./plugins.ts";
import { serveStatic } from "./static.ts";

export interface ServerOptions {
  store: EventStore;
  workers?: Workers;
  /** Caller-injected model access; omitted until model configuration is available. */
  coordinators?: readonly CoordinatorOptions[];
  projects: readonly Project[];
  /** 0 asks the OS for a free port. Always bound to IPv4 loopback. */
  port?: number;
  /** Defaults to packages/app/dist, built by Vite. Missing builds return 404. */
  staticDir?: string;
  /** Additional trusted browser origins, e.g. a separate local Vite dev server. */
  allowedOrigins?: readonly string[];
  /** Host-owned gateway. Tests inject a fake; only this daemon can persist app credentials. */
  keychain?: Keychain;
  /** The app's Plugins screen; without it, plugin requests answer `not-found`. */
  plugins?: PluginHost;
  /**
   * Asked by `daemon.restart` once the answer is sent: the host closes and exits
   * for its supervisor to start it again. Without it the app says to quit and reopen.
   */
  restart?: () => void;
}
export interface DaemonServer {
  url: string;
  wsUrl: string;
  coordinators: ReadonlyMap<string, ProjectCoordinator>;
  /** Closes connections/listeners; the caller still owns and closes the store. Idempotent. */
  close(): Promise<void>;
}
interface Subscription {
  id: string;
  after: number;
}
const emptyProject = (): ProjectTables => ({
  rules: { revision: 0, value: {} },
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
  const { store, workers } = options;
  const projects = options.projects.map((p) => projectSchema.parse(p));
  if (new Set(projects.map((p) => p.id)).size !== projects.length) throw new Error("Duplicate project id");
  const known = new Set(projects.map((p) => p.id));
  const configured = options.coordinators ?? [];
  if (new Set(configured.map((entry) => entry.project)).size !== configured.length)
    throw new Error("Duplicate coordinator project");
  if (configured.some((entry) => !known.has(entry.project))) throw new Error("Unknown coordinator project");
  const coordinatorManager = configured.length
    ? new (await import("../../coordinator/index.ts")).Coordinators(store)
    : undefined;
  const coordinators = new Map<string, ProjectCoordinator>();
  const staticDir = options.staticDir ?? fileURLToPath(new URL("../../../app/dist/", import.meta.url));
  let authority = "";
  let closing = false;
  let credentialQueue = Promise.resolve();
  let pendingCredentials = 0;
  let pluginQueue = Promise.resolve();
  let pendingPlugins = 0;
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

  /** A project's folded tables at the store's cursor, as the protocol's JSON value. */
  function snapshotOf(project: string): Snapshot {
    const seq = store.sequence;
    // Normalize optional undefined fields to JSON, then validate without changing wire key order.
    const tables = fold(store.readSince(0, project)).projects[project] ?? emptyProject();
    return { seq, state: projectTablesSchema.parse(JSON.parse(JSON.stringify(tables))) };
  }

  /**
   * Sends what the subscription has not seen. A frame with events also carries
   * the project's refolded state (`folded` shares one fold per project between
   * sockets); `folded: null` leaves it out right after a subscription's own.
   */
  function batch(
    ws: WebSocket,
    project: string,
    subscription: Subscription,
    folded: Map<string, Snapshot> | null = new Map(),
  ): void {
    // Synchronous store reads and registration cannot interleave with an append in this process.
    const seq = store.sequence;
    const events = store.readSince(subscription.after, project).map((event) => eventSchema.parse(event));
    let snapshot: Snapshot | undefined;
    if (events.length && folded) {
      snapshot = folded.get(project) ?? snapshotOf(project);
      folded.set(project, snapshot);
    }
    send(ws, {
      type: "events",
      version,
      project,
      subscriptionId: subscription.id,
      seq,
      events,
      ...(snapshot ? { snapshot } : {}),
    });
    subscription.after = seq;
  }
  // Commit notices coalesce to one flush per microtask: a burst of appends in one
  // task (a tracker's read) sends each subscription one frame and folds each
  // project once. Every subscription reads from its own cursor, so nothing is lost.
  let flushing = false;
  const unsubscribe = store.subscribe(() => {
    if (flushing) return;
    flushing = true;
    queueMicrotask(flush);
  });
  function flush(): void {
    flushing = false;
    if (closing) return;
    const folded = new Map<string, Snapshot>();
    for (const [ws, subscriptions] of connections) {
      try {
        for (const [project, subscription] of subscriptions) batch(ws, project, subscription, folded);
      } catch {
        // The write is already committed; this client can recover by replaying it.
        ws.terminate();
      }
    }
  }

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
        if (request.type === "credentials.set" || request.type === "credentials.status") {
          if (pendingCredentials >= 32)
            return error(ws, request.id, "invalid-message", "Too many pending credential requests");
          pendingCredentials += 1;
          // Serialize status with writes across connections. Never append/log the request or echo its body.
          credentialQueue = credentialQueue.then(async () => {
            try {
              send(ws, await dispatchCredentials(request, options.keychain ?? systemKeychain()));
            } catch {
              error(ws, request.id, "internal", "Could not access credential storage");
            } finally {
              pendingCredentials -= 1;
            }
          });
          return;
        }
        if (isPluginsRequest(request) || request.type === "daemon.restart") {
          const host = options.plugins;
          if (!host) return error(ws, request.id, "not-found", "This daemon has no plugin catalog");
          if (request.type === "daemon.restart" && !options.restart)
            return error(ws, request.id, "not-found", "This daemon cannot restart itself: quit and reopen Armada");
          if (pendingPlugins >= 32) return error(ws, request.id, "invalid-message", "Too many pending plugin requests");
          pendingPlugins += 1;
          // One at a time, in order: a restart waits for the changes asked before it. Never log a request (secrets).
          pluginQueue = pluginQueue.then(async () => {
            try {
              if (request.type === "daemon.restart") {
                await new Promise<void>((resolve) =>
                  ws.readyState === WebSocket.OPEN
                    ? ws.send(JSON.stringify({ type: "daemon.restarting", version, id: request.id }), () => resolve())
                    : resolve(),
                );
                if (!closing) options.restart?.();
                return;
              }
              send(ws, await dispatchPlugins(request, host, !!options.restart));
            } catch {
              error(ws, request.id, "internal", "The daemon could not read its plugins");
            } finally {
              pendingPlugins -= 1;
            }
          });
          return;
        }
        if (request.type === "projects.list") {
          send(ws, { type: "projects.result", version, id: request.id, projects });
          return;
        }
        if (!known.has(request.project)) return error(ws, request.id, "not-found", "No such project");
        if (request.type === "chat.read" || request.type === "chat.send" || request.type === "owner.answer") {
          // The room's requests (THE-1996, server/chat.ts): each answers once, its failure as one line.
          void dispatchChat(request, { store, coordinator: coordinators.get(request.project) }).then((reply) =>
            send(ws, reply),
          );
          return;
        }
        if (request.type === "project.subscribe") {
          const seq = store.sequence;
          if (request.after > seq)
            return error(ws, request.id, "invalid-message", "Replay cursor is ahead of the daemon log");
          const subscription = { id: randomUUID(), after: request.after };
          const snapshot = request.after === 0 ? snapshotOf(request.project) : undefined;
          subscriptions.set(request.project, subscription);
          send(ws, {
            ...request,
            type: "project.subscribed",
            version,
            subscriptionId: subscription.id,
            ...(snapshot ? { snapshot } : {}),
          });
          // The acknowledgment already holds the folded state of the history that follows.
          batch(ws, request.project, subscription, snapshot ? null : new Map());
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
  const close = () => {
    closed ??= (async () => {
      closing = true;
      unsubscribe();
      for (const ws of sockets.clients) ws.terminate();
      connections.clear();
      sockets.close();
      const transport = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      const results = await Promise.allSettled([transport, credentialQueue, pluginQueue, coordinatorManager?.close()]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return closed;
  };
  try {
    if (coordinatorManager)
      for (const config of configured)
        coordinators.set(
          config.project,
          await coordinatorManager.open({
            ...config,
            native: {
              ...config.native,
              ...(workers
                ? {
                    workers,
                    deliverAnswerOnce: (input) => workers.answer(input, config.project),
                  }
                : {}),
            },
          }),
        );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    url: `http://${authority}`,
    wsUrl: `ws://${authority}/`,
    coordinators,
    close,
  };
}
