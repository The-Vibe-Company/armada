-- Enrolled Boat MCP capabilities belong to one runtime epoch, not the host VM.
alter table public.mcp_leases add column runtime_epoch bigint check(runtime_epoch>0);

-- Durable revocation also protects older gateway replicas during a rolling deploy.
create function public.fence_runtime_mcp_leases() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.sandboxes s where s.id=new.sandbox_id and s.provider='boat' and s.boat_runtime) then
  update public.mcp_leases set revoked_at=coalesce(revoked_at,now())
   where sandbox_id=new.sandbox_id
   and (new.runtime_hash is null or runtime_epoch is distinct from new.epoch);
 end if;
 return new;
end $$;
revoke all on function public.fence_runtime_mcp_leases() from public,anon,authenticated;
create trigger fence_runtime_mcp_leases after update of epoch,runtime_hash on public.runtime_enrolments
 for each row execute function public.fence_runtime_mcp_leases();

create function public.fence_checkpoint_mcp_leases() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.sandboxes s where s.id=new.sandbox_id and s.provider='boat' and s.boat_runtime) then
  update public.mcp_leases set revoked_at=coalesce(revoked_at,now()) where sandbox_id=new.sandbox_id;
 end if;
 return new;
end $$;
revoke all on function public.fence_checkpoint_mcp_leases() from public,anon,authenticated;
create trigger fence_checkpoint_mcp_leases after insert on public.runtime_checkpoints
 for each row execute function public.fence_checkpoint_mcp_leases();
