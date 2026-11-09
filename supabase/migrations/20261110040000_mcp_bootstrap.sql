-- Server-only successful native installation receipt. Never contains config, bearer or upstream secrets.
create table public.mcp_bootstraps (
 sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
 physical_generation text not null,
 revision text not null,
 configured boolean not null default false
);
alter table public.mcp_bootstraps enable row level security;
revoke all on public.mcp_bootstraps from public,anon,authenticated;
grant all on public.mcp_bootstraps to service_role;

-- Deployment fencing: credentials minted by older bootstrap mechanisms cannot survive migration.
update public.mcp_leases set revoked_at=now() where revoked_at is null;
update public.sandboxes s set mcp_generation=mcp_generation+1
where exists(select 1 from public.mcp_bindings b where b.sandbox_id=s.id);

-- A consumed OAuth state still carries this epoch through token exchange. Keep tombstones
-- across member removal/readdition; never rotate unrelated explicitly shared org grants.
create table public.mcp_actor_epochs (
 org_id uuid not null references public.orgs(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 epoch bigint not null default 0,
 primary key(org_id,user_id)
);
alter table public.mcp_actor_epochs enable row level security;
revoke all on public.mcp_actor_epochs from public,anon,authenticated;
grant all on public.mcp_actor_epochs to service_role;
insert into public.mcp_actor_epochs(org_id,user_id) select org_id,user_id from public.members;
create function public.fence_mcp_actor_epoch() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='UPDATE' and new.org_id=old.org_id and new.user_id=old.user_id and new.role=old.role then return new; end if;
 if tg_op<>'INSERT' and exists(select 1 from public.orgs where id=old.org_id) and exists(select 1 from auth.users where id=old.user_id) then
  insert into public.mcp_actor_epochs(org_id,user_id,epoch) values(old.org_id,old.user_id,1)
  on conflict(org_id,user_id) do update set epoch=mcp_actor_epochs.epoch+1;
 end if;
 if tg_op='INSERT' or (tg_op='UPDATE' and (new.org_id<>old.org_id or new.user_id<>old.user_id)) then
  insert into public.mcp_actor_epochs(org_id,user_id,epoch) values(new.org_id,new.user_id,1)
  on conflict(org_id,user_id) do update set epoch=mcp_actor_epochs.epoch+1;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.fence_mcp_actor_epoch() from public,anon,authenticated;
create trigger fence_mcp_actor_epoch after insert or update or delete on public.members
for each row execute function public.fence_mcp_actor_epoch();
