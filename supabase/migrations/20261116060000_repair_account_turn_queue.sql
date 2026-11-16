-- Remember acceptance generation so an explicit later stop cancels waiting work,
-- while a new send to already paused compute can use the normal resume path.
alter table public.account_turn_queue add column queued_generation bigint;
update public.account_turn_queue q set queued_generation=s.lifecycle_generation
from public.sandboxes s where s.id=q.sandbox_id;
-- Support older server replicas during the deployment transition.
create function public.set_account_turn_queue_generation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.queued_generation is null then
    select lifecycle_generation into new.queued_generation from public.sandboxes where id=new.sandbox_id;
  end if;
  return new;
end;
$$;
revoke all on function public.set_account_turn_queue_generation() from public, anon, authenticated;
create trigger set_account_turn_queue_generation before insert on public.account_turn_queue
for each row execute function public.set_account_turn_queue_generation();
alter table public.account_turn_queue alter column queued_generation set not null;

-- Historical queued rows have no stop-generation evidence. Fail stopped rows
-- rather than resurrecting work cancelled by an owner. Live rows remain queued
-- and the repaired dispatcher drains them, including unlimited accounts.
update public.account_turn_queue q set state='failed',
  failure_reason='Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.'
from public.sandboxes s where s.id=q.sandbox_id and q.state='queued'
  and (s.deleted_at is not null or s.stopped_at is not null
    or s.expires_at<=now() or s.stop_requested_at is not null
    or s.status not in ('ready','running'));
