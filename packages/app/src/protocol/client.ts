import {
  ACCOUNT_MINOR,
  type AccountDevice,
  type AccountRequest,
  type AccountState,
  APP_TOO_OLD,
  type AuthFrame,
  type ChatDelta,
  type ChatReadRequest,
  type ChatSendRequest,
  type ChatStopRequest,
  type ChatTool,
  type ChatTurn,
  type ClientMessage,
  type CredentialsResult,
  DAEMON_TOO_OLD,
  MODELS_MINOR,
  type ModelConfig,
  type ModelsCatalog,
  type OwnerAnswerRequest,
  type PluginRequest,
  type PluginsResult,
  PROTOCOL_VERSION,
  type Project,
  type ProtocolEvent,
  type ProtocolVersion,
  type ServerMessage,
  type SessionOutputRequest,
  type SessionReleaseRequest,
  type Snapshot,
  serverMessageSchema,
  versionSchema,
} from "@armada/protocol";

/** Where the connection is: listing, live, waiting to reconnect, or refused for good (another major). */
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "refused";

/** One subscribed project: every event applied so far and the cursor to resume from. */
export interface ProjectLog {
  seq: number;
  events: readonly ProtocolEvent[];
}

/** What the screens read. A new object on every change, so React can compare it by identity. */
export interface DaemonState {
  status: ConnectionStatus;
  /** One line for the owner when the daemon refused this app or sent what it cannot read. */
  problem: string | null;
  /** null until the daemon listed them; kept across reconnects so the sidebar never blanks. */
  projects: readonly Project[] | null;
  logs: Readonly<Record<string, ProjectLog>>;
  /** Each project's folded state, the latest the daemon sent; its shape is the daemon's (src/fleet/state.ts reads it). */
  fleets: Readonly<Record<string, Snapshot>>;
  account: AccountState | null;
  accountDevice: AccountDevice | null;
  accountProblem: string | null;
  credentials: Omit<CredentialsResult, "id" | "type" | "version"> | null;
  catalog: Pick<ModelsCatalog, "providers" | "selected"> | null;
  /** The models.login request id, also used by every auth frame and prompt in this flow. */
  authFlow: string | null;
  /** The daemon's wire minor, once it listed its projects: what it can be asked (the room needs `CHAT_MINOR`). */
  minor: number | null;
  /** The bundled plugins as the daemon last listed them; null until it did (kept across reconnects). */
  plugins: Pick<PluginsResult, "plugins" | "restartable"> | null;
  /** Why the daemon could not list them (an older daemon, a broken app configuration). */
  pluginsProblem: string | null;
  /** The daemon confirmed a restart and is not back yet. */
  restarting: boolean;
}

/** A project's live turn as the daemon streams it (CHAT_LIVE_MINOR): its state, a partial answer, a tool call. */
export type ChatFrame = ChatTurn | ChatDelta | ChatTool;

/** The part of a browser WebSocket the client uses, so tests hand it a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface ClientOptions {
  url: string;
  open: (url: string) => SocketLike;
  /** Run `run` after `ms`; returns its cancel. Injected: tests never wait on the clock. */
  schedule: (run: () => void, ms: number) => () => void;
  version?: ProtocolVersion;
  /** Waits before each reconnect attempt; the last repeats. */
  backoff?: readonly number[];
}

export interface DaemonClient {
  getState(): DaemonState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  saveCredentials(provider: string, key: string, config?: ModelConfig): Promise<void>;
  login(): Promise<void>;
  login(provider: string, authType: "oauth" | "api_key"): Promise<void>;
  answer(flow: string, id: string, value: string): void;
  cancel(flow?: string): Promise<void>;
  logout(): Promise<void>;
  logout(provider: string): Promise<void>;
  select(provider: string, model: string): Promise<void>;
  auth(listener: (frame: AuthFrame) => void): () => void;
  /** Each resolves once the daemon saved the change and listed the plugins again; none is replayed after a drop. */
  setPluginEnabled(plugin: string, enabled: boolean): Promise<void>;
  configurePlugin(plugin: string, seam: string, kind: string, config: Json): Promise<void>;
  setPluginSecret(plugin: string, name: string, value: string): Promise<void>;
  /** Asks the daemon to restart (the desktop shell starts it again); the client reconnects as after any drop. */
  restartDaemon(): Promise<void>;
  /**
   * Sends one of the room's or a session page's requests on the live connection and resolves with
   * its reply; an error reply rejects with its line. A drop rejects it too: it
   * is never replayed, so the screen decides whether to send it again (a chat
   * message keeps its requestId, and the daemon admits it once).
   */
  request<R extends DaemonRequest>(message: R): Promise<DaemonReply<R>>;
  /** Hears every project's live turn frames (the room filters its own); returns its unsubscribe. */
  chat(listener: (frame: ChatFrame) => void): () => void;
}

/** A room or session request the screens send and await, without its envelope (`version`, `id`): the client adds it. */
type DaemonRequest = Unaddressed<
  | ChatReadRequest
  | ChatSendRequest
  | ChatStopRequest
  | OwnerAnswerRequest
  | SessionReleaseRequest
  | SessionOutputRequest
  | Exclude<AccountRequest, { type: "account.status" }>
>;
/** The reply to each of them. */
type DaemonReply<R extends DaemonRequest> = Extract<
  ServerMessage,
  {
    type: {
      "account.login": "account.result";
      "account.logout": "account.result";
      "chat.read": "chat.result";
      "chat.send": "chat.sent";
      "chat.stop": "chat.stopped";
      "owner.answer": "owner.answered";
      "session.release": "session.release.result";
      "session.output": "session.output.result";
    }[R["type"]];
  }
>;

/** A request before the client gives it its id and version. */
type Unaddressed<M> = M extends unknown ? Omit<M, "id" | "version"> : never;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const BACKOFF = [250, 500, 1000, 2000, 5000];
export const UNREADABLE = "The daemon sent a message this app cannot read";
export const NOT_FOLDED = "The daemon does not send its folded state live: update it";
export const LOG_BEHIND = "The daemon's log is behind what this app has read: reload the app";
const NOT_ANSWERED = "The daemon did not answer: the connection dropped. Try again.";
export const unusableAddress = (url: string) => `This daemon address is not usable: ${url}`;
export const NO_PLUGINS = "This daemon lists no providers: update it";
export const UNCONFIRMED = "The daemon did not confirm this change. Check the list before trying again.";

export const initialState: DaemonState = {
  status: "connecting",
  problem: null,
  projects: null,
  logs: {},
  fleets: {},
  account: null,
  accountDevice: null,
  accountProblem: null,
  credentials: null,
  catalog: null,
  authFlow: null,
  minor: null,
  plugins: null,
  pluginsProblem: null,
  restarting: false,
};

/**
 * The app's one connection to the daemon (packages/protocol): list the
 * projects, subscribe to each from its last applied cursor, apply the event
 * frames and keep the folded state they carry, and reconnect after a drop,
 * resuming where each project stopped. A frame it cannot read may have carried events, so it drops the connection
 * and resumes from the last applied cursor rather than skip them. A daemon of
 * another major is refused with one line and never retried.
 */
export function createDaemonClient(options: ClientOptions): DaemonClient {
  const version = options.version ?? PROTOCOL_VERSION;
  const backoff = options.backoff ?? BACKOFF;
  const listeners = new Set<() => void>();
  const chatListeners = new Set<(frame: ChatFrame) => void>();
  const authListeners = new Set<(frame: AuthFrame) => void>();
  const pendingModels = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let state = initialState;
  let socket: SocketLike | null = null;
  let cancelRetry: (() => void) | null = null;
  let attempt = 0;
  let nextId = 0;
  let running = false;
  let accountStatusId: string | null = null;
  function askAccount(type: "account.login" | "account.logout"): Promise<void> {
    if (state.status !== "live" || (state.minor ?? 0) < ACCOUNT_MINOR)
      return Promise.reject(new Error("Update Armada to sign in."));
    set({ accountProblem: null });
    return request({ type })
      .then(
        () => {},
        (error: Error) => {
          set({ accountProblem: error.message });
          throw error;
        },
      )
      .finally(() => set({ accountDevice: null }));
  }
  let credentialStatusId: string | null = null;
  let pendingCredential: {
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
    cancel: () => void;
  } | null = null;
  function failCredential() {
    const pending = pendingCredential;
    pendingCredential = null;
    pending?.cancel();
    pending?.reject(new Error("Key was not confirmed saved. Reconnect and check its status before trying again."));
  }
  let pluginListId: string | null = null;
  /** Every plugin request of this connection: a reply past its deadline is still recognised as one. */
  let pluginIds = new Set<string>();
  /** Plugin changes and the restart awaiting their answer, by request id. */
  const pendingPlugins = new Map<string, { resolve: () => void; reject: (error: Error) => void; cancel: () => void }>();
  function settlePlugin(requestId: string, error?: Error) {
    const pending = pendingPlugins.get(requestId);
    if (!pending) return false;
    pendingPlugins.delete(requestId);
    pending.cancel();
    if (error) pending.reject(error);
    else pending.resolve();
    return true;
  }
  /** The screens' requests awaiting their reply, by id; all rejected when the connection drops. */
  const pending = new Map<string, { resolve: (reply: ServerMessage) => void; reject: (error: Error) => void }>();
  function dropRequests() {
    const waiting = [...pending.values()];
    pending.clear();
    for (const request of waiting) request.reject(new Error(NOT_ANSWERED));
    for (const request of pendingModels.values()) request.reject(new Error(NOT_ANSWERED));
    pendingModels.clear();
    set({ authFlow: null });
  }
  type ModelRequest = Unaddressed<
    Extract<
      ClientMessage,
      { type: "models.providers" | "models.login" | "models.logout" | "models.select" | "auth.cancel" }
    >
  >;
  function askModels(message: ModelRequest): Promise<void> {
    if (!running || !socket || state.status !== "live" || (state.minor ?? 0) < MODELS_MINOR)
      return Promise.reject(new Error("Connect to a daemon with model sign-in support."));
    if (message.type === "models.login" && state.authFlow)
      return Promise.reject(new Error("Another sign-in is in progress"));
    return new Promise<void>((resolve, reject) => {
      const requestId = id();
      pendingModels.set(requestId, { resolve, reject });
      if (message.type === "models.login") set({ authFlow: requestId });
      try {
        send({ ...message, version, id: requestId });
      } catch {
        pendingModels.delete(requestId);
        if (state.authFlow === requestId) set({ authFlow: null });
        reject(new Error(NOT_ANSWERED));
      }
    });
  }
  function failPlugins() {
    for (const requestId of [...pendingPlugins.keys()]) settlePlugin(requestId, new Error(UNCONFIRMED));
  }
  function askPlugins(message: Unaddressed<PluginRequest>) {
    if (state.status !== "live" || !state.plugins)
      return Promise.reject(new Error("Wait for the daemon before changing a plugin."));
    return new Promise<void>((resolve, reject) => {
      const requestId = id();
      pluginIds.add(requestId);
      pendingPlugins.set(requestId, {
        resolve,
        reject,
        cancel: options.schedule(() => settlePlugin(requestId, new Error(UNCONFIRMED)), 10000),
      });
      try {
        send({ ...message, version, id: requestId });
      } catch {
        settlePlugin(requestId, new Error(UNCONFIRMED));
      }
    });
  }
  /** Why the last connection ended: after an unreadable frame, the backoff keeps growing. */
  let lastDrop: "close" | "unreadable" = "close";
  /** Per connection: the subscription each project's frames arrive under. */
  let subscriptions = new Map<string, string>();

  const set = (next: Partial<DaemonState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const send = (message: ClientMessage) => socket?.send(JSON.stringify(message));
  const id = () => `r${++nextId}`;

  function connect() {
    cancelRetry = null;
    subscriptions = new Map();
    let current: SocketLike;
    try {
      current = options.open(options.url);
    } catch {
      return refuse(unusableAddress(options.url));
    }
    socket = current;
    current.onopen = () => send({ type: "projects.list", version, id: id() });
    current.onmessage = (event) => {
      if (socket === current) receive(event.data);
    };
    current.onclose = () => {
      if (socket !== current) return;
      lastDrop = "close";
      reconnect();
    };
  }

  /** Leave the current connection, if any, and try again after the next wait. */
  function reconnect() {
    failCredential();
    failPlugins();
    dropRequests();
    credentialStatusId = null;
    pluginListId = null;
    pluginIds = new Set();
    const closing = socket;
    socket = null;
    closing?.close();
    if (!running || state.status === "refused") return;
    set({ status: "reconnecting", credentials: null });
    const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 1000;
    attempt += 1;
    cancelRetry = options.schedule(connect, wait);
  }

  function unreadable() {
    set({ problem: UNREADABLE });
    lastDrop = "unreadable";
    reconnect();
  }

  function refuse(problem: string) {
    failCredential();
    failPlugins();
    dropRequests();
    credentialStatusId = null;
    pluginListId = null;
    pluginIds = new Set();
    set({ status: "refused", problem, credentials: null });
    const closing = socket;
    socket = null;
    closing?.close();
  }

  function receive(data: unknown) {
    let input: unknown;
    try {
      input = JSON.parse(String(data));
    } catch {
      return unreadable();
    }
    // The major first, before the body: a newer daemon's shape still gets its line.
    const envelope = versionSchema.safeParse((input as { version?: unknown } | null)?.version);
    if (envelope.success && envelope.data.major !== version.major) {
      return refuse(envelope.data.major > version.major ? APP_TOO_OLD : DAEMON_TOO_OLD);
    }
    const parsed = serverMessageSchema.safeParse(input);
    if (!parsed.success) return unreadable();
    apply(parsed.data);
  }

  function apply(message: ServerMessage) {
    switch (message.type) {
      case "projects.result": {
        if (lastDrop === "close") attempt = 0;
        set({ status: "live", problem: null, projects: message.projects, minor: message.version.minor });
        if (message.version.minor >= ACCOUNT_MINOR) {
          accountStatusId = id();
          send({ type: "account.status", version, id: accountStatusId });
        } else set({ account: null, accountProblem: "Update Armada to sign in." });
        if (message.version.minor >= 1) {
          credentialStatusId = id();
          send({ type: "credentials.status", version, id: credentialStatusId });
        }
        // Listed again on every connection: a restarted daemon says what it loaded.
        if (message.version.minor >= 2) {
          pluginListId = id();
          pluginIds.add(pluginListId);
          send({ type: "plugins.list", version, id: pluginListId });
        } else set({ plugins: null, pluginsProblem: NO_PLUGINS, restarting: false });
        if (message.version.minor >= MODELS_MINOR) {
          void askModels({ type: "models.providers" }).catch(() => {});
        } else set({ catalog: null });
        for (const project of message.projects) {
          send({ type: "project.subscribe", version, id: id(), project: project.id, after: cursor(project.id) });
        }
        return;
      }
      case "project.subscribed":
        subscriptions.set(message.project, message.subscriptionId);
        if (message.snapshot) set({ fleets: folded(message.project, message.snapshot) });
        return;
      case "events": {
        if (subscriptions.get(message.project) !== message.subscriptionId) return;
        const log = state.logs[message.project] ?? { seq: 0, events: [] };
        if (message.seq < log.seq) return set({ problem: LOG_BEHIND });
        const fresh = message.events.filter((event) => event.seq > log.seq);
        // Events past the folded state held, without a newer one: the daemon does not fold live for this app.
        const held = state.fleets[message.project];
        const stale = !message.snapshot && fresh.length > 0 && held !== undefined && message.seq > held.seq;
        set({
          logs: { ...state.logs, [message.project]: { seq: message.seq, events: [...log.events, ...fresh] } },
          fleets: folded(message.project, message.snapshot),
          ...(stale ? { problem: NOT_FOLDED } : {}),
        });
        return;
      }
      case "account.device":
        if (pending.has(message.id)) set({ accountDevice: message });
        return;
      case "account.result": {
        const { type: _type, version: _version, id: _id, ...account } = message;
        set({ account, accountProblem: null });
        if (message.id) {
          pending.get(message.id)?.resolve(message);
          pending.delete(message.id);
        }
        return;
      }
      case "credentials.result": {
        if (message.id !== credentialStatusId && message.id !== pendingCredential?.id) return;
        set({
          credentials: {
            provider: message.provider,
            storage: message.storage,
            ...(message.models ? { models: message.models } : {}),
            ...(message.config ? { config: message.config } : {}),
            ...(message.needsRepair ? { needsRepair: true } : {}),
          },
        });
        if (message.id === pendingCredential?.id) {
          const pending = pendingCredential;
          pendingCredential = null;
          pending.cancel();
          pending.resolve();
        }
        return;
      }
      case "plugins.result":
        // Always the whole list as saved now: a late reply is still the freshest one.
        if (!pluginIds.has(message.id)) return;
        // A restart ends once the daemon that came back listed what it loaded.
        set({
          plugins: { plugins: message.plugins, restartable: message.restartable },
          pluginsProblem: null,
          restarting: false,
        });
        settlePlugin(message.id);
        return;
      case "daemon.restarting":
        if (settlePlugin(message.id)) set({ restarting: true });
        return;
      case "models.catalog": {
        set({
          catalog: { providers: message.providers, selected: message.selected },
          ...(state.authFlow === message.id ? { authFlow: null } : {}),
        });
        const waiting = pendingModels.get(message.id);
        pendingModels.delete(message.id);
        waiting?.resolve();
        return;
      }
      case "auth.event":
      case "auth.prompt":
        if (message.flow === state.authFlow) for (const listener of authListeners) listener(message);
        return;
      case "chat.turn":
      case "chat.delta":
      case "chat.tool":
        for (const listener of chatListeners) listener(message);
        return;
      case "chat.result":
      case "chat.sent":
      case "chat.stopped":
      case "owner.answered":
      case "session.release.result":
      case "session.output.result": {
        const request = pending.get(message.id);
        pending.delete(message.id);
        request?.resolve(message);
        return;
      }
      case "error":
        if (message.id !== undefined && pendingModels.has(message.id)) {
          const waiting = pendingModels.get(message.id);
          pendingModels.delete(message.id);
          if (state.authFlow === message.id) set({ authFlow: null });
          waiting?.reject(new Error(message.message));
          return;
        }
        if (message.id === accountStatusId) return set({ accountProblem: message.message });
        if (message.id !== undefined && pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          request?.reject(new Error(message.message));
          return;
        }
        if (pendingCredential && message.id === pendingCredential.id) {
          failCredential();
          return;
        }
        if (message.id !== undefined && settlePlugin(message.id, new Error(message.message))) return;
        if (message.id !== undefined && message.id === pluginListId)
          return set({ pluginsProblem: message.message, restarting: false });
        // A plugin change's refusal past its deadline is not the fleet's problem.
        if (message.id !== undefined && pluginIds.has(message.id)) return;
        if (message.code === "app-too-old" || message.code === "daemon-too-old") return refuse(message.message);
        // The key's status failing is not the fleet's problem: it never hides one already said (and its Reload).
        if (message.id !== undefined && message.id === credentialStatusId && state.problem) return;
        return set({ problem: message.message });
      case "session.result":
        return;
    }
  }

  /** The folded states with this project's snapshot, unless the app already holds a later one. */
  function folded(project: string, snapshot: Snapshot | undefined): DaemonState["fleets"] {
    const held = state.fleets[project];
    if (!snapshot || (held && snapshot.seq < held.seq)) return state.fleets;
    return { ...state.fleets, [project]: snapshot };
  }

  const cursor = (project: string) => state.logs[project]?.seq ?? 0;

  function request<R extends DaemonRequest>(message: R): Promise<DaemonReply<R>> {
    if (state.status !== "live" || !socket)
      return Promise.reject(new Error("The daemon is not connected: wait for it, then try again."));
    return new Promise((resolve, reject) => {
      const requestId = id();
      pending.set(requestId, { resolve: resolve as (reply: ServerMessage) => void, reject });
      try {
        send({ ...message, version, id: requestId } as ClientMessage);
      } catch {
        pending.delete(requestId);
        reject(new Error(NOT_ANSWERED));
      }
    });
  }

  return {
    login: (provider?: string, authType?: "oauth" | "api_key") => provider === undefined ? askAccount("account.login") : askModels({ type: "models.login", provider, authType: authType ?? "oauth" }),
    answer(flow, promptId, value) {
      if (state.status !== "live" || !socket) throw new Error(NOT_ANSWERED);
      send({ type: "auth.answer", version, flow, id: promptId, value });
    },
    cancel: (flow) => {
      const active = flow ?? state.authFlow;
      return active
        ? askModels({ type: "auth.cancel", flow: active })
        : Promise.reject(new Error("No sign-in is in progress"));
    },
    logout: (provider?: string) => provider === undefined ? askAccount("account.logout") : askModels({ type: "models.logout", provider }),
    select: (provider, model) => askModels({ type: "models.select", provider, model }),
    auth(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
    saveCredentials(provider, key, config) {
      let local = false;
      try {
        const url = new URL(options.url);
        local = ["ws:", "wss:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      } catch {
        /* An invalid address is refused below. */
      }
      if (!local) return Promise.reject(new Error("Open the app on this device to save a key."));
      if (state.status !== "live" || !state.credentials || pendingCredential)
        return Promise.reject(new Error("Wait for the daemon before saving a key."));
      return new Promise<void>((resolve, reject) => {
        const requestId = id();
        pendingCredential = { id: requestId, resolve, reject, cancel: options.schedule(failCredential, 10000) };
        try {
          send({ type: "credentials.set", version, id: requestId, provider, key, ...(config ? { config } : {}) });
        } catch {
          failCredential();
        }
      });
    },
    setPluginEnabled: (plugin, enabled) => askPlugins({ type: enabled ? "plugins.enable" : "plugins.disable", plugin }),
    configurePlugin: (plugin, seam, kind, config) =>
      askPlugins({ type: "plugins.configure", plugin, seam, kind, config }),
    setPluginSecret: (plugin, name, value) => askPlugins({ type: "plugins.secret", plugin, name, value }),
    restartDaemon: () => askPlugins({ type: "daemon.restart" }),
    request,
    chat(listener) {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (running) return;
      running = true;
      connect();
    },
    stop() {
      failCredential();
      failPlugins();
      dropRequests();
      running = false;
      cancelRetry?.();
      cancelRetry = null;
      const closing = socket;
      socket = null;
      closing?.close();
    },
  };
}
