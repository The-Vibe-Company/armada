import type { Sql } from "@armada/core";
import type { IngestGrantClaims, IngestPayload, Scope } from "./ports.ts";
import { appendModalEvents } from "./store.ts";

/** Mount at an exact server-owned POST route. verifyGrant must cryptographically verify and resolve
 * scope server-side, never from request JSON. The token is only an expiring sandbox/generation grant. */
export function createModalIngestHandler(options: {
  sql: Sql;
  verifyGrant(token: string): Promise<{ claims: IngestGrantClaims; scope: Scope }>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
      const { claims, scope } = await options.verifyGrant(request.headers.get("x-armada-runner-grant") ?? "");
      if (claims.expiresAt <= Date.now()) return new Response(null, { status: 401 });
      // Bound bytes as well as batch count before JSON parsing.
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1048576) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        sandboxId: string;
        generation: string;
        events: Omit<IngestPayload, "sandboxId" | "generation">[];
      };
      if (body.sandboxId !== claims.sandboxId || body.generation !== claims.generation)
        return new Response(null, { status: 403 });
      if (
        !Array.isArray(body.events) ||
        body.events.length > 1000 ||
        body.events.some(
          (x) =>
            !x.event ||
            typeof x.event.id !== "string" ||
            !Number.isFinite(x.event.at) ||
            typeof x.event.kind !== "string",
        )
      )
        return new Response(null, { status: 400 });
      const ack = await appendModalEvents(options.sql, scope, claims.sandboxId, claims.generation, body.events);
      return Response.json({ acknowledgedSequence: ack });
    } catch {
      return new Response(null, { status: 403 });
    }
  };
}
