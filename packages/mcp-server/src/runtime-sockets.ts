import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";

export interface RuntimeSocketData {
  token: string;
  epoch: string;
  sandboxId: string;
}
interface Clock {
  now(): number;
  every(ms: number, callback: () => void): () => void;
}
const clock: Clock = {
  now: () => Date.now(),
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    return () => clearInterval(timer);
  },
};
type Socket = ServerWebSocket<RuntimeSocketData>;
interface Connection {
  ready: boolean;
  closed: boolean;
  busy: boolean;
  messageBusy: boolean;
  waiting: string | undefined;
  lastSeen: number;
  cancel(): void;
}

/** WSS is only a delivery/heartbeat path. The durable mailbox/HTTP result ACK stays authoritative. */
export function createRuntimeSockets(
  authority: ReturnType<typeof createRuntimeEnrolments>,
  commands: ReturnType<typeof createRuntimeCommands>,
  time: Clock = clock,
) {
  const connections = new Map<Socket, Connection>();
  const pending = new Set<Promise<unknown>>();
  let stopping = false;
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }
  function end(socket: Socket, code: number) {
    const state = connections.get(socket);
    if (!state || state.closed) return;
    state.closed = true;
    state.cancel();
    connections.delete(socket);
    try {
      socket.close(code);
    } catch {
      /* The peer may already have disconnected. */
    }
    // No tokens, request payloads or driver diagnostics in close reasons.
  }
  function failure(socket: Socket, error: unknown) {
    end(socket, error instanceof RuntimeEnrolmentDenied ? 4401 : 1012);
  }
  async function pump(socket: Socket) {
    const state = connections.get(socket);
    if (!state || state.closed || state.busy || stopping) return;
    if (!state.ready) {
      if (time.now() - state.lastSeen >= 8000) end(socket, 1002);
      return;
    }
    if (time.now() - state.lastSeen >= 30000) {
      end(socket, 1001);
      return;
    }
    state.busy = true;
    try {
      await commands.withNext(socket.data.token, socket.data.epoch, async (value) => {
        if (stopping || state.closed) return;
        if (!value.command) {
          state.waiting = undefined;
          return;
        }
        if (value.command.requestId === state.waiting) return; // Never flood a pending native RPC.
        const frame = JSON.stringify({ type: "command", epoch: value.epoch, request: value.command });
        if (Buffer.byteLength(frame) > 1048576) throw Error("runtime_frame_too_large");
        if (socket.send(frame) === 0) {
          end(socket, 1012);
          return;
        }
        state.waiting = value.command.requestId;
      });
    } catch (error) {
      failure(socket, error);
    } finally {
      state.busy = false;
    }
  }
  async function message(socket: Socket, raw: string | Buffer) {
    const state = connections.get(socket);
    if (!state || state.closed || stopping) return;
    if (state.messageBusy) {
      end(socket, 1008);
      return;
    }
    state.messageBusy = true;
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024) {
        end(socket, 1002);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        end(socket, 1002);
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        end(socket, 1002);
        return;
      }
      const value = frame as Record<string, unknown>;
      if (value.epoch !== socket.data.epoch) {
        end(socket, 4401);
        return;
      }
      if (
        Object.keys(value).some((key) => key !== "epoch" && key !== "type") ||
        typeof value.type !== "string" ||
        !["ready", "ping"].includes(value.type)
      ) {
        end(socket, 1002);
        return;
      }
      await authority.withSession(socket.data.token, socket.data.epoch, async () => {
        if (state.closed || stopping) return;
        if (value.type === "ready") {
          if (state.ready) {
            end(socket, 1002);
            return;
          }
          state.ready = true;
        } else {
          if (!state.ready) {
            end(socket, 1002);
            return;
          }
          if (socket.send(JSON.stringify({ type: "pong", epoch: socket.data.epoch })) === 0) {
            end(socket, 1012);
            return;
          }
        }
        state.lastSeen = time.now();
      });
    } catch (error) {
      failure(socket, error);
    } finally {
      state.messageBusy = false;
    }
    await pump(socket);
  }
  const websocket: WebSocketHandler<RuntimeSocketData> = {
    maxPayloadLength: 1024,
    backpressureLimit: 2 * 1048576,
    closeOnBackpressureLimit: true,
    idleTimeout: 30,
    sendPings: false,
    open(socket) {
      if (stopping) {
        socket.close(1012);
        return;
      }
      const state: Connection = {
        ready: false,
        closed: false,
        busy: false,
        messageBusy: false,
        waiting: undefined,
        lastSeen: time.now(),
        cancel: () => {},
      };
      connections.set(socket, state);
      state.cancel = time.every(1000, () => track(pump(socket)));
    },
    message: (socket, value) => track(message(socket, value)),
    close(socket) {
      const state = connections.get(socket);
      if (state) {
        state.closed = true;
        state.cancel();
        connections.delete(socket);
      }
    },
  };
  async function upgrade(
    request: Request,
    accept: (data: RuntimeSocketData) => boolean,
  ): Promise<Response | undefined> {
    const headers = { "cache-control": "no-store" };
    if (stopping) return new Response(null, { status: 503, headers });
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, allow: "GET" } });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426, headers: { ...headers, upgrade: "websocket" } });
    if (new URL(request.url).search) return new Response(null, { status: 400, headers });
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
    const epoch = request.headers.get("x-armada-runtime-epoch") ?? "";
    try {
      return await track(
        authority.withSession(token, epoch, async (_tx, scope) => {
          if (stopping) return new Response(null, { status: 503, headers });
          if (request.signal.aborted) return new Response(null, { status: 499, headers });
          return accept({ token, epoch: scope.epoch, sandboxId: scope.sandboxId })
            ? undefined
            : new Response(null, { status: 400, headers });
        }),
      );
    } catch (error) {
      return new Response(null, { status: error instanceof RuntimeEnrolmentDenied ? 401 : 503, headers });
    }
  }
  async function stop() {
    stopping = true;
    for (const socket of connections.keys()) end(socket, 1012);
    while (pending.size) await Promise.allSettled([...pending]);
  }
  return { upgrade, websocket, stop };
}
