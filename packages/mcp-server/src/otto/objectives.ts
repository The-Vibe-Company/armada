import type { OttoObjective, OttoObjectiveMessage } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";

const columns = "id,org_id,owner_id,repository,request,revision,created_at,updated_at";
const messageColumns = "id,objective_id,org_id,owner_id,body,revision,created_at";
/** SQL bypasses RLS: every operation independently names both organization and owner. */
export function objectiveStore(sql: Sql, caller: Caller, org: string) {
  const scope = [org, caller.userId];
  return {
    async repositories() {
      const rows = (
        await sql.query<{ config: { repos?: { url?: string }[] } }>(
          `select config from public.goldens where org_id=$1 and (visibility='org' or owner_id=$2)`,
          scope,
        )
      ).rows;
      const names = new Set<string>();
      for (const row of rows)
        for (const repo of row.config?.repos ?? []) {
          const match = repo.url?.match(
            /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
          );
          if (match) names.add(match[1]!);
        }
      return [...names].sort();
    },
    async list() {
      return (
        await sql.query<OttoObjective>(
          `select ${columns} from public.otto_objectives where org_id=$1 and owner_id=$2 order by created_at desc,id desc limit 100`,
          scope,
        )
      ).rows;
    },
    async thread(id: string) {
      const objective = (
        await sql.query<OttoObjective>(
          `select ${columns} from public.otto_objectives where org_id=$1 and owner_id=$2 and id=$3`,
          [...scope, id],
        )
      ).rows[0];
      if (!objective) return null;
      const messages = (
        await sql.query<OttoObjectiveMessage>(
          `select ${messageColumns} from public.otto_objective_messages where org_id=$1 and owner_id=$2 and objective_id=$3 order by created_at,id`,
          [...scope, id],
        )
      ).rows;
      return { objective, messages };
    },
    async create(repository: string, request: string) {
      // The request itself is the durable intention; no engine or external effect is invoked.
      return (
        await sql.query<OttoObjective>(
          `insert into public.otto_objectives(org_id,owner_id,repository,request) select $1,$2,$3,$4 where exists(select 1 from public.members where org_id=$1 and user_id=$2) returning ${columns}`,
          [...scope, repository, request],
        )
      ).rows[0];
    },
    async append(id: string, body: string) {
      return (
        await sql.query<OttoObjectiveMessage>(
          `insert into public.otto_objective_messages(org_id,owner_id,objective_id,body) select $1,$2,id,$4 from public.otto_objectives where org_id=$1 and owner_id=$2 and id=$3 and exists(select 1 from public.members where org_id=$1 and user_id=$2) returning ${messageColumns}`,
          [...scope, id, body],
        )
      ).rows[0];
    },
  };
}
