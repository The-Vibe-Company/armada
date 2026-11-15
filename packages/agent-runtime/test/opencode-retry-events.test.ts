import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { Server } from "node:net";
import { PassThrough } from "node:stream";
import { ModelRateLimitWait } from "../src/model-rate-limit.ts";
import { createOpenCodeRetryObserver } from "../src/opencode-retry-observer.ts";
import type { DriverContext, DriverEvent } from "../src/protocol.ts";

// Port reservation is OS wiring, not this protocol test's contract. No network is opened.
const net = {
  createConnection: (options: unknown) => {
    dialled = options;
    return {};
  },
  createServer: () =>
    ({
      once() {
        return this;
      },
      listen(_options: unknown, listening: () => void) {
        listening();
      },
      address: () => ({ port: 12345 }),
      close(closed?: () => void) {
        closed?.();
      },
    }) as unknown as Server,
};
let dialled: unknown;
let options: RequestOptions | undefined;
let requests = 0;
const responses = new Set<IncomingMessage>();
let activeRequest: EventEmitter & { destroyed: boolean; end(): void; destroy(): void };
let handler: (reply: (response: IncomingMessage) => void) => void;
class PrivateAgent {
  destroyed = false;
  createConnection?: () => unknown;
  destroy() {
    this.destroyed = true;
  }
}
const http = {
  Agent: PrivateAgent,
  request: (input: RequestOptions, reply: (response: IncomingMessage) => void) => {
    options = input;
    requests++;
    const ownedRequest = Object.assign(new EventEmitter(), {
      destroyed: false,
      end() {
        handler(reply);
      },
      destroy() {
        this.destroyed = true;
      },
    });
    input.signal?.addEventListener(
      "abort",
      () => {
        if (ownedRequest.listenerCount("error")) ownedRequest.emit("error", new Error("aborted"));
      },
      { once: true },
    );
    activeRequest = ownedRequest;
    return ownedRequest;
  },
};
const response = (statusCode = 200, headers: Record<string, string> = { "content-type": "text/event-stream" }) => {
  const stream = Object.assign(new PassThrough(), { statusCode, headers }) as unknown as IncomingMessage;
  responses.add(stream);
  return stream;
};
const transport = { ...net, ...http } as unknown as NonNullable<Parameters<typeof createOpenCodeRetryObserver>[2]>;
afterEach(() => {
  for (const stream of responses) stream.destroy();
  responses.clear();
  activeRequest?.destroy();
  setSystemTime();
  options = undefined;
  requests = 0;
  jest.useRealTimers();
  dialled = undefined;
});

// The owning HTTP observer must deliver native waits without exposing provider text or adding a retry.
test("OpenCode native SSE waits are authenticated, session scoped, deduplicated and closed with the turn", async () => {
  setSystemTime(new Date("2026-11-15T00:00:00Z"));
  const events: DriverEvent[] = [];
  const abort = new AbortController();
  const context: DriverContext = {
    request: { sandboxId: "sandbox", harness: "opencode", text: "work", cwd: "/workspace/repo" },
    signal: abort.signal,
    session: () => {},
    emit: (event) => events.push(event),
  };
  const incoming = response();
  handler = (reply) => {
    reply(incoming);
  };
  const observer = await createOpenCodeRetryObserver(context, new ModelRateLimitWait(), transport);
  try {
    await observer.observation.ready("main");
    expect(options?.hostname).toBe("127.0.0.1");
    expect(options?.port).toBe(12345);
    expect(new URL(String(options?.path), "http://loopback").pathname).toBe("/event");
    expect(new URL(String(options?.path), "http://loopback").searchParams.get("directory")).toBe("/workspace/repo");
    const agent = options?.agent as unknown as PrivateAgent;
    expect(agent).toBeInstanceOf(PrivateAgent);
    agent.createConnection?.();
    expect(dialled).toEqual({ host: "127.0.0.1", port: 12345 });
    expect((options?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      `Basic ${Buffer.from(`opencode:${observer.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
    );
    expect(observer.args.join(" ")).not.toContain(observer.env.OPENCODE_SERVER_PASSWORD!);
    const status = (sessionID: string, message: string, attempt = 1) => ({
      type: "session.status",
      properties: {
        sessionID,
        status: { type: "retry", attempt, next: Date.now() + 20000, message },
      },
    });
    const retry = status("main", "429 provider_private_detail", 2);
    const wire = [
      status("foreign", "429"),
      status("main", "fetch failed"),
      retry,
      retry,
      status("main", "Provider is overloaded", 3),
      status("main", "Too Many Requests", 4),
      status("main", "too_many_requests", 5),
      status("main", "Your allocation is temporarily unavailable", 6),
      { type: "message.part.updated", properties: { sessionID: "main", text: "429" } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("");
    // Exercise chunk/CRLF boundaries, not just complete in-memory JSON objects.
    incoming.push(Buffer.from(wire.slice(0, 31)));
    incoming.push(Buffer.from(wire.slice(31)));
    incoming.push(null);
    // EOF is an explicit pump completion barrier, not a guessed number of microtasks.
    await expect(observer.observation.failed).rejects.toMatchObject({ code: "harness_process_lost" });
    expect(events).toHaveLength(6);
    expect(events).toMatchObject([
      {
        type: "armada/modelRateLimit",
        data: {
          retryCount: 1,
          delayMs: 20000,
          totalWaitMs: 20000,
          reason: "model_provider_retry",
          message: "Model provider request retrying in 20 s",
        },
      },
      ...[2, 3, 4, 5].map((retryCount) => ({
        type: "armada/modelRateLimit",
        data: {
          retryCount,
          delayMs: 20000,
          totalWaitMs: retryCount * 20000,
          message: "Rate limited by the model provider, retrying in 20 s",
        },
      })),
      {
        type: "armada/modelRateLimit",
        data: {
          retryCount: 6,
          delayMs: 20000,
          totalWaitMs: 120000,
          reason: "model_provider_retry",
          message: "Model provider request retrying in 20 s",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("provider_private_detail");
    expect(JSON.stringify(events)).not.toContain("Your allocation");
    expect(JSON.stringify(events)).not.toContain("fetch failed");
    expect(JSON.stringify(events)).not.toContain(observer.env.OPENCODE_SERVER_PASSWORD!);
  } finally {
    await observer.observation.close();
  }
  expect(incoming.destroyed).toBe(true);
  expect(activeRequest.destroyed).toBe(true);
  expect((options?.agent as unknown as PrivateAgent | undefined)?.destroyed).toBe(true);
});

test("OpenCode native event-stream loss is explicit instead of silently hiding later waits", async () => {
  const context: DriverContext = {
    request: { sandboxId: "sandbox", harness: "opencode", text: "work", cwd: "/repo" },
    signal: new AbortController().signal,
    session: () => {},
    emit: () => {},
  };
  handler = (reply) => {
    const incoming = response();
    reply(incoming);
    incoming.push(null);
  };
  const observer = await createOpenCodeRetryObserver(context, new ModelRateLimitWait(), transport);
  try {
    await observer.observation.ready("main");
    await expect(observer.observation.failed).rejects.toMatchObject({ code: "harness_process_lost" });
  } finally {
    await observer.observation.close();
  }
});

test("OpenCode observer setup failures do not expose local transport details", async () => {
  const context: DriverContext = {
    request: { sandboxId: "sandbox", harness: "opencode", text: "work", cwd: "/repo" },
    signal: new AbortController().signal,
    session: () => {},
    emit: () => {},
  };
  handler = () => {
    activeRequest.emit("error", new Error("private_transport_detail"));
  };
  const observer = await createOpenCodeRetryObserver(context, new ModelRateLimitWait(), transport);
  try {
    await expect(observer.observation.ready("main")).rejects.toMatchObject({
      code: "harness_process_lost",
      message: "harness_process_lost",
    });
  } finally {
    await observer.observation.close();
  }
});

test("OpenCode event credentials are not forwarded to an HTTP redirect destination", async () => {
  const context: DriverContext = {
    request: { sandboxId: "sandbox", harness: "opencode", text: "work", cwd: "/repo" },
    signal: new AbortController().signal,
    session: () => {},
    emit: () => {},
  };
  let incoming!: IncomingMessage;
  handler = (reply) => {
    incoming = response(302, {
      "content-type": "text/event-stream",
      location: "https://external.example/event",
    } as Record<string, string>);
    reply(incoming);
  };
  const observer = await createOpenCodeRetryObserver(context, new ModelRateLimitWait(), transport);
  try {
    await expect(observer.observation.ready("main")).rejects.toMatchObject({ code: "harness_process_lost" });
    expect(requests).toBe(1);
    expect(incoming.destroyed).toBe(true);
  } finally {
    await observer.observation.close();
  }
});

test("OpenCode event setup deadline aborts a stalled direct connection with a fake clock", async () => {
  jest.useFakeTimers();
  const context: DriverContext = {
    request: { sandboxId: "sandbox", harness: "opencode", text: "work", cwd: "/repo" },
    signal: new AbortController().signal,
    session: () => {},
    emit: () => {},
  };
  handler = () => {};
  const observer = await createOpenCodeRetryObserver(context, new ModelRateLimitWait(), transport);
  try {
    const pending = observer.observation.ready("main");
    jest.advanceTimersByTime(5000);
    await expect(pending).rejects.toMatchObject({ code: "harness_process_lost" });
    expect(options?.signal?.aborted).toBe(true);
  } finally {
    await observer.observation.close();
  }
});
