import type { Sql } from "@armada/core/server";
import type { Caller, CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { inspectMechanicalProof, mechanicalProof } from "./mechanical-proof.ts";
import type { OttoScope } from "./observation.ts";
import type { OwnershipFact } from "./ownership.ts";

export function createOttoProofApi(
  sql: Sql,
  binding: OttoScope | readonly OttoScope[],
  authenticate: (r: Request) => Promise<CallerResult>,
  observerToken?: string,
  canReadRepository: (caller: Caller, repository: string) => Promise<boolean> = async () => false,
): Route {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/v1/otto/evidence") return null;
    const reply = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "GET") return reply({ error: "read_only" }, 405);
    const auth = await authenticate(request);
    if (!auth.ok) return reply({ error: "unauthorized" }, 401);
    const scopes: readonly OttoScope[] = Array.isArray(binding) ? binding : [binding as OttoScope];
    const scope = scopes.find(
      (candidate) =>
        url.searchParams.get("org_id") === candidate.orgId &&
        url.searchParams.get("repository") === candidate.repository &&
        auth.caller.orgs.some((o) => o.orgId === candidate.orgId),
    );
    if (!scope) return reply({ error: "not_found" }, 404);
    try {
      if (!(await canReadRepository(auth.caller, scope.repository))) return reply({ error: "not_found" }, 404);
    } catch {
      return reply({ error: "not_found" }, 404);
    }
    const number = Number(url.searchParams.get("number"));
    if (!Number.isSafeInteger(number) || number < 1) return reply({ error: "invalid_number" }, 400);
    try {
      if (observerToken) {
        const proof = await inspectMechanicalProof(scope.repository, number, observerToken);
        // Live reads are ephemeral: viewing evidence must not grow the append-only journal.
        return reply(proof);
      }
      const { rows } = await sql.query<OwnershipFact>(
        `select distinct on (kind) id,subject,kind,value,completeness,evidence,observed_at from public.otto_facts where org_id=$1 and repository=$2 and subject=$3 order by kind,observed_at desc,id desc`,
        [scope.orgId, scope.repository, `pr:${number}`],
      );
      return reply(mechanicalProof(scope.repository, number, rows, new Date()));
    } catch {
      return reply(mechanicalProof(scope.repository, number, [], new Date()));
    }
  };
}
