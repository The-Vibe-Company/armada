import { BodyTooLargeError } from "@armada/auth";
import { fail } from "./control-response.ts";

/** Aggregate ingress ceiling: MCP prompts/tool arguments have no smaller cap. Routes bound their own bodies below it. */
export const REQUEST_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

/**
 * Bun answers its own `maxRequestBodySize` before any application code runs (a declared length) or
 * replaces the handler's response (a chunked body), so that 413 would carry no request ID and no
 * request record. Bun's limit is therefore only a backstop; the ceiling is enforced by
 * {@link withRequestBodyCeiling} inside the observed request.
 */
export const BUN_REQUEST_BODY_BACKSTOP = Number.MAX_SAFE_INTEGER;

const delivered = new WeakMap<Request, Request>();

/** The request Bun delivered, for server APIs (per-request timeouts) that need its native handle. */
export function ingressRequest(request: Request): Request {
  return delivered.get(request) ?? request;
}

function tooLarge(): Response {
  return fail(413, "invalid", new BodyTooLargeError().message);
}

/**
 * Refuse a declared length above `limit` without reading it, and bound an undeclared (chunked)
 * body while the handler reads it; a body the handler leaves unread is drained through the same
 * count before its response is released. Either way the caller gets the same public 413.
 */
export async function withRequestBodyCeiling(
  request: Request,
  limit: number,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) return Number(declared) > limit ? tooLarge() : handle(request);
  if (!request.body) return handle(request);
  let bytes = 0;
  let exceeded = false;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit) {
          exceeded = true;
          controller.error(new BodyTooLargeError());
        } else controller.enqueue(chunk);
      },
    }),
  );
  const bounded = new Request(request, { body, duplex: "half" } as RequestInit);
  delivered.set(bounded, request);
  let response: Response;
  try {
    response = await handle(bounded);
  } catch (error) {
    if (exceeded) return tooLarge();
    throw error;
  }
  // The ceiling must not depend on the route reading its body: count whatever it left unread.
  if (!exceeded && !bounded.bodyUsed) await bounded.body?.pipeTo(new WritableStream()).catch(() => {});
  if (!exceeded) return response;
  void response.body?.cancel().catch(() => {});
  return tooLarge();
}
