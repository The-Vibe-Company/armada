import { type OttoTicketGraph, type OttoTicketProof, ticketStates, validateTicketGraph } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";

/** Immutable graph per brief revision. Identical retries preserve IDs; changed revisions are explicit. */
export function ticketStore(sql: Sql, caller: Caller, org: string, objective: string) {
  const scope = [org, caller.userId, objective];
  return {
    async read(): Promise<OttoTicketGraph | null> {
      return (
        (
          await sql.query<{ graph: OttoTicketGraph }>(
            `select g.graph from public.otto_ticket_graphs g join public.otto_objectives o
         on o.id=g.objective_id where o.org_id=$1 and o.owner_id=$2 and o.id=$3
         order by g.brief_revision desc limit 1`,
            scope,
          )
        ).rows[0]?.graph ?? null
      );
    },
    async states(graph: OttoTicketGraph) {
      // #1830 owns admission: raw PR observations and worker claims never release edges.
      const proofs = (
        await sql.query<OttoTicketProof>(
          `select id as "factId", evidence->>'ticketId' as "ticketId",
          (evidence->>'criterionIndex')::integer as "criterionIndex" from (
         select distinct on (f.evidence->>'ticketId',f.evidence->>'criterionIndex') f.*
         from public.otto_facts f join public.otto_objectives o
          on f.org_id=o.org_id and f.repository=o.repository
         where o.org_id=$1 and o.owner_id=$2 and o.id=$3
          and f.kind='ticket.criterion.proof' and f.source='criterion-proof'
          and f.evidence->>'objectiveId'=o.id::text
          and f.evidence->>'briefRevision'=$4
          and f.evidence->>'criterionIndex' ~ '^[0-2]$'
         order by f.evidence->>'ticketId',f.evidence->>'criterionIndex',f.observed_at desc,f.id desc
         ) latest where value='true' and completeness='complete'`,
          [...scope, String(graph.briefRevision)],
        )
      ).rows;
      return ticketStates(graph, proofs);
    },
    async publish(input: unknown): Promise<boolean> {
      const graph = validateTicketGraph(input);
      const result = await sql.query<{ graph: OttoTicketGraph }>(
        `with intention as (
           insert into public.otto_ticket_publications(objective_id,org_id,owner_id,brief_revision,tool,input)
           select id,org_id,owner_id,$4,'publish_ticket_graph',$5::jsonb from public.otto_objectives
           where org_id=$1 and owner_id=$2 and id=$3
            and exists(select 1 from public.members where org_id=$1 and user_id=$2)
            -- Legacy graphs predate this journal: reject mismatches before recording an intention.
            and not exists(select 1 from public.otto_ticket_graphs g
              where g.objective_id=$3 and g.brief_revision=$4 and g.graph<>$5::jsonb)
           on conflict(objective_id,brief_revision) do update set input=otto_ticket_publications.input
            where otto_ticket_publications.input=excluded.input
           returning objective_id,org_id,owner_id,brief_revision,input
         )
         insert into public.otto_ticket_graphs(objective_id,org_id,owner_id,brief_revision,graph)
         select objective_id,org_id,owner_id,brief_revision,input from intention
         on conflict(objective_id,brief_revision) do update set graph=otto_ticket_graphs.graph
         where otto_ticket_graphs.graph=excluded.graph returning graph`,
        [...scope, graph.briefRevision, JSON.stringify(graph)],
      );
      return result.rows.length === 1;
    },
  };
}
