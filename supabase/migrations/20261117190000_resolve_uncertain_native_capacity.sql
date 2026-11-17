-- Failed uncertain native receipts retain capacity independently of transient
-- admission reservations. Only confirmed physical stop/delete resolves them;
-- unrelated lifecycle advances (exec, steer, pending stop) do not. Clear in-flight
-- claims too: their failure handler may finish after the physical stop commits.
create function public.resolve_uncertain_native_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.stopped_at is not null or new.deleted_at is not null then
    update public.account_turn_queue set dispatch_generation=null
    where sandbox_id=new.id and dispatch_generation is not null
      and (state='dispatching' or (state='failed' and dispatch_until is null));
  end if;
  return new;
end;
$$;
revoke all on function public.resolve_uncertain_native_capacity() from public, anon, authenticated;
create trigger resolve_uncertain_native_capacity
  after update of stopped_at, deleted_at on public.sandboxes
  for each row execute function public.resolve_uncertain_native_capacity();

-- Resolve receipts for machines already physically stopped before this rollout.
update public.account_turn_queue q set dispatch_generation=null
from public.sandboxes s where s.id=q.sandbox_id
  and (s.stopped_at is not null or s.deleted_at is not null)
  and q.dispatch_generation is not null
  and (q.state='dispatching' or (q.state='failed' and q.dispatch_until is null));
