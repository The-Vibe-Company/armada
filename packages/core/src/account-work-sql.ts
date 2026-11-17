/** SQL fragments for the server-only account admission/list boundary. `s` is the sandbox alias.
 * Unknown accepted work stays occupied; a machine merely being alive does not.
 */
export const ACCOUNT_WORKING_PREDICATE = `s.deleted_at is null and s.stopped_at is null
  and s.status in ('starting','ready','running','stopping')
  and (s.status='starting' or s.activity_lease_id is not null
    or (s.task_prompt_id is not null and not exists(
      select 1 from public.runtime_idle_turns t
      where t.sandbox_id=s.id and t.prompt_id=s.task_prompt_id and t.settled)))`;

/** Expressions are static trusted SQL supplied by server code, never user input. */
export function accountWorkingCountSql(account: string, exclude = "null::uuid", model?: string): string {
  return `(select count(*) from (
    select s.id from public.sandboxes s where s.credential_id=${account}
      ${model ? `and (exists(select 1 from public.account_turn_queue unknown_turn where unknown_turn.sandbox_id=s.id and unknown_turn.state in ('admitted','dispatching') and unknown_turn.model is null) or coalesce((select active.model from public.account_turn_queue active where active.sandbox_id=s.id and active.state in ('admitted','dispatching') order by active.sequence desc limit 1),s.model)=${model})` : ""} and s.id is distinct from ${exclude} and ${ACCOUNT_WORKING_PREDICATE}
    -- A terminal uncertain native receipt still owns capacity, including its requested
    -- model, after ordinary admission cleanup removes the transient reservation.
    -- Pre-dispatch failures clear dispatch_generation; other terminalizations retain
    -- their dispatch deadline. Confirmed physical stop/delete releases this charge.
    union select q.sandbox_id from public.account_turn_queue q
      join public.sandboxes uncertain on uncertain.id=q.sandbox_id
      where q.account_id=${account} and uncertain.credential_id=q.account_id
        and q.state='failed' and q.dispatch_generation is not null and q.dispatch_until is null
        and uncertain.stopped_at is null and uncertain.deleted_at is null
        and uncertain.status in ('starting','ready','running','stopping')
        and ((uncertain.status='stopping' and uncertain.stop_requested_at is not null)
          or uncertain.lifecycle_generation=q.dispatch_generation+1
          or (uncertain.lifecycle_generation=q.dispatch_generation+2
            and uncertain.task_prompt_id is not null and not exists(
              select 1 from public.runtime_idle_turns settled where settled.sandbox_id=uncertain.id
                and settled.prompt_id=uncertain.task_prompt_id and settled.settled)))
        ${model ? `and (q.model is null or q.model=${model})` : ""}
        and q.sandbox_id is distinct from ${exclude}
    union select r.sandbox_id from public.account_agent_reservations r
      where r.account_id=${account} ${model ? `and (r.model is null or r.model=${model})` : ""} and r.sandbox_id is distinct from ${exclude}
        and not exists(select 1 from public.sandboxes ended where ended.id=r.sandbox_id
          and (ended.deleted_at is not null or ended.stopped_at is not null)
          and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=ended.id
            and q.state='dispatching' and q.dispatch_generation=ended.lifecycle_generation))
  ) account_work)`;
}

/** A queue receipt is not itself evidence of waiting for account capacity. */
export function accountWaitingCountSql(account: string, limit: string, model?: string): string {
  return `(select count(*) from public.account_turn_queue q join public.sandboxes waiting on waiting.id=q.sandbox_id
    where q.account_id=${account} and q.state='queued' ${model ? `and q.model=${model}` : ""}
    and ((${limit} is not null and ${accountWorkingCountSql(account)}>=${limit})
      or (select (c.model_limits->>q.model)::integer from public.credentials c where c.id=q.account_id)<=${accountWorkingCountSql(account, "null::uuid", "q.model")})
    and waiting.credential_id=q.account_id and waiting.credential_version=q.credential_version
    and not exists(select 1 from public.account_agent_reservations own_slot where own_slot.sandbox_id=waiting.id and own_slot.account_id=q.account_id)
    and not (${ACCOUNT_WORKING_PREDICATE.replaceAll("s.", "waiting.")})
    and not exists(select 1 from public.account_turn_queue active where active.sandbox_id=waiting.id and active.state='dispatching')
    and waiting.deleted_at is null and waiting.expires_at>now() and waiting.stop_requested_at is null
    and waiting.status in ('ready','running','stopped')
    and (waiting.status<>'stopped' or waiting.lifecycle_generation=q.queued_generation))`;
}

/** Model usage includes models with work as well as configured limits. */
export function accountModelCountsSql(account: string, limits: string): string {
  return `(select coalesce(jsonb_object_agg(models.model,jsonb_build_object('runningAgents',${accountWorkingCountSql(account, "null::uuid", "models.model")},'waitingAgents',${accountWaitingCountSql(account, `(select model_count_account.max_agents from public.credentials model_count_account where model_count_account.id=${account})`, "models.model")})),'{}'::jsonb) from (
    select jsonb_object_keys(${limits}) as model union select s.model from public.sandboxes s where s.credential_id=${account} and s.model is not null
    union select q.model from public.account_turn_queue q where q.account_id=${account} and q.model is not null
    union select r.model from public.account_agent_reservations r where r.account_id=${account} and r.model is not null
  ) models)`;
}
