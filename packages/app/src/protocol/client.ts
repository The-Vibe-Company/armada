import {
  APP_TOO_OLD,
  type ChatReadRequest,
  type ChatSendRequest,
  type ClientMessage,
  type CredentialsResult,
  DAEMON_TOO_OLD,
  type OwnerAnswerRequest,
  PROTOCOL_VERSION,
  type Project,
  type ProtocolEvent,
  type ProtocolVersion,
  type ServerMessage,
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
  credentials: Omit<CredentialsResult, "id" | "type" | "version"> | null;
  /** The daemon's wire minor, once it listed its projects: what it can be asked (the room needs 2). */
  minor: number | null;
}

/** A request the screens send and await, without its envelope (`version`, `id`): the client adds it. */
export type DaemonRequest = {
  [K in RequestOf["type"]]: Omit<Extract<RequestOf, { type: K }>, "version" | "id">;
}[RequestOf["type"]];
type RequestOf = ChatReadRequest | ChatSendRequest | OwnerAnswerRequest;
/** The reply to each of them. */
export type DaemonReply<R extends DaemonRequest> = Extract<
  ServerMessage,
  { type: { "chat.read": "chat.result"; "chat.send": "chat.sent"; "owner.answer": "owner.answered" }[R["type"]] }
>;

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
  /**
   * Sends one request on the live connection and resolves with its reply; an
   * error reply rejects with its line. A drop rejects it too: it is never
   * replayed, so the screen decides whether to send it again (a chat message
   * keeps its requestId, and the daemon admits it once).
   */
  request<R extends DaemonRequest>(message: R): Promise<DaemonReply<R>>;
}

const BACKOFF = [250, 500, 1000, 2000, 5000];
export const UNREADABLE = "The daemon sent a message this app cannot read";
export const NOT_FOLDED = "The daemon does not send its folded state live: update it";
export const LOG_BEHIND = "The daemon's log is behind what this app has read: reload the app";
export const NOT_ANSWERED = "The daemon did not answer: the connection dropped. Try again.";
export const unusableAddress = (url: string) => `This daemon address is not usable: ${url}`;

export const initialState: DaemonState = {
  status: "connecting",
  problem: null,
  projects: null,
  logs: {},
  fleets: {},
  credentials: null,
  minor: null,
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
  /** The screens' requests awaiting their reply, by id; all rejected when the connection drops. */
  const pending = new Map<string, { resolve: (reply: ServerMessage) => void; reject: (error: Error) => void }>();
  function dropRequests() {
    const waiting = [...pending.values()];
    pending.clear();
    for (const request of waiting) request.reject(new Error(NOT_ANSWERED));
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
    dropRequests();
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
    dropRequests();
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
        set({ status: "live", problem: null, projects: message.projects, minor: message.version.minor });
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
      case "chat.result":
      case "chat.sent":
      case "owner.answered": {
        const request = pending.get(message.id);
        pending.delete(message.id);
        request?.resolve(message);
        return;
      }
      case "error":
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
    request(message) {
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
