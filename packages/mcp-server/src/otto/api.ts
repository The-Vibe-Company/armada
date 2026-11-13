import type { OttoFact } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import type { OttoScope } from "./observation.ts";
import { orphanDays } from "./orphan-days.ts";
import { readOttoModel } from "./read-model.ts";

/** Auth is deliberately per request; service role reads never bypass caller membership. */
export function createOttoApi(
  sql: Sql,
  scope: OttoScope,
  authenticate: (request: Request) => Promise<CallerResult>,
  now = () => new Date(),
  encryptionKey?: string,
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
      const observedNow = now();
      const day = url.searchParams.get("day") ?? observedNow.toISOString().slice(0, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day)) ||
        new Date(day).toISOString().slice(0, 10) !== day ||
        day > observedNow.toISOString().slice(0, 10)
      )
        return reply({ error: "invalid_day" }, 400);
      const model = await readOttoModel(sql, scope, auth.caller, observedNow, encryptionKey);
      const daily = await orphanDays(
        sql,
        scope,
        auth.caller,
        model.resources,
        model.completeness === "complete",
        observedNow,
        day,
      );
      const unknown = model.resources
        .filter(
          (r) =>
            r.owner.state === "unknown" ||
            r.owner.state === "candidate" ||
            r.activity?.state === "unknown" ||
            (r.activity?.state === "idle" && r.needsWork === "unknown"),
        )
        .map((resource) => ({ resource, state: "unknown", reason: resource.reason, day }));
      const orphans = day === observedNow.toISOString().slice(0, 10) ? [...daily, ...unknown] : daily;
      const values =
        view === "resources"
          ? model.resources.map((r) => ({ key: `${r.kind}:${r.externalId}`, value: r }))
          : view === "tasks"
            ? model.tasks.map((t) => ({ key: String(t.issueNumber).padStart(16, "0"), value: t }))
            : view === "orphans"
              ? orphans.map((o) => ({ key: `${o.resource.kind}:${o.resource.externalId}:${o.reason}`, value: o }))
              : [
                  {
                    key: "summary",
                    value: {
                      openPrCount:
                        model.completeness === "complete"
                          ? model.resources.filter((r) => r.kind === "pr").length
                          : null,
                      orphanCount:
                        model.orphanCompleteness === "complete" ? daily.filter((o) => o.current === true).length : null,
                      confirmedDailyOrphanCount: daily.length,
                      ownershipCompleteness: model.ownershipCompleteness,
                      orphanCompleteness: model.orphanCompleteness,
                      fleetCompleteness: model.fleetCompleteness,
                      fleetCoverage: "armada_database",
                      fleetScope: "caller_visible",
                      notObservable: ["external_workstations"],
                    },
                  },
                ];
      const sorted = values
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .filter((v) => !cursor || v.key > cursor);
      return reply({
        items: sorted.slice(0, limit).map((v) => v.value),
        observedAt: model.observedAt,
        completeness: model.completeness,
        ownershipCompleteness: model.ownershipCompleteness,
        orphanCompleteness: model.orphanCompleteness,
        fleetCompleteness: model.fleetCompleteness,
        githubCompleteness: model.completeness,
        nextCursor: sorted.length > limit ? sorted[limit - 1]?.key : null,
      });
    } catch {
      return reply({ error: "observation_unavailable" }, 503);
    }
  };
}
