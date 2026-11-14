import { isOttoUuid, type Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { waitStore } from "./waits.ts";

/** Browser callers can answer enumerated choices, never create prompts or submit credentials. */
export function createOttoWaitsApi(sql: Sql, authenticate: (request: Request) => Promise<CallerResult>): Route {
  return async (request) => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/otto\/waits(?:\/([^/]+))?$/);
    if (!match) return null;
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    try {
      const auth = await authenticate(request);
      if (!auth.ok) return reply({ error: "unauthorized" }, 401);
      if (auth.caller.via !== "supabase") return reply({ error: "forbidden" }, 403);
      const org = url.searchParams.get("org_id");
      if (!org || !isOttoUuid(org) || !auth.caller.orgs.some((o) => o.orgId === org))
        return reply({ error: "not_found" }, 404);
      const id = match[1];
      if (id && !isOttoUuid(id)) return reply({ error: "not_found" }, 404);
      const store = waitStore(sql, auth.caller, org);
      // Timers are durable SQL transitions; no model turn or external effect occurs here.
      await store.reconcile();
      if (request.method === "GET" && !id) return reply({ items: await store.list() });
      if (request.method !== "POST" || !id) return reply({ error: "method_not_allowed" }, 405);
      if (Number(request.headers.get("content-length") ?? 0) > 1024) return reply({ error: "request_too_large" }, 413);
      const raw = await request.text();
      if (raw.length > 1024) return reply({ error: "request_too_large" }, 413);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "choice") ||
        !("choice" in body) ||
        typeof body.choice !== "string" ||
        body.choice.length > 100
      )
        return reply({ error: "invalid_request" }, 400);
      const wait = await store.answer(id, body.choice);
      return wait ? reply({ wait }) : reply({ error: "wait_not_open_or_choice_invalid" }, 409);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  };
}
