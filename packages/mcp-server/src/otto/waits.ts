import type { OttoWait, OttoWaitInput } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";

const columns =
  "id,objective_id,org_id,owner_id,dedupe_key,kind,reason,phase,question,choices,default_choice,connection_url,status,resolution,created_at,deadline_at,reminded_at";
const member = "exists(select 1 from public.members where org_id=$1 and user_id=$2)";
/** No provider/model effect. All resolution writes are conditional and owner scoped. */
export function waitStore(sql: Sql, caller: Caller, org: string) {
  const scope = [org, caller.userId];
  return {
    async list() {
      return (
        await sql.query<OttoWait>(
          `select ${columns} from public.otto_waits where org_id=$1 and owner_id=$2 and ${member} and kind in ('human','access') order by created_at,id`,
          scope,
        )
      ).rows;
    },
    /** Background resolver adapter: includes observation blockers, never the human-only inbox filter. */
    async pending() {
      return (
        await sql.query<OttoWait>(
          `select ${columns} from public.otto_waits where org_id=$1 and owner_id=$2 and ${member} and status in ('open','parked') order by created_at,id`,
          scope,
        )
      ).rows;
    },
    async create(input: OttoWaitInput) {
      if (
        !input.question.trim() ||
        input.question.length > 2000 ||
        !input.dedupe_key ||
        input.dedupe_key.length > 200 ||
        input.choices.length > 10 ||
        (input.kind === "human" && input.choices.length === 0) ||
        (input.kind === "access" && !input.connection_url) ||
        input.choices.some((c) => !/^[-a-zA-Z0-9_]{1,80}$/.test(c.id) || !c.label.trim() || c.label.length > 300) ||
        new Set(input.choices.map((c) => c.id)).size !== input.choices.length
      )
        throw new Error("invalid_wait");
      if (
        input.default_choice &&
        (input.kind !== "human" ||
          input.reason !== "reversible" ||
          !input.choices.some((c) => c.id === input.default_choice))
      )
        throw new Error("invalid_default");
      if (input.connection_url && input.connection_url !== "/settings") throw new Error("invalid_connection");
      return (
        (
          await sql.query<OttoWait>(
            `insert into public.otto_waits(org_id,owner_id,objective_id,dedupe_key,kind,reason,phase,question,choices,default_choice,connection_url)
 select $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11 where ${member} and exists(select 1 from public.otto_objectives where org_id=$1 and owner_id=$2 and id=$3)
 on conflict(objective_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key returning ${columns}`,
            [
              ...scope,
              input.objective_id,
              input.dedupe_key,
              input.kind,
              input.reason,
              input.phase,
              input.question,
              JSON.stringify(input.choices),
              input.default_choice ?? null,
              input.connection_url ?? null,
            ],
          )
        ).rows[0] ?? null
      );
    },
    async answer(id: string, choice: string) {
      return (
        (
          await sql.query<OttoWait>(
            `update public.otto_waits set status='answered',resolution=$4 where org_id=$1 and owner_id=$2 and id=$3 and ${member} and kind='human' and status in ('open','parked') and (status='parked' or deadline_at>clock_timestamp()) and exists(select 1 from jsonb_array_elements(choices) c where c->>'id'=$4) returning ${columns}`,
            [...scope, id, choice],
          )
        ).rows[0] ?? null
      );
    },
    /** Claim one reminder exactly once. Caller can deliver returned rows; no routine-progress notifications. */
    async reconcile(now = new Date().toISOString()) {
      return (
        await sql.query<OttoWait>(
          `update public.otto_waits set status=case when reason='reversible' and default_choice is not null then 'defaulted' else 'parked' end,resolution=case when reason='reversible' then default_choice else null end,reminded_at=$3::timestamptz where org_id=$1 and owner_id=$2 and ${member} and kind in ('human','access') and status='open' and deadline_at<=$3::timestamptz and reminded_at is null returning ${columns}`,
          [...scope, now],
        )
      ).rows;
    },
    // Observation resolution is intentionally absent until #1828 validates observed proof.
  };
}
