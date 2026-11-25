import { isRecord, type SandboxStatus } from "@armada/core";
import { streamSandboxEvents } from "@armada/core/contract";
import { type ChatEvent, isSandboxStatus, normalizeEvent } from "./events.ts";

const CONNECT_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 8_000;

export type ChatStreamFrame =
  | { id: string; sequence: string | null; kind: "runtime_event"; event?: ChatEvent }
  | { id: string; sequence: string | null; kind: "transition"; status?: SandboxStatus; statusReason?: string | null };

export type ChatStreamHandlers = {
  onFrame: (frame: ChatStreamFrame) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
};

function parseFrame(rawData: unknown, lastEventId: string) {
  if (typeof rawData !== "string" || !rawData) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const id = streamSandboxEvents.input.headers["Last-Event-ID"].safeParse(
    lastEventId || (typeof parsed.id === "string" ? parsed.id : ""),
  );
  if (!id.success || !id.data) return null;
  const sequence = typeof parsed.sequence === "string" ? parsed.sequence : null;
  if (parsed.kind === "runtime_event") {
    const event = normalizeEvent(parsed.event) ?? undefined;
    return { id: id.data, sequence, kind: "runtime_event", ...(event ? { event } : {}) } satisfies ChatStreamFrame;
  }
  if (parsed.kind === "transition") {
    const status = isSandboxStatus(parsed.status) ? parsed.status : undefined;
    const statusReason =
      typeof parsed.statusReason === "string" || parsed.statusReason === null ? parsed.statusReason : undefined;
    return {
      id: id.data,
      sequence,
      kind: "transition",
      ...(status ? { status } : {}),
      ...(statusReason !== undefined ? { statusReason } : {}),
    } satisfies ChatStreamFrame;
  }
  return null;
}

export function chatEventStream(sandboxId: string, handlers: ChatStreamHandlers) {
  let source: EventSource | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let opened = false;
  let eventLogCursor: string | null = null;
  let retryAt = 0;

  function close() {
    clearTimeout(deadline);
    deadline = undefined;
    source?.close();
    source = undefined;
    opened = false;
  }

  return {
    close,
    get connected() {
      return source !== undefined && opened;
    },
    connect() {
      if (source || typeof EventSource === "undefined" || Date.now() < retryAt) return;
      const query = new URLSearchParams({ sandbox: sandboxId, cursor: eventLogCursor ?? "tail" });
      const connection = new EventSource(`${streamSandboxEvents.route.path}?${query}`);
      source = connection;
      opened = false;
      const unavailable = () => {
        if (source !== connection) return;
        close();
        retryAt = Date.now() + RECONNECT_DELAY_MS;
        handlers.onDisconnect?.();
      };
      const markOpen = () => {
        clearTimeout(deadline);
        deadline = undefined;
        if (!opened) {
          opened = true;
          handlers.onOpen?.();
        }
      };
      deadline = setTimeout(unavailable, CONNECT_TIMEOUT_MS);
      connection.onerror = unavailable;
      connection.onopen = () => {
        if (source === connection) markOpen();
      };
      connection.onmessage = (message) => {
        if (source !== connection) return;
        markOpen();
        const frame = parseFrame(message.data, message.lastEventId);
        if (!frame || (eventLogCursor !== null && BigInt(frame.id) <= BigInt(eventLogCursor))) return;
        eventLogCursor = frame.id;
        handlers.onFrame(frame);
      };
    },
  };
}
