import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { authenticatedControlCaller } from "./control-caller.ts";

type Dispatch = (request: Request) => Promise<Response | null>;
const PREFIX = "armada_viewer_";
const TTL = 300_000;
interface Grant {
  purpose: "sandbox-viewer-v1";
  id: string;
  authorization: string;
  expires: number;
}

/** Separate from ordinary and machine authentication: these bearers are never principals. */
export async function viewerControl(
  request: Request,
  options: Pick<ControlOptions, "authStore" | "supabase" | "encryptionKey" | "now">,
  dispatch: Dispatch,
): Promise<Response | null> {
  const url = new URL(request.url);
  const mint = url.pathname === "/api/v1/sandbox/viewer-token";
  const viewer = url.pathname.startsWith("/api/v1/viewer/");
  const authorization = request.headers.get("authorization") ?? "";
  if (!mint && !viewer && !authorization.startsWith(`Bearer ${PREFIX}`)) return null;
  const fail = (status: number) =>
    Response.json({ error: "viewer_access_denied" }, { status, headers: { "cache-control": "no-store" } });
  const now = () => (options.now?.() ?? new Date()).getTime();
  try {
    if (mint) {
      if (request.method !== "POST") return fail(405);
      const caller = await authenticatedControlCaller(request, options);
      if (caller?.via !== "service") return fail(403);
      const body = await readBody(request);
      if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return fail(400);
      // Existing authorized log resolution checks membership and sandbox visibility on all providers.
      const probe = await dispatch(
        new Request(new URL("/api/v1/logs/read", url).href, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ id: body.id, limit: 1, maxBytes: 1024 }),
        }),
      );
      if (!probe?.ok) return fail(probe?.status ?? 403);
      const expires = now() + TTL;
      const grant: Grant = { purpose: "sandbox-viewer-v1", id: body.id, authorization, expires };
      const sealed = await encryptSecret(JSON.stringify(grant), options.encryptionKey);
      return Response.json(
        { token: PREFIX + Buffer.from(sealed).toString("base64url"), expiresAt: new Date(expires).toISOString() },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (!viewer || !authorization.startsWith(`Bearer ${PREFIX}`) || authorization.length > 8192) return fail(403);
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
    const action = url.pathname.slice("/api/v1/viewer/".length);
    if (!["logs", "status", "send", "events"].includes(action)) return fail(403);
    if (request.method !== (action === "events" ? "GET" : "POST")) return fail(405);
    const body = action === "events" ? {} : await readBody(request);
    // Explicit field selection prevents org, sandbox, lifecycle or tool overrides.
    const cursor =
      action === "events" ? (url.searchParams.get("cursor") ?? request.headers.get("last-event-id")) : body.cursor;
    if (
      cursor !== undefined &&
      cursor !== null &&
      (typeof cursor !== "string" || cursor.length > 4096 || /[\r\n]/.test(cursor))
    )
      return fail(400);
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
    const page = (next: unknown) =>
      invoke("logs/read", { ...(next ? { cursor: next } : {}), limit: 100, maxBytes: 65536 });
    if (action === "logs") return page(cursor);
    if (action === "status") return invoke("sandbox/status", {});
    if (action === "send") {
      if (typeof body.message !== "string" || !body.message.trim()) return fail(400);
      return invoke("sandbox/send", {
        prompt: body.message,
        ...(typeof body.requestId === "string" ? { request_id: body.requestId } : {}),
      });
    }
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
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  } catch {
    return fail(503);
  }
}
