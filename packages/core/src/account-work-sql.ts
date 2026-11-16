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
export function accountWorkingCountSql(account: string, exclude = "null::uuid"): string {
  return `(select count(*) from (
    select s.id from public.sandboxes s where s.credential_id=${account}
      and s.id is distinct from ${exclude} and ${ACCOUNT_WORKING_PREDICATE}
    union select r.sandbox_id from public.account_agent_reservations r
      where r.account_id=${account} and r.sandbox_id is distinct from ${exclude}
        and not exists(select 1 from public.sandboxes ended where ended.id=r.sandbox_id
          and (ended.deleted_at is not null or ended.stopped_at is not null)
          and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=ended.id
            and q.state='dispatching' and q.dispatch_generation=ended.lifecycle_generation))
  ) account_work)`;
}

/** A queue receipt is not itself evidence of waiting for account capacity. */
export function accountWaitingCountSql(account: string, limit: string): string {
  return `(select count(*) from public.account_turn_queue q join public.sandboxes waiting on waiting.id=q.sandbox_id
    where q.account_id=${account} and q.state='queued' and ${limit} is not null
    and ${accountWorkingCountSql(account)}>=${limit}
    and waiting.credential_id=q.account_id and waiting.credential_version=q.credential_version
    and not exists(select 1 from public.account_agent_reservations own_slot where own_slot.sandbox_id=waiting.id and own_slot.account_id=q.account_id)
    and not (${ACCOUNT_WORKING_PREDICATE.replaceAll("s.", "waiting.")})
    and not exists(select 1 from public.account_turn_queue active where active.sandbox_id=waiting.id and active.state='dispatching')
    and waiting.deleted_at is null and waiting.expires_at>now() and waiting.stop_requested_at is null
    and waiting.status in ('ready','running','stopped')
    and (waiting.status<>'stopped' or waiting.lifecycle_generation=q.queued_generation))`;
}
