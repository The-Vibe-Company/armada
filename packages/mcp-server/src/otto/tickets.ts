import type { OttoTicketGraph } from "@armada/core";
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
    async publish(graph: OttoTicketGraph): Promise<boolean> {
      const result = await sql.query<{ graph: OttoTicketGraph }>(
        `insert into public.otto_ticket_graphs(objective_id,org_id,owner_id,brief_revision,graph)
         select id,org_id,owner_id,$4,$5::jsonb from public.otto_objectives
         where org_id=$1 and owner_id=$2 and id=$3
         and exists(select 1 from public.members where org_id=$1 and user_id=$2)
         on conflict(objective_id,brief_revision) do update set graph=otto_ticket_graphs.graph
         where otto_ticket_graphs.graph=excluded.graph returning graph`,
        [...scope, graph.briefRevision, JSON.stringify(graph)],
      );
      return result.rows.length === 1;
    },
  };
}
