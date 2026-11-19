import { controlRouteKey, streamSandboxEvents as operation } from "@armada/core/contract";
import { bearerToken } from "./caller.ts";
import { authenticatedControlCaller } from "./control-caller.ts";
import type { ControlOptions } from "./control-options.ts";
import { fail } from "./control-response.ts";
import { EVENT_PAGE_SIZE, type EventFeed } from "./event-feed.ts";
import { defineRoutes } from "./routes.ts";
import { isViewerAuthorization, readViewerGrant } from "./viewer-control.ts";
import { eventFeedWakeKey, runtimeWakes, waitForTimeout } from "./wake-bus.ts";

const HEARTBEAT_MS = 15_000;
const RECHECK_MS = 1_000;
const denied = () => fail(403, "forbidden", "Sandbox events are not available to this caller.");

function eventReader(request: Request, options: ControlOptions, feed: EventFeed, sandboxId: string) {
  const authorization = request.headers.get("authorization");
  const token = bearerToken(authorization);
  if (token?.startsWith("armada_epoch_")) return feed.child(token, sandboxId);
  return async (cursor: string) => {
    const viewer = isViewerAuthorization(authorization);
    const grant = viewer ? await readViewerGrant(authorization, options) : undefined;
    if (viewer && grant?.id.toLowerCase() !== sandboxId) return null;
    const caller = await authenticatedControlCaller(
      grant ? new Request(request.url, { headers: { authorization: grant.authorization } }) : request,
      options,
    );
    if (!caller || (viewer && caller.via !== "service")) return null;
    return feed.owner(caller, sandboxId)(cursor);
  };
}

export function createEventStream(time = { now: () => performance.now(), wait: waitForTimeout }) {
  return async (request: Request, options: ControlOptions) => {
    if (request.method !== "GET") return fail(405, "invalid", "Use GET.");
    const query = new URL(request.url).searchParams;
    const input = operation.input.query.safeParse({
      sandbox: query.get("sandbox"),
      cursor: (request.headers.get("last-event-id") || query.get("cursor")) ?? undefined,
    });
    if (!input.success) return fail(400, "invalid", "Supply a sandbox UUID and a valid event cursor.");
    if (!bearerToken(request.headers.get("authorization"))) return denied();
    if (!options.eventFeed) return fail(503, "unavailable", "Sandbox events are unavailable.");

    const sandboxId = input.data.sandbox.toLowerCase();
    let cursor = input.data.cursor ?? "0";
    const read = eventReader(request, options, options.eventFeed, sandboxId);
    const wake = runtimeWakes.watch(eventFeedWakeKey(sandboxId));
    const cancel = new AbortController();
    const signal = AbortSignal.any([request.signal, cancel.signal]);
    const close = () => {
      wake.close();
      signal.removeEventListener("abort", close);
    };
    signal.addEventListener("abort", close, { once: true });

    try {
      const initial = await read(cursor);
      if (!initial || signal.aborted) {
        close();
        return denied();
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

      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            if (initial.length) emit(controller, initial);
          },
          async pull(controller) {
            try {
              while (!signal.aborted) {
                const remaining = heartbeatAt - time.now();
                if (remaining <= 0) {
                  controller.enqueue(encoder.encode(": heartbeat\n\n"));
                  heartbeatAt = time.now() + HEARTBEAT_MS;
                  return;
                }
                if (wait) await wake.wait(signal, Math.min(RECHECK_MS, remaining), time.wait);
                if (signal.aborted) break;
                const page = await read(cursor);
                if (!page || signal.aborted) break;
                wait = page.length < EVENT_PAGE_SIZE;
                if (page.length) {
                  emit(controller, page);
                  return;
                }
              }
            } catch {
              close();
              if (!cancel.signal.aborted) controller.close();
              return;
            }
            close();
            if (!cancel.signal.aborted) controller.close();
          },
          cancel() {
            cancel.abort();
            close();
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
      close();
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
