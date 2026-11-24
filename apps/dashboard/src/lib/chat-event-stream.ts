import { streamSandboxEvents } from "@armada/core/contract";

const CONNECT_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 8_000;

export function chatEventStream(sandboxId: string, onUpdate: () => void) {
  let source: EventSource | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let eventLogCursor = "0";
  let retryAt = 0;

  function close() {
    clearTimeout(deadline);
    source?.close();
    source = undefined;
  }

  return {
    close,
    get waitingForEvents() {
      return source !== undefined;
    },
    connect() {
      if (source || typeof EventSource === "undefined" || Date.now() < retryAt) return;
      const query = new URLSearchParams({ sandbox: sandboxId, cursor: eventLogCursor });
      const connection = new EventSource(`${streamSandboxEvents.route.path}?${query}`);
      source = connection;

      const unavailable = () => {
        if (source !== connection) return;
        close();
        retryAt = Date.now() + RECONNECT_DELAY_MS;
        onUpdate();
      };
      deadline = setTimeout(unavailable, CONNECT_TIMEOUT_MS);
      connection.onerror = unavailable;
      connection.onopen = () => {
        if (source !== connection) return;
        clearTimeout(deadline);
        onUpdate();
      };
      connection.onmessage = ({ lastEventId }) => {
        if (source !== connection) return;
        const id = streamSandboxEvents.input.headers["Last-Event-ID"].safeParse(lastEventId);
        if (!id.success || !id.data || BigInt(id.data) <= BigInt(eventLogCursor)) return;
        eventLogCursor = id.data;
        onUpdate();
      };
    },
  };
}
