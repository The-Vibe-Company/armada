import {
  APP_TOO_OLD,
  type ClientMessage,
  type CredentialsResult,
  DAEMON_TOO_OLD,
  PROTOCOL_VERSION,
  type Project,
  type ProtocolEvent,
  type ProtocolVersion,
  type ServerMessage,
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
  credentials: Omit<CredentialsResult, "id" | "type" | "version"> | null;
}

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
  saveCredentials(provider: "anthropic" | "openai", key: string): Promise<void>;
}

const BACKOFF = [250, 500, 1000, 2000, 5000];
export const UNREADABLE = "The daemon sent a message this app cannot read";
export const LOG_BEHIND = "The daemon's log is behind what this app has read: reload the app";
export const unusableAddress = (url: string) => `This daemon address is not usable: ${url}`;

export const initialState: DaemonState = {
  status: "connecting",
  problem: null,
  projects: null,
  logs: {},
  credentials: null,
};

/**
 * The app's one connection to the daemon (packages/protocol): list the
 * projects, subscribe to each from its last applied cursor, apply the event
 * frames, and reconnect after a drop, resuming where each project stopped.
 * A frame it cannot read may have carried events, so it drops the connection
 * and resumes from the last applied cursor rather than skip them. A daemon of
 * another major is refused with one line and never retried.
 */
export function createDaemonClient(options: ClientOptions): DaemonClient {
  const version = options.version ?? PROTOCOL_VERSION;
  const backoff = options.backoff ?? BACKOFF;
  const listeners = new Set<() => void>();
  let state = initialState;
  let socket: SocketLike | null = null;
  let cancelRetry: (() => void) | null = null;
  let attempt = 0;
  let nextId = 0;
  let running = false;
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
    credentialStatusId = null;
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
    credentialStatusId = null;
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
        set({ status: "live", problem: null, projects: message.projects });
        if (message.version.minor >= 1) {
          credentialStatusId = id();
          send({ type: "credentials.status", version, id: credentialStatusId });
        }
        for (const project of message.projects) {
          send({ type: "project.subscribe", version, id: id(), project: project.id, after: cursor(project.id) });
        }
        return;
      }
      case "project.subscribed":
        subscriptions.set(message.project, message.subscriptionId);
        return;
      case "events": {
        if (subscriptions.get(message.project) !== message.subscriptionId) return;
        const log = state.logs[message.project] ?? { seq: 0, events: [] };
        if (message.seq < log.seq) return set({ problem: LOG_BEHIND });
        const fresh = message.events.filter((event) => event.seq > log.seq);
        set({ logs: { ...state.logs, [message.project]: { seq: message.seq, events: [...log.events, ...fresh] } } });
        return;
      }
      case "credentials.result": {
        if (message.id !== credentialStatusId && message.id !== pendingCredential?.id) return;
        set({ credentials: { provider: message.provider, storage: message.storage } });
        if (message.id === pendingCredential?.id) {
          const pending = pendingCredential;
          pendingCredential = null;
          pending.cancel();
          pending.resolve();
        }
        return;
      }
      case "error":
        if (pendingCredential && message.id === pendingCredential.id) {
          failCredential();
          return;
        }
        if (message.code === "app-too-old" || message.code === "daemon-too-old") return refuse(message.message);
        return set({ problem: message.message });
      case "session.result":
        return;
    }
  }

  const cursor = (project: string) => state.logs[project]?.seq ?? 0;

  return {
    saveCredentials(provider, key) {
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
          send({ type: "credentials.set", version, id: requestId, provider, key });
        } catch {
          failCredential();
        }
      });
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
      running = false;
      cancelRetry?.();
      cancelRetry = null;
      const closing = socket;
      socket = null;
      closing?.close();
    },
  };
}
