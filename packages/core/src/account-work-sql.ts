/** SQL fragments for the server-only account admission/list boundary. `s` is the sandbox alias.
 * Unknown accepted work stays occupied; a machine merely being alive does not.
 */
export const ACCOUNT_WORKING_PREDICATE = `s.deleted_at is null and s.stopped_at is null
  and s.status in ('starting','ready','running')
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
