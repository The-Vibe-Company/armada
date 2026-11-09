-- SQL activity revisions and provider-native incarnations are independent fences.
-- Existing grants lack a verified native binding and intentionally fail closed.
alter table public.sandboxes add column orchestrator_native_generation text;
alter table public.orchestrator_delegations add column native_generation text;

-- A native replacement is a revocation boundary even if a later writer restores
-- the previous string. No stale epoch can resurrect by rebinding the same name.
create function public.revoke_rebound_orchestrator_native() returns trigger language plpgsql
 set search_path=public as $$
begin
 if new.orchestrator_native_generation is distinct from old.orchestrator_native_generation then
  update public.orchestrators set authority_epoch=authority_epoch+1 where sandbox_id=new.id;
 end if;
 return new;
end $$;
create trigger orchestrator_native_rebind after update of orchestrator_native_generation on public.sandboxes
 for each row execute function public.revoke_rebound_orchestrator_native();
revoke all on function public.revoke_rebound_orchestrator_native() from public,anon,authenticated;
