import type { IngestClient, RunnerRequest } from "./protocol.ts";

const MAX_FRAME = 1048576;
export class RuntimeChannelRevoked extends Error {
  constructor() {
    super("runtime_channel_revoked");
  }
}
export interface RuntimeSession {
  sandboxId: string;
  epoch: string;
  runtimeToken: string;
}
export interface RuntimeEnrolment extends RuntimeSession {
  configuration: Record<string, unknown>;
}
interface Socket extends EventTarget {
  send(data: string): void;
  terminate(): void;
}
export interface DialoutIo {
  fetch(url: URL, options: RequestInit): Promise<Response>;
  socket(url: URL, headers: Record<string, string>): Socket;
  after(ms: number, callback: () => void): () => void;
  every(ms: number, callback: () => void): () => void;
}
const nativeIo: DialoutIo = {
  fetch: (url, options) => fetch(url, options),
  socket: (url, headers) => new WebSocket(url, { headers }),
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    return () => clearInterval(timer);
  },
};
function origin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error("invalid_runtime_origin");
  return url;
}
async function json(response: Response, limit = MAX_FRAME): Promise<unknown> {
  if (!response.body) throw Error("invalid_runtime_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw Error("runtime_response_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("invalid_runtime_response");
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validSession(value: unknown): value is RuntimeSession {
  return (
    object(value) &&
    typeof value.sandboxId === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.sandboxId) &&
    typeof value.epoch === "string" &&
    /^[1-9][0-9]{0,18}$/.test(value.epoch) &&
    typeof value.runtimeToken === "string" &&
    /^armada_runtime_[a-f0-9]{64}$/.test(value.runtimeToken)
  );
}

/** A lost response is deliberately NOT retried: a new trusted issuance is required. */
export async function enrolRuntime(
  input: { serverUrl: string; enrolmentToken: string },
  io: DialoutIo = nativeIo,
): Promise<RuntimeEnrolment> {
  if (Object.keys(input).some((key) => !["serverUrl", "enrolmentToken"].includes(key)))
    throw Error("invalid_runtime_enrolment");
  const server = origin(input.serverUrl);
  if (!/^armada_enrol_[a-f0-9]{64}$/.test(input.enrolmentToken)) throw Error("invalid_runtime_enrolment");
  const response = await io.fetch(new URL("/api/runtime/enrol", server), {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${input.enrolmentToken}` },
  });
  if (response.status !== 200) throw Error("runtime_enrolment_failed");
  const body = await json(response, MAX_FRAME * 2);
  if (!validSession(body) || !object(body) || !object(body.configuration)) throw Error("invalid_runtime_enrolment");
  return {
    sandboxId: body.sandboxId,
    epoch: body.epoch,
    runtimeToken: body.runtimeToken,
    configuration: body.configuration,
  };
}

/** One immutable epoch per process. Durable command replay and event ACKs belong to Runner/Journal. */
export class RuntimeDialout implements IngestClient {
  private readonly server: URL;
  private readonly fenced = new AbortController();
  private pending: { epoch: string; requestId: string; status: number; body: unknown } | undefined;
  constructor(
    serverUrl: string,
    private readonly session: RuntimeSession,
    private readonly io: DialoutIo = nativeIo,
  ) {
    this.server = origin(serverUrl);
    if (!validSession(session)) throw Error("invalid_runtime_session");
    this.session = { ...session };
  }
  private revoke(): never {
    const error = new RuntimeChannelRevoked();
    this.fenced.abort(error);
    throw error;
  }
  private headers() {
    return {
      authorization: `Bearer ${this.session.runtimeToken}`,
      "x-armada-runtime-epoch": this.session.epoch,
      "content-type": "application/json",
    };
  }
  private epoch(value: unknown) {
    if (value !== this.session.epoch) this.revoke();
  }
  private async post(path: string, body: unknown, signal?: AbortSignal, timeout = 25000): Promise<unknown> {
    const signals = [this.fenced.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    const response = await this.io.fetch(new URL(`/api/runtime/${path}`, this.server), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (response.status === 401 || response.status === 403) this.revoke();
    if (response.status !== 200) throw Error("runtime_channel_unavailable");
    return json(response);
  }
  async append(batch: Parameters<IngestClient["append"]>[0]): ReturnType<IngestClient["append"]> {
    if (batch.sandboxId !== this.session.sandboxId || batch.generation !== this.session.epoch) this.revoke();
    return (await this.post("events", batch)) as Awaited<ReturnType<IngestClient["append"]>>;
  }
  async publishNativeAuth(nativeAuth: { authJson: string; expectedRevision: number }) {
    return (await this.post("events", {
      sandboxId: this.session.sandboxId,
      generation: this.session.epoch,
      events: [],
      nativeAuth,
    })) as { authRevision: number; committed: boolean };
  }
  private command(value: unknown): RunnerRequest {
    if (
      !object(value) ||
      value.version !== 1 ||
      value.sandboxId !== this.session.sandboxId ||
      typeof value.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId) ||
      typeof value.op !== "string"
    )
      throw Error("invalid_runtime_command");
    return value as unknown as RunnerRequest;
  }
  private async acknowledge(signal: AbortSignal) {
    if (!this.pending) return;
    const pending = this.pending;
    const ack = await this.post("results", pending, signal);
    if (!object(ack)) throw Error("invalid_runtime_result_ack");
    this.epoch(ack.epoch);
    if (ack.requestId !== pending.requestId) throw Error("invalid_runtime_result_ack");
    this.pending = undefined;
  }
  private async execute(
    request: RunnerRequest,
    handle: (request: RunnerRequest) => Promise<Response>,
    signal: AbortSignal,
  ) {
    const response = await handle(request);
    let body: unknown;
    let status = response.status;
    try {
      body = await json(response);
    } catch {
      status = 409;
      body = { error: "runtime_result_unavailable" };
    }
    this.pending = { epoch: this.session.epoch, requestId: request.requestId, status, body };
    await this.acknowledge(signal);
  }
  private async wait(ms: number, signal: AbortSignal) {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        cancel();
        signal.removeEventListener("abort", done);
        resolve();
      };
      const cancel = this.io.after(ms, done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  private async websocket(handle: (request: RunnerRequest) => Promise<Response>, signal: AbortSignal) {
    const url = new URL("/api/runtime/channel", this.server);
    url.protocol = "wss:";
    const socket = this.io.socket(url, this.headers());
    let tail = Promise.resolve();
    let closed = false,
      queued = 0,
      awaitingPong = false;
    let stopHeartbeat = () => {};
    let finish: (error?: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      finish = (error) => {
        if (closed) return;
        closed = true;
        error ? reject(error) : resolve();
      };
    });
    // A rejection may arrive while an accepted command is still completing.
    void done.catch(() => {});
    const stopConnect = this.io.after(8000, () => finish(Error("runtime_socket_unavailable")));
    const onOpen = () => {
      stopConnect();
      try {
        socket.send(JSON.stringify({ type: "ready", epoch: this.session.epoch }));
      } catch {
        finish(Error("runtime_socket_unavailable"));
        return;
      }
      stopHeartbeat = this.io.every(20000, () => {
        if (awaitingPong) {
          finish(Error("runtime_socket_unavailable"));
          return;
        }
        awaitingPong = true;
        try {
          socket.send(JSON.stringify({ type: "ping", epoch: this.session.epoch }));
        } catch {
          finish(Error("runtime_socket_unavailable"));
        }
      });
    };
    const onMessage = (event: Event) => {
      try {
        const data: unknown = (event as MessageEvent).data;
        if (typeof data !== "string" || Buffer.byteLength(data) > MAX_FRAME) throw Error("invalid_runtime_frame");
        const frame: unknown = JSON.parse(data);
        if (!object(frame)) throw Error("invalid_runtime_frame");
        this.epoch(frame.epoch);
        if (frame.type === "pong") {
          awaitingPong = false;
          return;
        }
        if (frame.type !== "command" || queued >= 16) throw Error("invalid_runtime_frame");
        const request = this.command(frame.request);
        queued++;
        tail = tail
          .then(async () => {
            if (!closed) await this.execute(request, handle, signal);
          })
          .catch((error) => finish(error))
          .finally(() => {
            queued--;
          });
      } catch (error) {
        finish(error instanceof RuntimeChannelRevoked ? error : Error("invalid_runtime_frame"));
      }
    };
    const onClose = (event: Event) => {
      if ([4401, 4403].includes((event as CloseEvent).code)) {
        try {
          this.revoke();
        } catch (error) {
          finish(error as Error);
        }
      } else finish(Error("runtime_socket_unavailable"));
    };
    const onError = () => finish(Error("runtime_socket_unavailable"));
    const onAbort = () => finish();
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await done;
    } finally {
      closed = true;
      stopConnect();
      stopHeartbeat();
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      socket.terminate();
      await tail;
    }
  }
  async run(
    handle: (request: RunnerRequest) => Promise<Response>,
    stop: AbortSignal,
    shutdown: () => Promise<void> = async () => {},
  ): Promise<void> {
    const signal = AbortSignal.any([stop, this.fenced.signal]);
    let closing: Promise<void> | undefined;
    const onAbort = () => {
      // Initiate native teardown BEFORE awaiting any in-flight command/tail.
      // Resume/steer may only settle once their driver has been closed.
      if (!closing) {
        try {
          closing = shutdown();
        } catch {
          closing = Promise.reject(Error("runtime_shutdown_failed"));
        }
        void closing.catch(() => {});
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let stopLease = () => {};
    try {
      if (!signal.aborted) {
        try {
          await this.websocket(handle, signal);
        } catch {
          /* Switch permanently to HTTPS for this process/epoch. */
        }
      }
      if (!signal.aborted) {
        let checking = false;
        stopLease = this.io.every(20000, () => {
          if (checking || signal.aborted) return;
          checking = true;
          // Polling pauses while a native RPC is in flight; keep the epoch check
          // independent so revocation can abort/close that RPC's driver promptly.
          void this.post("session", {}, signal, 8000)
            .then((body) => {
              if (!object(body) || body.sandboxId !== this.session.sandboxId) this.revoke();
              this.epoch(body.epoch);
            })
            .catch(() => {
              /* Transient connectivity errors retry on the next heartbeat. */
            })
            .finally(() => {
              checking = false;
            });
        });
      }
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          await this.acknowledge(signal);
          const body = await this.post("poll", { epoch: this.session.epoch }, signal);
          if (!object(body)) throw Error("invalid_runtime_poll");
          this.epoch(body.epoch);
          if (body.command !== null) await this.execute(this.command(body.command), handle, signal);
          else await this.wait(1000, signal); // Also bound a server that returns idle polls immediately.
          backoff = 1000;
        } catch {
          if (!signal.aborted) await this.wait(backoff, signal);
          backoff = Math.min(backoff * 2, 10000);
        }
      }
      if (this.fenced.signal.aborted) throw new RuntimeChannelRevoked();
    } finally {
      stopLease();
      signal.removeEventListener("abort", onAbort);
      await closing;
    }
  }
}
