import type { Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { inspectMechanicalProof, mechanicalProof } from "./mechanical-proof.ts";
import type { OttoScope } from "./observation.ts";
import type { OwnershipFact } from "./ownership.ts";

export function createOttoProofApi(
  sql: Sql,
  scope: OttoScope,
  authenticate: (r: Request) => Promise<CallerResult>,
  observerToken?: string,
): Route {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/v1/otto/evidence") return null;
    const reply = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "GET") return reply({ error: "read_only" }, 405);
    const auth = await authenticate(request);
    if (!auth.ok) return reply({ error: "unauthorized" }, 401);
    if (
      url.searchParams.get("org_id") !== scope.orgId ||
      url.searchParams.get("repository") !== scope.repository ||
      !auth.caller.orgs.some((o) => o.orgId === scope.orgId)
    )
      return reply({ error: "not_found" }, 404);
    const number = Number(url.searchParams.get("number"));
    if (!Number.isSafeInteger(number) || number < 1) return reply({ error: "invalid_number" }, 400);
    try {
      if (observerToken) {
        const proof = await inspectMechanicalProof(scope.repository, number, observerToken);
        const id = crypto.randomUUID();
        await sql.query(
          "insert into public.otto_facts(id,org_id,repository,subject,kind,value,source,source_id,completeness,evidence) values($1::uuid,$2,$3,$4,'pr.mechanical_proof','unknown','github.proof',$1::text,'partial',$5::jsonb)",
          [id, scope.orgId, scope.repository, `pr:${number}`, JSON.stringify(proof)],
        );
        proof.evidence = [
          {
            factId: id,
            kind: "pr.mechanical_proof",
            observedAt: proof.observedAt ?? new Date().toISOString(),
            url: `https://github.com/${scope.repository}/pull/${number}`,
          },
        ];
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
