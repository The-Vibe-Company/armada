import { isOttoUuid, type Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { objectiveStore } from "./objectives.ts";
import type { OttoScope } from "./observation.ts";

export function createOttoObjectivesApi(
  sql: Sql,
  authenticate: (request: Request) => Promise<CallerResult>,
  scopes?: readonly OttoScope[],
): Route {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.match(/^\/api\/v1\/otto\/objectives(?:\/([^/]+))?$/);
    if (!path) return null;
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    try {
      const auth = await authenticate(request);
      if (!auth.ok) return reply({ error: "unauthorized" }, 401);
      if (auth.caller.via !== "supabase") return reply({ error: "forbidden" }, 403);
      const org = url.searchParams.get("org_id");
      if (!org || !isOttoUuid(org) || !auth.caller.orgs.some((o) => o.orgId === org))
        return reply({ error: "not_found" }, 404);
      const id = path[1];
      if (id && !isOttoUuid(id)) return reply({ error: "not_found" }, 404);
      const store = objectiveStore(sql, auth.caller, org, scopes);
      if (request.method === "GET") {
        if (id) {
          const thread = await store.thread(id);
          return thread ? reply(thread) : reply({ error: "not_found" }, 404);
        }
        return reply({ items: await store.list(), repositories: await store.repositories() });
      }
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (Number(request.headers.get("content-length") ?? 0) > 100000)
        return reply({ error: "request_too_large" }, 413);
      const raw = await request.text();
      if (raw.length > 100000) return reply({ error: "request_too_large" }, 413);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "invalid_request" }, 400);
      const text = id ? body.body : body.request;
      if (typeof text !== "string" || !text.trim() || text.length > 20000)
        return reply({ error: "invalid_request" }, 400);
      if (id) {
        const message = await store.append(id, text.trim());
        return message ? reply(message, 201) : reply({ error: "not_found" }, 404);
      }
      if (typeof body.repository !== "string" || !(await store.repositories()).includes(body.repository))
        return reply({ error: "repository_not_connected" }, 400);
      const objective = await store.create(body.repository, text.trim());
      return objective ? reply({ objective }, 201) : reply({ error: "not_found" }, 404);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  };
}
