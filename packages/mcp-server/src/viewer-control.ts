import { sandboxViewerOperations, VIEWER_ACCESS_DENIED } from "@armada/core/contract";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { authenticatedControlCaller } from "./control-caller.ts";
import { defineRoutes } from "./routes.ts";

type Dispatch = (request: Request) => Promise<Response | null>;
const PREFIX = "armada_viewer_";
const TTL = 300_000;
interface Grant {
  purpose: "sandbox-viewer-v1";
  id: string;
  authorization: string;
  expires: number;
}

type ViewerAction = keyof typeof sandboxViewerOperations;

function viewerRoute(action: ViewerAction) {
  const { route } = sandboxViewerOperations[action];
  return {
    [route.path.slice("/api/v1/".length)]: {
      methods: [route.method],
      earlyRespond: (request: Request, options: ControlOptions, dispatch: Dispatch) =>
        viewerControl(request, options, dispatch, action),
    },
  };
}

export const viewerRoutes = defineRoutes("viewer", {
  ...viewerRoute("mint"),
  ...viewerRoute("logs"),
  ...viewerRoute("status"),
  ...viewerRoute("send"),
  ...viewerRoute("events"),
});

/** Viewer grants are never principals for ordinary control routes. */
export function rejectUnroutedViewerRequest(request: Request, options: ControlOptions, dispatch: Dispatch) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/v1/viewer/") || request.headers.get("authorization")?.startsWith(`Bearer ${PREFIX}`))
    return viewerControl(request, options, dispatch);
}

async function viewerControl(
  request: Request,
  options: ControlOptions,
  dispatch: Dispatch,
  action?: ViewerAction,
): Promise<Response> {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") ?? "";
  const fail = (status: number) =>
    Response.json({ error: VIEWER_ACCESS_DENIED }, { status, headers: { "cache-control": "no-store" } });
  const now = () => (options.now?.() ?? new Date()).getTime();
  try {
    if (action === "mint") {
      if (request.method !== sandboxViewerOperations[action].route.method) return fail(405);
      const caller = await authenticatedControlCaller(request, options);
      if (caller?.via !== "service") return fail(403);
      const input = sandboxViewerOperations.mint.input.body.safeParse(await readBody(request));
      if (!input.success) return fail(400);
      const { id } = input.data;
      // Existing authorized log resolution checks membership and sandbox visibility on all providers.
      const probe = await dispatch(
        new Request(new URL("/api/v1/logs/read", url).href, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ id, limit: 1, maxBytes: 1024 }),
        }),
      );
      if (!probe?.ok) return fail(probe?.status ?? 403);
      const expires = now() + TTL;
      const grant: Grant = { purpose: "sandbox-viewer-v1", id, authorization, expires };
      const sealed = await encryptSecret(JSON.stringify(grant), options.encryptionKey);
      return Response.json(
        { token: PREFIX + Buffer.from(sealed).toString("base64url"), expiresAt: new Date(expires).toISOString() },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      !url.pathname.startsWith("/api/v1/viewer/") ||
      !authorization.startsWith(`Bearer ${PREFIX}`) ||
      authorization.length > 8192
    )
      return fail(403);
    let grant: Grant;
    try {
      grant = JSON.parse(
        await decryptSecret(
          new Uint8Array(Buffer.from(authorization.slice(7 + PREFIX.length), "base64url")),
          options.encryptionKey,
        ),
      );
    } catch {
      return fail(401);
    }
    if (
      grant.purpose !== "sandbox-viewer-v1" ||
      !Number.isFinite(grant.expires) ||
      grant.expires <= now() ||
      grant.expires > now() + TTL
    )
      return fail(401);
    if (!action) return fail(403);
    const operation = sandboxViewerOperations[action];
    if (request.method !== operation.route.method) return fail(405);
    const body =
      action === "events"
        ? { cursor: url.searchParams.get("cursor") ?? request.headers.get("last-event-id") }
        : await readBody(request, "maxBodyBytes" in operation.input ? operation.input.maxBodyBytes : undefined);
    const invoke = async (route: string, fields: Record<string, unknown>) => {
      if (grant.expires <= now()) return fail(401);
      const caller = await authenticatedControlCaller(
        new Request(url.href, { headers: { authorization: grant.authorization } }),
        options,
      );
      if (caller?.via !== "service") return fail(401);
      return (
        (await dispatch(
          new Request(new URL(`/api/v1/${route}`, url).href, {
            method: "POST",
            headers: { authorization: grant.authorization, "content-type": "application/json" },
            body: JSON.stringify({ ...fields, id: grant.id }),
            signal: request.signal,
          }),
        )) ?? fail(403)
      );
    };
    if (action === "send") {
      const input = sandboxViewerOperations.send.input.body.safeParse(body);
      if (!input.success) return fail(400);
      const { message, requestId } = input.data;
      return invoke("sandbox/send", {
        prompt: message,
        ...(typeof requestId === "string" ? { request_id: requestId } : {}),
      });
    }
    // The schemas select only viewer fields. The grant supplies the sandbox ID.
    const input = (
      action === "events" ? sandboxViewerOperations.events.input.query : sandboxViewerOperations[action].input.body
    ).safeParse(body);
    if (!input.success) return fail(400);
    const { cursor } = input.data;
    const page = (next: typeof cursor) =>
      invoke("logs/read", { ...(next ? { cursor: next } : {}), limit: 100, maxBytes: 65536 });
    if (action === "logs") return page(cursor);
    if (action === "status") return invoke("sandbox/status", {});
    // Preflight authorization before committing streaming headers.
    let pending: Response | null = await page(cursor);
    if (!pending.ok) return pending;
    let next = cursor;
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (cancelled || request.signal.aborted || grant.expires <= now()) {
              controller.close();
              return;
            }
            const response = pending ?? (await page(next));
            pending = null;
            if (!response.ok) {
              controller.enqueue(encoder.encode("event: access-ended\ndata: {}\n\n"));
              controller.close();
              return;
            }
            const data = (await response.json()) as { cursor?: string; hasMore?: boolean };
            if (cancelled || request.signal.aborted) {
              controller.close();
              return;
            }
            if (typeof data.cursor === "string") next = data.cursor;
            // Cursor lives in JSON: no untrusted provider cursor can inject SSE fields.
            controller.enqueue(encoder.encode(`event: page\ndata: ${JSON.stringify(data)}\n\n`));
            if (!data.hasMore)
              await new Promise<void>((resolve) => {
                const done = () => {
                  clearTimeout(timer);
                  request.signal.removeEventListener("abort", done);
                  resolve();
                };
                const timer = setTimeout(done, 1000);
                request.signal.addEventListener("abort", done, { once: true });
              });
          } catch {
            if (!cancelled) controller.close();
          }
        },
        cancel() {
          cancelled = true;
          pending = null;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      headers: {
        "content-type": sandboxViewerOperations.events.outputMediaType,
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    return fail(503);
  }
}
