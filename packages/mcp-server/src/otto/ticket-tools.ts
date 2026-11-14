import { ticketStates, validateTicketGraph } from "@armada/core";
import { isOttoUuid, type Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { objectiveStore } from "./objectives.ts";
import { ticketStore } from "./tickets.ts";

/** Ingest structured ticketise file contents; never writes a checkout or calls GitHub. */
export function createOttoTicketApi(sql: Sql, authenticate: (request: Request) => Promise<CallerResult>): Route {
  return async (request) => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/otto\/objectives\/([^/]+)\/tickets$/);
    if (!match) return null;
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    try {
      const auth = await authenticate(request);
      if (!auth.ok) return reply({ error: "unauthorized" }, 401);
      if (auth.caller.via !== "supabase") return reply({ error: "forbidden" }, 403);
      const org = url.searchParams.get("org_id"),
        id = match[1];
      if (!org || !id || !isOttoUuid(org) || !isOttoUuid(id) || !auth.caller.orgs.some((o) => o.orgId === org))
        return reply({ error: "not_found" }, 404);
      if (!(await objectiveStore(sql, auth.caller, org).thread(id))) return reply({ error: "not_found" }, 404);
      const store = ticketStore(sql, auth.caller, org, id);
      if (request.method === "GET") {
        const graph = await store.read();
        return reply({ graph, tickets: graph ? ticketStates(graph) : [] });
      }
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      const raw = await request.text();
      if (raw.length > 100000) return reply({ error: "request_too_large" }, 413);
      let graph: ReturnType<typeof validateTicketGraph>;
      try {
        graph = validateTicketGraph(JSON.parse(raw));
      } catch {
        return reply({ error: "invalid_graph" }, 400);
      }
      return (await store.publish(graph))
        ? reply({ graph, tickets: ticketStates(graph) }, 201)
        : reply({ error: "revision_conflict" }, 409);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  };
}
