import { streamSandboxEvents } from "@armada/core/contract/sandbox-events";
import type { EventStreamInput, SandboxEvent } from "./index.ts";

type StreamConnection = { body: ReadableStream<Uint8Array>; status?: number } | { retryAfterMs: number };

export const sandboxEventStream: (
  input: EventStreamInput,
  open: (cursor: string | undefined) => Promise<StreamConnection>,
  signal?: AbortSignal,
  invalidPayload?: (message: string, status: number) => Error,
) => AsyncGenerator<SandboxEvent, void> = async function* (
  input,
  open,
  signal,
  invalidPayload = (message) => new TypeError(message),
) {
  const parsed = streamSandboxEvents.input.query.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid event stream input: expected a sandbox UUID and optional cursor.");
  const { sandbox, cursor } = parsed.data;
  let lastId = cursor;
  while (!signal?.aborted) {
    const connection = await open(lastId);
    if ("retryAfterMs" in connection) {
      await waitToReconnect(connection.retryAfterMs, signal);
      continue;
    }

    const before = lastId;
    for await (const event of readEvents(
      connection.body,
      sandbox.toLowerCase(),
      connection.status ?? 200,
      invalidPayload,
      signal,
    )) {
      if (lastId !== undefined && lastId !== "tail" && BigInt(event.id) <= BigInt(lastId)) continue;
      lastId = event.id;
      yield event;
    }
    if (lastId === before) await waitToReconnect(1000, signal);
  }
};

async function* readEvents(
  body: ReadableStream<Uint8Array>,
  sandbox: string,
  status: number,
  invalidPayload: (message: string, status: number) => Error,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const decoder = new TextDecoder();
  let buffer = "";
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read().catch(() => null);
      if (!chunk || chunk.done || signal?.aborted) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator && !signal?.aborted) {
        const event = parseFrame(buffer.slice(0, separator.index), sandbox, status, invalidPayload);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (event) yield event;
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function parseFrame(
  frame: string,
  sandbox: string,
  status: number,
  invalidPayload: (message: string, status: number) => Error,
) {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("id:")) id = line.slice(3).replace(/^ /, "");
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return;
  let raw: unknown;
  try {
    raw = JSON.parse(data.join("\n"));
  } catch {
    throw invalidPayload("Event stream returned malformed JSON.", status);
  }
  const parsed = streamSandboxEvents.output.safeParse(raw);
  if (!parsed.success) throw invalidPayload("Event stream returned an invalid event payload.", status);
  const event = parsed.data;
  if (event.id !== id || event.sandboxId.toLowerCase() !== sandbox)
    throw new TypeError("Event stream returned an inconsistent event reference.");
  const base = {
    id: event.id,
    sandboxId: event.sandboxId,
    ref: event.ref,
    createdAt: event.createdAt,
  };
  if (event.kind === "transition" && event.sequence === null)
    return {
      ...base,
      kind: event.kind,
      sequence: event.sequence,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.statusReason !== undefined ? { statusReason: event.statusReason } : {}),
    } satisfies SandboxEvent;
  if (event.kind === "runtime_event" && event.sequence === event.ref)
    return {
      ...base,
      kind: event.kind,
      sequence: event.sequence,
      ...(event.event !== undefined ? { event: event.event } : {}),
    } satisfies SandboxEvent;
  throw new TypeError("Event stream returned an inconsistent event sequence.");
}

async function waitToReconnect(ms: number, signal?: AbortSignal) {
  const maxTimerDelayMs = 2_147_483_647;
  while (ms > 0 && !signal?.aborted) {
    const delay = Math.min(ms, maxTimerDelayMs);
    await waitForRetryTimer(delay, signal);
    ms -= delay;
  }
}

function waitForRetryTimer(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
