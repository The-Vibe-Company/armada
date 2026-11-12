import type { OttoFact } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import type { OttoScope } from "./observation.ts";
import { readOttoModel } from "./read-model.ts";

/** Auth is deliberately per request; service role reads never bypass caller membership. */
export function createOttoApi(
  sql: Sql,
  scope: OttoScope,
  authenticate: (request: Request) => Promise<CallerResult>,
  now = () => new Date(),
): Route {
  return async (request) => {
    const url = new URL(request.url);
    const view = url.pathname.match(/^\/api\/v1\/otto\/(summary|tasks|resources|orphans|facts)$/)?.[1];
    if (!view) return null;
    const reply = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "GET") return reply({ error: "read_only" }, 405);
    try {
      const auth = await authenticate(request);
      if (!auth.ok) return reply({ error: "unauthorized" }, 401);
      if (
        url.searchParams.get("org_id") !== scope.orgId ||
        (url.searchParams.has("repository") && url.searchParams.get("repository") !== scope.repository) ||
        !auth.caller.orgs.some((o) => o.orgId === scope.orgId)
      )
        return reply({ error: "not_found" }, 404);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply({ error: "invalid_limit" }, 400);
      const cursor = url.searchParams.get("cursor");
      if (cursor && cursor.length > 512) return reply({ error: "invalid_cursor" }, 400);
      if (view === "facts") {
        let at: string | null = null,
          id: string | null = null;
        if (cursor) {
          try {
            const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
            if (
              !Array.isArray(parsed) ||
              typeof parsed[0] !== "string" ||
              !Number.isFinite(Date.parse(parsed[0])) ||
              typeof parsed[1] !== "string" ||
              !/^[0-9a-f-]{36}$/i.test(parsed[1])
            )
              throw Error();
            [at, id] = parsed;
          } catch {
            return reply({ error: "invalid_cursor" }, 400);
          }
        }
        const rows = (
          await sql.query<OttoFact>(
            `select * from public.otto_facts where org_id=$1 and repository=$2 and ($3::timestamptz is null or (observed_at,id)<($3::timestamptz,$4::uuid)) order by observed_at desc,id desc limit $5`,
            [scope.orgId, scope.repository, at, id, limit + 1],
          )
        ).rows;
        const items = rows.slice(0, limit),
          last = items.at(-1);
        return reply({
          items,
          observedAt: items[0]?.observed_at ?? null,
          completeness: "unknown",
          nextCursor:
            rows.length > limit && last
              ? Buffer.from(JSON.stringify([last.observed_at, last.id])).toString("base64url")
              : null,
        });
      }
      const model = await readOttoModel(sql, scope, auth.caller, now());
      const orphans = model.resources
        .filter((r) => r.kind === "pr" || r.taskIssue === null)
        .map((resource) => ({
          resource,
          state: "unknown",
          reason: resource.reason,
          day: now().toISOString().slice(0, 10),
        }));
      const values =
        view === "resources"
          ? model.resources.map((r) => ({ key: `${r.kind}:${r.externalId}`, value: r }))
          : view === "tasks"
            ? model.tasks.map((t) => ({ key: String(t.issueNumber).padStart(16, "0"), value: t }))
            : view === "orphans"
              ? orphans.map((o) => ({ key: `${o.resource.kind}:${o.resource.externalId}`, value: o }))
              : [
                  {
                    key: "summary",
                    value: {
                      openPrCount:
                        model.completeness === "complete"
                          ? model.resources.filter((r) => r.kind === "pr").length
                          : null,
                      orphanCount: null,
                      ownershipCompleteness: "unknown",
                      fleetCoverage: "armada_registered_only",
                      limitations: [
                        "Current sandbox checkout/task responsibility is not observed by existing metadata.",
                        "Unknown candidates are not confirmed orphans; historical orphan detection unavailable.",
                      ],
                    },
                  },
                ];
      const sorted = values
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .filter((v) => !cursor || v.key > cursor);
      return reply({
        items: sorted.slice(0, limit).map((v) => v.value),
        observedAt: model.observedAt,
        completeness: view === "summary" ? model.completeness : "unknown",
        githubCompleteness: model.completeness,
        nextCursor: sorted.length > limit ? sorted[limit - 1]?.key : null,
      });
    } catch {
      return reply({ error: "observation_unavailable" }, 503);
    }
  };
}
