import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_MINOR,
  admitRequest,
  BRIEF_INSTRUCTIONS_MINOR,
  CHAT_LIVE_MINOR,
  CHAT_WAKE_MINOR,
  CONDUCTOR_MINOR,
  DELIVERIES_MINOR,
  eventSchema,
  MODELS_MINOR,
  type ModelKindEntry,
  PROVIDERS_MINOR,
  type Project,
  type ProjectTables,
  type ProtocolError,
  projectSchema,
  projectTablesSchema,
  READER_MINOR,
  REPLAY_MINOR,
  RULES_SCHEMA_MINOR,
  type ServerMessage,
  type Snapshot,
  type Subscribed,
  PROTOCOL_VERSION as version,
  WATCHDOG_MINOR,
  workerLaunchCheckpointSchema,
} from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { WebSocket, WebSocketServer } from "ws";
import type { CoordinatorOptions, ProjectCoordinator } from "../../coordinator/index.ts";
import { dispatchCredentials } from "../credentials.ts";
import { type Keychain, systemKeychain } from "../keychain.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { Projects } from "../projects.ts";
import type { EventStore } from "../store.ts";
import type { Workers } from "../workers/service.ts";
import type { Account } from "./account.ts";
import { AuthFlows } from "./auth.ts";
import { dispatchChat } from "./chat.ts";
import { type ChatClock, ChatLive } from "./chat-live.ts";
import { dispatchPlugins, isPluginsRequest, type PluginHost } from "./plugins.ts";
import { dispatchProjects } from "./projects.ts";
import type { Providers } from "./providers.ts";
import { jsonBytes, PAGE_BYTES, REPLAY_WINDOW, Replay, replayFrames } from "./replay.ts";
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
  projectRegistry?: Projects;
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
  providers?: Providers;
  /** A visible room changed; subscriptions alone do not count as owner presence. */
  onRoomPresence?: (project: string) => void;
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
  isRoomVisible(project: string): boolean;
  /** Closes connections/listeners; the caller still owns and closes the store. Idempotent. */
  openProject(config: CoordinatorOptions): Promise<void>;
  closeProject(project: string): Promise<void>;
  close(): Promise<void>;
}
interface Subscription {
  minor: number;
  id: string;
  after: number;
  chat?: () => void;
  cancel?: () => void;
  pending?: boolean;
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
  let projects = options.projects.map((p) => projectSchema.parse(p));
  if (new Set(projects.map((p) => p.id)).size !== projects.length) throw new Error("Duplicate project id");
  const known = new Set(projects.map((p) => p.id));
  const configured = options.coordinators ?? [];
  if (new Set(configured.map((entry) => entry.project)).size !== configured.length)
    throw new Error("Duplicate coordinator project");
  if (configured.some((entry) => !known.has(entry.project))) throw new Error("Unknown coordinator project");
  const coordinatorManager = new (await import("../../coordinator/index.ts")).Coordinators(store);
  const coordinators = new Map<string, ProjectCoordinator>();
  const sources = new Map(configured.map((config) => [config.project, config]));
  const opening = new Map<string, Promise<ProjectCoordinator | undefined>>();
  const closingProjects = new Set<string>();
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
  const transfers = new Map<WebSocket, Replay>();
  const minors = new Map<WebSocket, number>();
  const visibleRooms = new Map<WebSocket, string>();
  const isRoomVisible = (project: string) => [...visibleRooms.values()].includes(project);
  const setRoomPresence = (ws: WebSocket, project: string | null) => {
    const previous = visibleRooms.get(ws);
    if (previous === project || (previous === undefined && project === null)) return;
    const before = new Map(
      [previous, project].filter((p): p is string => p !== undefined && p !== null).map((p) => [p, isRoomVisible(p)]),
    );
    if (project === null) visibleRooms.delete(ws);
    else visibleRooms.set(ws, project);
    for (const [id, wasVisible] of before) if (wasVisible !== isRoomVisible(id)) options.onRoomPresence?.(id);
  };
  const auth = new AuthFlows();
  const chat = new ChatLive(options.chatClock);
  const providerFlows = new Map<WebSocket, Set<string>>();
  const stopProviders = options.providers?.subscribe((providers) => {
    for (const [ws, minor] of minors)
      if (minor >= PROVIDERS_MINOR)
        send(ws, { type: "providers.catalog", version, id: `push:${randomUUID()}`, providers });
  });
  const unsubscribeAccount = options.account?.subscribe((state) => {
    void options.providers?.refresh(true).catch(() => {});
    for (const [ws, minor] of minors)
      if (minor >= ACCOUNT_MINOR) send(ws, { type: "account.result", version, ...state });
  });

  function send(ws: WebSocket, message: ServerMessage, done?: () => void): void {
    transfers.get(ws)?.send(message, done);
  }
  const error = (ws: WebSocket, id: string | undefined, code: ProtocolError["code"], message: string) =>
    send(ws, { type: "error", version, ...(id ? { id } : {}), code, message });

  function sendChat(ws: WebSocket, minor: number, frame: ServerMessage): void {
    if (minor < CHAT_WAKE_MINOR && frame.type === "chat.tool") {
      const { progress: _, ...legacy } = frame;
      send(ws, legacy);
    } else send(ws, frame);
  }

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
    if (closing || closingProjects.has(project) || !known.has(project)) return undefined;
    if (!options.resolveCoordinator || !coordinatorManager) return coordinators.get(project);
    const pending = opening.get(project);
    if (pending) return pending;
    const next = (async () => {
      const config = await options.resolveCoordinator?.(project);
      if (!config || closing || closingProjects.has(project)) return undefined;
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
          if (closing || closingProjects.has(project)) return undefined;
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
          ...(workers ? { workers } : {}),
        },
      });
      coordinators.set(project, coordinator);
      for (const [ws, subscriptions] of connections) {
        const subscription = subscriptions.get(project);
        if (subscription && subscription.minor >= CHAT_LIVE_MINOR && !subscription.chat)
          subscription.chat = chat.subscribe(project, coordinator.conversation, (frame) =>
            sendChat(ws, subscription.minor, frame),
          );
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

  const stopProjectLists = options.projectRegistry?.subscribe(() => {
    if (!options.projectRegistry) return;
    projects = options.projectRegistry.list.map((p) => projectSchema.parse(p));
    for (const project of projects) if (!known.has(project.id)) closingProjects.delete(project.id);
    known.clear();
    for (const project of projects) known.add(project.id);
    for (const ws of connections.keys())
      send(ws, { type: "projects.result", version, id: "projects-changed", projects });
  });

  async function openProject(config: CoordinatorOptions): Promise<void> {
    closingProjects.delete(config.project);
    sources.set(config.project, config);
    const coordinator = await coordinatorManager.open({
      ...config,
      models: () => {
        const models = sources.get(config.project)?.models ?? config.models;
        return typeof models === "function" ? models() : models;
      },
      native: {
        ...config.native,
        ...(workers ? { workers } : {}),
      },
    });
    coordinators.set(config.project, coordinator);
  }
  async function closeProject(project: string): Promise<void> {
    closingProjects.add(project);
    for (const [ws, visible] of visibleRooms) if (visible === project) setRoomPresence(ws, null);
    // Closing rejects idle waiters; a pending model switch may be waiting on one.
    await coordinatorManager.remove(project);
    await opening.get(project)?.catch(() => {});
    for (const subscriptions of connections.values()) {
      const subscription = subscriptions.get(project);
      subscription?.chat?.();
      if (subscription) subscription.chat = undefined;
    }
    coordinators.delete(project);
    sources.delete(project);
  }

  /** A project's folded tables at the store's cursor, as the protocol's JSON value. */
  function snapshotOf(project: string): Snapshot {
    const seq = store.sequence;
    // Normalize optional undefined fields to JSON, then validate without changing wire key order.
    const tables = store.fold(project).projects[project] ?? emptyProject();
    return { seq, state: projectTablesSchema.parse(JSON.parse(JSON.stringify(tables))) };
  }

  /** Older same-major clients validate inbox kinds, routing and policy fields strictly. */
  function snapshotFor(snapshot: Snapshot, minor: number): Snapshot {
    if (minor >= WATCHDOG_MINOR) return snapshot;
    const state = { ...(snapshot.state as unknown as ProjectTables) };
    if (minor < DELIVERIES_MINOR) {
      delete state.deliveries;
      state.inbox = state.inbox.filter((item) => item.kind !== "delivery-failed");
    }
    const legacy = {
      ...state,
      inbox:
        minor >= CHAT_WAKE_MINOR
          ? state.inbox.filter((item) => minor >= WATCHDOG_MINOR || item.kind !== "liveness")
          : state.inbox.filter((item) =>
              ["question", "plan", "hand-back", "owner-request", "launch"].includes(item.kind),
            ),
    };
    const rules = state.rules;
    if (rules) {
      const value = { ...rules.value };
      if (minor < BRIEF_INSTRUCTIONS_MINOR) {
        const withoutInstructions = <T extends { instructions?: string }>(route: T) => {
          const copy = { ...route };
          delete copy.instructions;
          return copy;
        };
        value.routing = value.routing?.map(withoutInstructions);
        if (value.defaultRoute) value.defaultRoute = withoutInstructions(value.defaultRoute);
      }
      if (minor < CONDUCTOR_MINOR) {
        value.routing = value.routing?.filter((route) => route.cli !== "conductor");
        if (value.defaultRoute?.cli === "conductor") value.defaultRoute = null;
      }
      if (minor < RULES_SCHEMA_MINOR) delete value.gates;
      if (value.policy) {
        const policy = { ...value.policy };
        if (minor < WATCHDOG_MINOR) delete policy.watchdogModel;
        if (minor < CHAT_WAKE_MINOR) {
          delete policy.coordinatorMinutes;
          delete policy.notStartedMinutes;
        }
        if (minor < RULES_SCHEMA_MINOR) {
          delete policy.plans;
          delete policy.approvalLabel;
          delete policy.preApprovedLabel;
        }
        value.policy = policy;
      }
      legacy.rules = { ...rules, value };
    }
    // Detach only the legacy projection; never mutate the full snapshot shared with current clients.
    return { seq: snapshot.seq, state: JSON.parse(JSON.stringify(legacy)) };
  }

  /** Capture a cursor and fold together; later commits wait until these pages drain. */
  function batch(
    ws: WebSocket,
    project: string,
    subscription: Subscription,
    folded: Map<string, Snapshot> = new Map(),
    acknowledgment?: Subscribed,
  ): void {
    if (subscription.pending) return;
    const seq = store.sequence;
    const rows = store.readSince(subscription.after, project, REPLAY_WINDOW + 1);
    let events = rows
      // The room watches checkpoint cursors to refresh chat.read; never ship durable document bodies.
      .map((event) => (event.kind === "coordinator.checkpoint" ? { ...event, payload: { checkpoint: null } } : event))
      .map((event) => eventSchema.parse(event));
    const base = { type: "events" as const, version, project, subscriptionId: subscription.id, seq };
    const overhead = jsonBytes({ ...base, events: [], more: true });
    const reset =
      (acknowledgment && subscription.after === 0) ||
      rows.length > REPLAY_WINDOW ||
      events.some((event) => jsonBytes(event) + overhead > PAGE_BYTES);
    let snapshot: Snapshot | undefined;
    if (acknowledgment || rows.length) {
      snapshot = folded.get(project) ?? snapshotOf(project);
      folded.set(project, snapshot);
      snapshot = snapshotFor(snapshot, subscription.minor);
    }
    // Older apps do not understand partial replay. Large updates can still use their snapshot contract.
    if (reset || (subscription.minor < REPLAY_MINOR && jsonBytes({ ...base, events, snapshot }) > PAGE_BYTES))
      events = [];
    const ack = acknowledgment ? { ...acknowledgment, ...(reset ? { snapshot } : {}) } : undefined;
    // Every reset carries state, either on the acknowledgment or on this frame.
    const frame = { ...base, events, ...(snapshot && !ack?.snapshot ? { snapshot } : {}) };
    subscription.after = seq;
    subscription.pending = true;
    function* frames() {
      if (ack) yield ack;
      yield* replayFrames(frame);
    }
    subscription.cancel = transfers.get(ws)?.replay(frames(), () => {
      subscription.pending = false;
      if (connections.get(ws)?.get(project) === subscription && store.sequence > subscription.after)
        batch(ws, project, subscription);
    });
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
    transfers.set(ws, new Replay(ws));
    let refused = false;
    ws.on("error", () => ws.terminate());
    const clearSubscriptions = () => {
      for (const subscription of subscriptions.values()) {
        subscription.chat?.();
        subscription.cancel?.();
      }
      subscriptions.clear();
    };
    ws.on("close", () => {
      transfers.get(ws)?.close();
      transfers.delete(ws);
      clearSubscriptions();
      setRoomPresence(ws, null);
      connections.delete(ws);
      minors.delete(ws);
      void auth.cancel(ws);
      providerFlows.delete(ws);
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
          setRoomPresence(ws, null);
          ws.close(1008);
        }
        return;
      }
      const request = admitted.request;
      minors.set(ws, request.version.minor);
      try {
        if (request.type === "fleet.shutdown") {
          // Owner loopback WebSocket admission only; deliberately absent from coordinator/worker tools.
          if (!projects.some((project) => project.id === request.project))
            return error(ws, request.id, "not-found", "Unknown fleet project");
          if (!workers) return error(ws, request.id, "not-found", "Worker runtime unavailable");
          void workers
            .shutdown(request.project, request.reason, () => {
              if (closing || ws.readyState !== WebSocket.OPEN) throw new Error("Owner connection closed");
            })
            .then((result) =>
              send(ws, { type: "fleet.shutdown.result", version, id: request.id, project: request.project, ...result }),
            )
            .catch(() => error(ws, request.id, "internal", "Fleet shutdown failed; inspect the remaining workers"));
          return;
        }
        if (request.type === "providers.connect") {
          const providers = options.providers;
          if (!providers) return error(ws, request.id, "not-found", "This daemon has no provider catalog");
          const provider = request.provider ?? request.id;
          const flows = providerFlows.get(ws) ?? new Set<string>();
          providerFlows.set(ws, flows);
          flows.add(request.id);
          auth.start(
            ws,
            request.id,
            (frame) => {
              if (frame.type === "error") flows.delete(request.id);
              send(ws, frame);
            },
            async (interaction) => {
              try {
                await providers.connect(provider, interaction);
                interaction.signal?.throwIfAborted();
                const catalog = await providers.refresh(true);
                interaction.signal?.throwIfAborted();
                send(ws, { type: "providers.catalog", version, id: request.id, providers: catalog });
              } finally {
                flows.delete(request.id);
              }
            },
            `plugin:${provider}`,
          );
          return;
        }
        if (request.type === "providers.answer") {
          const flow = request.flow ?? providerFlows.get(ws)?.values().next().value;
          if (
            !flow ||
            !providerFlows.get(ws)?.has(flow) ||
            !auth.answer(ws, flow, request.promptId ?? request.id, request.value)
          )
            error(ws, request.id, "invalid-message", "No such sign-in prompt");
          return;
        }
        if (
          request.type === "providers.list" ||
          request.type === "providers.disconnect" ||
          request.type === "providers.cancel"
        ) {
          const providers = options.providers;
          if (!providers) return error(ws, request.id, "not-found", "This daemon has no provider catalog");
          void (async () => {
            if (request.type === "providers.cancel") {
              const flow = request.flow ?? providerFlows.get(ws)?.values().next().value;
              if (!flow || !providerFlows.get(ws)?.has(flow) || !(await auth.cancel(ws, flow)))
                return error(ws, request.id, "invalid-message", "No such provider sign-in flow");
            } else if (request.type === "providers.disconnect") {
              const provider = request.provider ?? request.id;
              await auth.cancelScope(`plugin:${provider}`);
              await providers.disconnect(provider);
            }
            send(ws, { type: "providers.catalog", version, id: request.id, providers: await providers.refresh() });
          })().catch(() =>
            error(ws, request.id, "internal", "Provider connection did not complete. Check its status and try again."),
          );
          return;
        }
        if (request.type === "auth.answer") {
          if (!auth.answer(ws, request.flow, request.id, request.value))
            error(ws, request.id, "invalid-message", "No such sign-in prompt");
          return;
        }
        if (request.type === "auth.cancel") {
          void (async () => {
            const providerFlow = providerFlows.get(ws)?.has(request.flow) ?? false;
            if (!(await auth.cancel(ws, request.flow)))
              return error(ws, request.id, "invalid-message", "No such sign-in flow");
            if (providerFlow && options.providers)
              send(ws, {
                type: "providers.catalog",
                version,
                id: request.id,
                providers: await options.providers.refresh(true),
              });
            else await catalog(ws, request.id, false, request.version.minor);
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
        if (
          request.type === "account.status" ||
          request.type === "account.login" ||
          request.type === "account.logout"
        ) {
          if (!options.account) return error(ws, request.id, "offline", "Armada account is unavailable");
          void options.account.dispatch(request, (reply) => send(ws, reply));
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
                await new Promise<void>((resolve) => {
                  const done = () => {
                    ws.off("close", done);
                    resolve();
                  };
                  ws.once("close", done);
                  if (ws.readyState === WebSocket.OPEN)
                    send(ws, { type: "daemon.restarting", version, id: request.id }, done);
                  else done();
                });
                if (!closing) options.restart?.();
                return;
              }
              const result = await dispatchPlugins(request, host, !!options.restart);
              send(ws, result);
              if (result.type === "plugins.result" && request.type !== "plugins.list")
                await options.providers?.refresh(true);
            } catch {
              error(ws, request.id, "internal", "The daemon could not read its plugins");
            } finally {
              pendingPlugins -= 1;
            }
          });
          return;
        }
        if (
          request.type === "projects.inspect" ||
          request.type === "projects.add" ||
          request.type === "projects.remove"
        ) {
          void dispatchProjects(request, options.projectRegistry).then((reply) => send(ws, reply));
          return;
        }
        if (request.type === "projects.list") {
          send(ws, { type: "projects.result", version, id: request.id, projects });
          return;
        }
        if (request.type === "room.presence") {
          if (request.version.minor < READER_MINOR)
            return error(ws, request.id, "invalid-message", "Room presence requires protocol minor 14");
          if (request.project !== null && !known.has(request.project))
            return error(ws, request.id, "not-found", "No such project");
          setRoomPresence(ws, request.project);
          return;
        }
        const historical =
          (request.type === "project.subscribe" ||
            request.type === "session.read" ||
            request.type === "fleet.history") &&
          store.readSince(0, request.project, 1).length > 0;
        if (!known.has(request.project) && !historical) return error(ws, request.id, "not-found", "No such project");

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
        if (request.type === "fleet.history") {
          if (request.version.minor < REPLAY_MINOR)
            return error(ws, request.id, "invalid-message", "History reads require protocol minor 21");
          const limit = request.limit ?? 50;
          const rows = store.history(request.project, request.ticket, request.cursor, limit + 1);
          const events: ReturnType<typeof eventSchema.parse>[] = [];
          let bytes = 256 + jsonBytes(request.project) + jsonBytes(request.id);
          for (const row of rows.slice(0, limit)) {
            let payload: unknown = row.payload;
            if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
              const publicPayload = { ...payload } as Record<string, unknown>;
              delete publicPayload.receipt;
              if (row.kind === "ticket.seen") {
                delete publicPayload.description;
                delete publicPayload.comments;
              }
              if (row.kind === "coordinator.checkpoint") {
                const launch = workerLaunchCheckpointSchema.safeParse(publicPayload.checkpoint);
                publicPayload.checkpoint = launch.success ? launch.data : null;
              }
              // Correlated replies still identify their ticket when their opening row is on an earlier page.
              if (request.ticket) publicPayload.ticket = request.ticket;
              payload = publicPayload;
            }
            const event = eventSchema.parse({ ...row, payload });
            if (bytes + jsonBytes(event) + 1 > PAGE_BYTES) {
              if (!events.length)
                return error(ws, request.id, "invalid-message", "History event exceeds the 1 MiB page limit");
              break;
            }
            bytes += jsonBytes(event) + 1;
            events.push(event);
          }
          send(ws, {
            type: "fleet.history.result",
            version,
            id: request.id,
            project: request.project,
            events,
            cursor: rows.length > events.length ? (events.at(-1)?.seq ?? null) : null,
          });
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
          previous?.cancel?.();
          const subscription: Subscription = { id: randomUUID(), after: request.after, minor: request.version.minor };
          if (subscription.minor >= CHAT_LIVE_MINOR && previous?.minor === subscription.minor)
            subscription.chat = previous.chat;
          else previous?.chat?.();
          subscriptions.set(request.project, subscription);
          batch(ws, request.project, subscription, new Map(), {
            ...request,
            type: "project.subscribed",
            version,
            subscriptionId: subscription.id,
          });
          const coordinator = coordinators.get(request.project);
          if (coordinator && subscription.minor >= CHAT_LIVE_MINOR && !subscription.chat)
            subscription.chat = chat.subscribe(request.project, coordinator.conversation, (frame) =>
              sendChat(ws, subscription.minor, frame),
            );
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
    stopProviders?.();
    options.providers?.close();
    unsubscribeAccount?.();
    await auth.close();
    stopProjectLists?.();
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
      const authClosing = auth.close();
      stopProviders?.();
      options.providers?.close();
      providerFlows.clear();
      unsubscribeAccount?.();
      const accountClosed = options.account?.close();
      stopProjectLists?.();
      unsubscribe();
      for (const ws of sockets.clients) {
        transfers.get(ws)?.close();
        setRoomPresence(ws, null);
        ws.terminate();
      }
      connections.clear();
      transfers.clear();
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
        authClosing,
        coordinatorManager?.close(),
        accountClosed,
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return closed;
  };
  try {
    for (const config of configured) await openProject(config);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    url: `http://${authority}`,
    wsUrl: `ws://${authority}/`,
    coordinators,
    isRoomVisible,
    openProject,
    closeProject,

    close,
  };
}
