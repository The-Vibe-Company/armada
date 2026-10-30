import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_MINOR,
  admitRequest,
  CHAT_LIVE_MINOR,
  eventSchema,
  MODELS_MINOR,
  type ModelKindEntry,
  type Project,
  type ProjectTables,
  type ProtocolError,
  projectSchema,
  projectTablesSchema,
  RULES_SCHEMA_MINOR,
  type ServerMessage,
  type Snapshot,
  PROTOCOL_VERSION as version,
  workerLaunchCheckpointSchema,
} from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { WebSocket, WebSocketServer } from "ws";
import type { CoordinatorOptions, ProjectCoordinator } from "../../coordinator/index.ts";
import { dispatchCredentials } from "../credentials.ts";
import { fold } from "../fold.ts";
import { type Keychain, systemKeychain } from "../keychain.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { EventStore } from "../store.ts";
import type { Workers } from "../workers/service.ts";
import type { Account } from "./account.ts";
import { AuthFlows } from "./auth.ts";
import { dispatchChat } from "./chat.ts";
import { type ChatClock, ChatLive } from "./chat-live.ts";
import { dispatchPlugins, isPluginsRequest, type PluginHost } from "./plugins.ts";
import { dispatchSession } from "./session.ts";
import { serveStatic } from "./static.ts";

/** The worker service a host (or the app's dev daemon) hands `startServer`. */
export type { Workers } from "../workers/service.ts";

export interface ServerOptions {
  store: EventStore;
  workers?: Workers;
  /** Clock and scheduling for coalescing committed chat partials. */
  chatClock?: ChatClock;
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
  account?: Account;
  modelKinds?: readonly ModelKindEntry[];
  modelRegistry?: ModelRegistry;
  /** Resolve current global/project selection at the next turn, including first configuration. */
  resolveCoordinator?: (project: string) => Promise<CoordinatorOptions | undefined>;
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
  minor: number;
  id: string;
  after: number;
  chat?: () => void;
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
  const coordinatorManager =
    configured.length || options.resolveCoordinator
      ? new (await import("../../coordinator/index.ts")).Coordinators(store)
      : undefined;
  const coordinators = new Map<string, ProjectCoordinator>();
  const sources = new Map(configured.map((config) => [config.project, config]));
  const opening = new Map<string, Promise<ProjectCoordinator | undefined>>();
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
  const minors = new Map<WebSocket, number>();
  const auth = new AuthFlows();
  const chat = new ChatLive(options.chatClock);
  const unsubscribeAccount = options.account?.subscribe((state) => {
    for (const [ws, minor] of minors)
      if (minor >= ACCOUNT_MINOR) send(ws, { type: "account.result", version, ...state });
  });

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

  async function catalog(ws: WebSocket, id: string, broadcast: boolean, minor: number) {
    if (!options.modelRegistry) return error(ws, id, "not-found", "This daemon has no model registry");
    const reading = await options.modelRegistry.catalog();
    if (minor >= MODELS_MINOR) send(ws, { type: "models.catalog", version, id, ...reading });
    if (broadcast)
      for (const client of connections.keys())
        if (client !== ws && (minors.get(client) ?? 0) >= MODELS_MINOR)
          send(client, { type: "models.catalog", version, id: `push:${randomUUID()}`, ...reading });
  }

  async function ensureCoordinator(project: string): Promise<ProjectCoordinator | undefined> {
    if (!options.resolveCoordinator || !coordinatorManager) return coordinators.get(project);
    const pending = opening.get(project);
    if (pending) return pending;
    const next = (async () => {
      const config = await options.resolveCoordinator?.(project);
      if (!config || closing) return undefined;
      const current = coordinators.get(project);
      if (current) {
        const agent = await current.conversation.agent(context);
        const previous = sources.get(project);
        if (
          agent.model?.provider !== config.model.provider ||
          agent.model.modelId !== config.model.modelId ||
          JSON.stringify(previous?.selection) !== JSON.stringify(config.selection)
        ) {
          // An in-flight request keeps its model. The newly selected model starts with the next turn.
          await current.harness.waitForIdle(context);
          if (closing) return undefined;
          sources.set(project, config);
          await current.conversation.configure({ model: config.model }, context);
        }
        return current;
      }
      sources.set(project, config);
      const coordinator = await coordinatorManager.open({
        ...config,
        models: () => {
          const models = sources.get(project)?.models ?? config.models;
          return typeof models === "function" ? models() : models;
        },
        native: {
          ...config.native,
          ...(workers ? { workers, deliverAnswerOnce: (input) => workers.answer(input, project) } : {}),
        },
      });
      coordinators.set(project, coordinator);
      for (const [ws, subscriptions] of connections) {
        const subscription = subscriptions.get(project);
        if (subscription && subscription.minor >= CHAT_LIVE_MINOR && !subscription.chat)
          subscription.chat = chat.subscribe(project, coordinator.conversation, (frame) => send(ws, frame));
      }
      return coordinator;
    })();
    opening.set(project, next);
    try {
      return await next;
    } finally {
      if (opening.get(project) === next) opening.delete(project);
    }
  }

  /** A project's folded tables at the store's cursor, as the protocol's JSON value. */
  function snapshotOf(project: string): Snapshot {
    const seq = store.sequence;
    // Normalize optional undefined fields to JSON, then validate without changing wire key order.
    const tables = fold(store.readSince(0, project)).projects[project] ?? emptyProject();
    return { seq, state: projectTablesSchema.parse(JSON.parse(JSON.stringify(tables))) };
  }

  /** Older same-major clients use a strict policy reader; preserve their existing Rules view. */
  function snapshotFor(snapshot: Snapshot, minor: number): Snapshot {
    if (minor >= RULES_SCHEMA_MINOR) return snapshot;
    const state = snapshot.state as unknown as ProjectTables;
    const rules = state.rules;
    if (!rules) return snapshot;
    const value = { ...rules.value };
    delete value.gates;
    if (value.policy) {
      const policy = { ...value.policy };
      delete policy.plans;
      delete policy.approvalLabel;
      delete policy.preApprovedLabel;
      value.policy = policy;
    }
    // Detach only the legacy projection; never mutate the full snapshot shared with current clients.
    return { seq: snapshot.seq, state: JSON.parse(JSON.stringify({ ...state, rules: { ...rules, value } })) };
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
      ...(snapshot ? { snapshot: snapshotFor(snapshot, subscription.minor) } : {}),
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
    const clearSubscriptions = () => {
      for (const subscription of subscriptions.values()) subscription.chat?.();
      subscriptions.clear();
    };
    ws.on("close", () => {
      clearSubscriptions();
      connections.delete(ws);
      minors.delete(ws);
      void auth.cancel(ws);
    });
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
          clearSubscriptions();
          ws.close(1008);
        }
        return;
      }
      const request = admitted.request;
      minors.set(ws, request.version.minor);
      try {
        if (
          request.type === "account.status" ||
          request.type === "account.login" ||
          request.type === "account.logout"
        ) {
          if (!options.account) return error(ws, request.id, "offline", "Armada account is unavailable");
          void options.account.dispatch(request, (reply) => send(ws, reply));
          return;
        }
        if (request.type === "auth.answer") {
          if (!auth.answer(ws, request.flow, request.id, request.value))
            error(ws, request.id, "invalid-message", "No such sign-in prompt");
          return;
        }
        if (request.type === "auth.cancel") {
          void (async () => {
            if (!(await auth.cancel(ws, request.flow)))
              return error(ws, request.id, "invalid-message", "No such sign-in flow");
            await catalog(ws, request.id, false, request.version.minor);
          })().catch(() => error(ws, request.id, "internal", "Could not read model catalog"));
          return;
        }
        if (request.type === "models.login") {
          const registry = options.modelRegistry;
          if (!registry) return error(ws, request.id, "not-found", "This daemon has no model registry");
          auth.start(
            ws,
            request.id,
            (frame) => send(ws, frame),
            async (interaction) => {
              await registry.models.login(request.provider, request.authType, interaction);
              await catalog(ws, request.id, true, request.version.minor);
            },
            `model:${request.provider}`,
          );
          return;
        }
        if (
          request.type === "models.providers" ||
          request.type === "models.select" ||
          request.type === "models.logout"
        ) {
          const registry = options.modelRegistry;
          if (!registry) return error(ws, request.id, "not-found", "This daemon has no model registry");
          if (pendingCredentials >= 32)
            return error(ws, request.id, "invalid-message", "Too many pending model requests");
          pendingCredentials++;
          credentialQueue = credentialQueue.then(async () => {
            try {
              if (request.type === "models.select") await registry.select(request);
              if (request.type === "models.logout") {
                if (!registry.models.getProvider(request.provider)) throw new Error();
                await auth.cancelScope(`model:${request.provider}`);
                await registry.models.logout(request.provider);
              }
              await catalog(ws, request.id, request.type !== "models.providers", request.version.minor);
              if (request.type === "models.select") {
                // Apply while idle too: scheduled coordinator work must see the selection
                // without waiting for the owner to send another chat message.
                for (const project of known)
                  void (async () => {
                    await opening.get(project);
                    if (!closing) await ensureCoordinator(project);
                  })().catch(() => {});
              }
            } catch {
              error(
                ws,
                request.id,
                "invalid-message",
                request.type === "models.select"
                  ? "Choose an available model from a configured provider"
                  : "Could not access model credentials",
              );
            } finally {
              pendingCredentials--;
            }
          });
          return;
        }
        if (request.type === "credentials.set" || request.type === "credentials.status") {
          if (pendingCredentials >= 32)
            return error(ws, request.id, "invalid-message", "Too many pending credential requests");
          pendingCredentials += 1;
          // Serialize status with writes across connections. Never append/log the request or echo its body.
          credentialQueue = credentialQueue.then(async () => {
            try {
              const result = await dispatchCredentials(
                request,
                options.keychain ?? systemKeychain(),
                options.modelKinds,
                options.modelRegistry,
              );
              send(ws, result);
              if (request.type === "credentials.set" && result.type !== "error" && options.modelRegistry)
                await catalog(ws, request.id, true, request.version.minor);
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
        if (
          request.type === "chat.read" ||
          request.type === "chat.send" ||
          request.type === "chat.stop" ||
          request.type === "owner.answer"
        ) {
          // The room's requests (THE-1996, server/chat.ts): each answers once, its failure as one line.
          void (async () => {
            const coordinator =
              request.type === "chat.send" || request.type === "owner.answer"
                ? await ensureCoordinator(request.project)
                : coordinators.get(request.project);
            return dispatchChat(request, { store, workers, live: chat, coordinator });
          })()
            .then((reply) => send(ws, reply))
            .catch(() => error(ws, request.id, "internal", "Could not configure coordinator model"));
          return;
        }
        if (request.type === "session.release" || request.type === "session.output") {
          // The session page's actions (THE-2045, server/session.ts), through the coordinator's own Workers.
          void dispatchSession(request, { store, workers }).then((reply) => send(ws, reply));
          return;
        }
        if (request.type === "project.subscribe") {
          const seq = store.sequence;
          if (request.after > seq)
            return error(ws, request.id, "invalid-message", "Replay cursor is ahead of the daemon log");
          const previous = subscriptions.get(request.project);
          const subscription: Subscription = { id: randomUUID(), after: request.after, minor: request.version.minor };
          if (subscription.minor >= CHAT_LIVE_MINOR) subscription.chat = previous?.chat;
          else previous?.chat?.();
          const snapshot =
            request.after === 0 ? snapshotFor(snapshotOf(request.project), request.version.minor) : undefined;
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
          const coordinator = coordinators.get(request.project);
          if (coordinator && subscription.minor >= CHAT_LIVE_MINOR && !subscription.chat)
            subscription.chat = chat.subscribe(request.project, coordinator.conversation, (frame) => send(ws, frame));
          return;
        }
        const seq = store.sequence;
        const events = store
          .readSince(0, request.project)
          .filter((event) => {
            if ("session" in event.payload) return event.payload.session === request.sessionId;
            if (event.kind !== "coordinator.checkpoint") return false;
            const launch = workerLaunchCheckpointSchema.safeParse(event.payload.checkpoint);
            return launch.success && launch.data.session === request.sessionId;
          })
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
      unsubscribeAccount?.();
      const accountClosed = options.account?.close();
      const authClosing = auth.close();
      unsubscribe();
      for (const ws of sockets.clients) ws.terminate();
      connections.clear();
      sockets.close();
      const transport = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await chat.close();
      const results = await Promise.allSettled([
        transport,
        credentialQueue,
        pluginQueue,
        coordinatorManager?.close(),
        accountClosed,
        authClosing,
      ]);
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
            models: () => {
              const models = sources.get(config.project)?.models ?? config.models;
              return typeof models === "function" ? models() : models;
            },
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
