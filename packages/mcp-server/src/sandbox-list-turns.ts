import type { AgentEvent } from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "./caller.ts";

type RecordedTurn = "queued" | "running" | "finished";

export function createSandboxListTurns(sql: Sql, key: string) {
  return async (caller: Caller, orgId: string) => {
    const { rows } = await sql.query<{
      id: string;
      queued: boolean;
      active: boolean;
      awaiting_receipt: boolean;
      prompt_id: string | null;
      latest_prompt_enc: Uint8Array<ArrayBuffer> | null;
      finished: boolean;
    }>(
      `select s.id,
        (exists(select 1 from public.account_turn_queue q where q.sandbox_id=s.id
           and (s.lifecycle_generation in (q.queued_generation,q.dispatch_generation)
             or (s.status<>'stopped' and q.state='dispatching'
               and s.lifecycle_generation=q.dispatch_generation+1))
           and q.state in ('queued','dispatching'))
         or exists(select 1 from public.docker_queued_prompts q where q.sandbox_id=s.id
           and q.lifecycle_generation=s.lifecycle_generation and q.status in ('queued','dispatching'))) as queued,
        (s.status in ('ready','running') and current_turn.id is not null
          and not coalesce(t.settled,false) and f.terminal_status is null
          and (s.boat_runtime or s.runtime_transport='dialout' or s.provider='docker' or s.status='running')) as active,
        coalesce(docker_turn.awaiting_receipt,false) as awaiting_receipt,
        current_turn.id as prompt_id,
        e.latest_prompt_enc,
        (s.status='ready' and f.terminal_status='finished') as finished
       from public.sandboxes s
       join public.members m on m.org_id=s.org_id and m.user_id=$2
       left join public.runtime_idle_evidence e on e.sandbox_id=s.id
       left join lateral (
         select c.accepted_prompt_id,c.result_enc is null as awaiting_receipt
         from public.runtime_enrolments r
         join public.runtime_commands c on c.sandbox_id=r.sandbox_id and c.epoch=r.epoch
         where s.provider='docker' and r.sandbox_id=s.id and r.lifecycle_generation=s.lifecycle_generation
           and starts_with(c.request_id,'docker_prompt_')
           and (c.result_enc is null or c.accepted_prompt_id is not null)
         order by c.sequence desc limit 1
       ) docker_turn on true
       cross join lateral (select coalesce(docker_turn.accepted_prompt_id::text,nullif(s.task_prompt_id,'')) as id) current_turn
       left join public.runtime_idle_turns t on t.sandbox_id=s.id and t.prompt_id=current_turn.id
       left join public.langfuse_turn_exports f on f.sandbox_id=s.id and f.prompt_id=current_turn.id
       where s.org_id=$1 and (s.owner_id=m.user_id or m.role='admin')
         and s.status in ('starting','ready','running','stopped') and s.stop_requested_at is null
         and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
      [orgId, caller.userId],
    );
    const turns = await Promise.all(
      rows.map(async ({ id, queued, active, awaiting_receipt, prompt_id, latest_prompt_enc, finished }) => {
        let state: RecordedTurn | null = null;
        if (queued) state = "queued";
        else if (awaiting_receipt) return [id, null] as const;
        else if (active) state = "running";
        else if (latest_prompt_enc) {
          const prompt = JSON.parse(await decryptSecret(latest_prompt_enc, key)) as AgentEvent;
          if (prompt.kind === "prompt" && (!prompt_id || prompt.promptId === prompt_id)) {
            if (prompt.status === "running" || prompt.status === "queued") state = prompt.status;
            else if (prompt.status === "finished") state = "finished";
          }
        } else if (finished) state = "finished";
        return [id, state] as const;
      }),
    );
    return Object.fromEntries(turns.filter((entry): entry is readonly [string, RecordedTurn] => entry[1] !== null));
  };
}
