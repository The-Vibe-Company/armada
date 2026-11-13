-- Common MCP capabilities follow enrolled Modal epochs as well as Boat epochs.
-- Keep native Modal leases outside this boundary; existing triggers retain their identity.
create or replace function public.fence_runtime_mcp_leases() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.sandboxes s where s.id=new.sandbox_id
  and ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))) then
  update public.mcp_leases set revoked_at=coalesce(revoked_at,now())
   where sandbox_id=new.sandbox_id
   and (new.runtime_hash is null or runtime_epoch is distinct from new.epoch);
 end if;
 return new;
end $$;
revoke all on function public.fence_runtime_mcp_leases() from public,anon,authenticated;

create or replace function public.fence_checkpoint_mcp_leases() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.sandboxes s where s.id=new.sandbox_id
  and ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))) then
  update public.mcp_leases set revoked_at=coalesce(revoked_at,now()) where sandbox_id=new.sandbox_id;
 end if;
 return new;
end $$;
revoke all on function public.fence_checkpoint_mcp_leases() from public,anon,authenticated;
