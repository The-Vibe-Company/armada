import { controlRouteKey, streamSandboxEvents as operation } from "@armada/core/contract";
import { bearerToken, type Caller } from "./caller.ts";
import { authenticatedControlCaller } from "./control-caller.ts";
import type { ControlOptions } from "./control-options.ts";
import { fail } from "./control-response.ts";
import { EVENT_PAGE_SIZE, type EventFeed } from "./event-feed.ts";
import { defineRoutes } from "./routes.ts";
import { drainRefusal } from "./server-request-drain.ts";
import { isViewerAuthorization, readViewerGrant } from "./viewer-control.ts";
import { eventFeedWakeKey, runtimeWakes, waitForTimeout } from "./wake-bus.ts";

const HEARTBEAT_MS = 15_000;
const RECHECK_MS = 1_000;
export const AUTH_REVALIDATE_MS = 30_000;
const denied = () => fail(403, "forbidden", "Sandbox events are not available to this caller.");

function eventReader(request: Request, options: ControlOptions, feed: EventFeed, sandboxId: string, now: () => number) {
  const authorization = request.headers.get("authorization");
  const token = bearerToken(authorization);
  if (token?.startsWith("armada_epoch_")) {
    return {
      read: feed.child(token, sandboxId),
      tail: () => (feed.childTail ? feed.childTail(token, sandboxId) : Promise.resolve(null)),
      revalidate: async () => true,
    };
  }
  let cached: { caller: Caller; checkedAt: number; expiresAtMs?: number } | undefined;
  async function resolveCaller() {
    const tick = now();
    const wallMs = (options.now?.() ?? new Date()).getTime();
    if (
      cached &&
      tick - cached.checkedAt < AUTH_REVALIDATE_MS &&
      (cached.expiresAtMs === undefined || cached.expiresAtMs > wallMs)
    ) {
      return cached.caller;
    }
    const viewer = isViewerAuthorization(authorization);
    const grant = viewer ? await readViewerGrant(authorization, options) : undefined;
    const caller =
      viewer && grant?.id.toLowerCase() !== sandboxId
        ? null
        : await authenticatedControlCaller(
            grant ? new Request(request.url, { headers: { authorization: grant.authorization } }) : request,
            options,
          );
    if (!caller || (viewer && caller.via !== "service")) {
      cached = undefined;
      return null;
    }
    const keyExp = caller.key?.expiresAt ? Date.parse(caller.key.expiresAt) : Number.NaN;
    const bounds = [grant?.expires, Number.isFinite(keyExp) ? keyExp : undefined].filter(
      (v): v is number => v !== undefined,
    );
    cached = { caller, checkedAt: tick, ...(bounds.length ? { expiresAtMs: Math.min(...bounds) } : {}) };
    return caller;
  }
  return {
    read: async (cursor: string) => {
      const caller = await resolveCaller();
      return caller ? feed.owner(caller, sandboxId)(cursor) : null;
    },
    tail: async () => {
      const caller = await resolveCaller();
      return caller ? (feed.ownerTail ? feed.ownerTail(caller, sandboxId) : null) : null;
    },
    revalidate: async () => (await resolveCaller()) !== null,
  };
}

export function createEventStream(time = { now: () => performance.now(), wait: waitForTimeout }) {
  return async (request: Request, options: ControlOptions) => {
    if (request.method !== "GET") return fail(405, "invalid", "Use GET.");
    const query = new URL(request.url).searchParams;
    const lastEventIdHeader = request.headers.get("last-event-id");
    const lastEventId = operation.input.headers["Last-Event-ID"].safeParse(lastEventIdHeader || undefined);
    const input = operation.input.query.safeParse({
      sandbox: query.get("sandbox"),
      cursor: lastEventIdHeader ? undefined : (query.get("cursor") ?? undefined),
    });
    if (!lastEventId.success || !input.success)
      return fail(400, "invalid", "Supply a sandbox UUID and a valid event cursor.");
    if (!bearerToken(request.headers.get("authorization"))) return denied();
    if (!options.eventFeed) return fail(503, "unavailable", "Sandbox events are unavailable.");

    const sandboxId = input.data.sandbox.toLowerCase();
    const requestedCursor = lastEventId.data ?? input.data.cursor ?? "0";
    const reader = eventReader(request, options, options.eventFeed, sandboxId, time.now);
    const wake = runtimeWakes.watch(eventFeedWakeKey(sandboxId));
    const cancel = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      cancel.signal,
      ...(options.eventStreamShutdown ? [options.eventStreamShutdown] : []),
    ]);

    try {
      let cursor = requestedCursor;
      let initial: Awaited<ReturnType<typeof reader.read>>;
      if (requestedCursor === "tail") {
        const tailCursor = await reader.tail();
        cursor = tailCursor ?? "0";
        initial = tailCursor === null ? null : [];
      } else {
        initial = await reader.read(cursor);
      }
      if (!initial || signal.aborted) {
        wake.close();
        return options.eventStreamShutdown?.aborted ? drainRefusal() : denied();
      }
      options.configureEventStreamRequest?.(request);
      const encoder = new TextEncoder();
      let heartbeatAt = time.now() + HEARTBEAT_MS;
      let wait = initial.length < EVENT_PAGE_SIZE;

      function emit(controller: ReadableStreamDefaultController<Uint8Array>, page: NonNullable<typeof initial>) {
        cursor = page[page.length - 1]!.id;
        controller.enqueue(
          encoder.encode(page.map((row) => `id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`).join("")),
        );
        heartbeatAt = time.now() + HEARTBEAT_MS;
      }

      let finish: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const endStream = () => {
              signal.removeEventListener("abort", endStream);
              wake.close();
              if (!cancel.signal.aborted) controller.close();
            };
            finish = endStream;
            signal.addEventListener("abort", endStream, { once: true });
            if (initial.length) emit(controller, initial);
            else controller.enqueue(encoder.encode(": connected\n\n"));
          },
          async pull(controller) {
            try {
              while (!signal.aborted) {
                const remaining = heartbeatAt - time.now();
                if (remaining <= 0) {
                  if (!(await reader.revalidate())) break;
                  if (signal.aborted) return;
                  controller.enqueue(encoder.encode(": heartbeat\n\n"));
                  heartbeatAt = time.now() + HEARTBEAT_MS;
                  return;
                }
                if (wait) await wake.wait(signal, Math.min(RECHECK_MS, remaining), time.wait);
                if (signal.aborted) return;
                const page = await reader.read(cursor);
                if (signal.aborted) return;
                if (!page) break;
                wait = page.length < EVENT_PAGE_SIZE;
                if (page.length) {
                  emit(controller, page);
                  return;
                }
              }
            } catch {
              if (signal.aborted) return;
            }
            finish?.();
          },
          cancel() {
            cancel.abort();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        headers: {
          "content-type": operation.outputMediaType,
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      });
    } catch {
      wake.close();
      return fail(503, "unavailable", "Sandbox events are unavailable.");
    }
  };
}

export const eventStreamRoutes = defineRoutes("events", {
  [controlRouteKey(operation.route)]: {
    methods: [operation.route.method],
    earlyRespond: createEventStream(),
  },
});
