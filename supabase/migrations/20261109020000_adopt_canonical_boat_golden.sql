-- Fail closed if pre-existing bindings are inconsistent; never reconcile/delete rows here.
create unique index golden_backend_one_binding on public.golden_backend_slots(golden_id) where golden_id is not null;
create unique index boat_backend_one_slot on public.golden_backend_slots(backend_id) where provider = 'boat';

-- A dry run records only a short-lived confirmation receipt, never a binding.
create table public.golden_adoption_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  golden_id uuid not null references public.goldens(id),
  backend_id text not null,
  acl jsonb not null,
  snapshot_id text not null,
  sandbox_id text not null,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
alter table public.golden_adoption_receipts enable row level security;
revoke all on public.golden_adoption_receipts from public, anon, authenticated;
grant all on public.golden_adoption_receipts to service_role;

create function public.adopt_canonical_boat_golden(
  caller_id uuid, target_id uuid, account_id text, snapshot_ref text, sandbox_ref text, confirmation uuid default null
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare g public.goldens%rowtype; receipt uuid; member_role public.member_role;
begin
  -- Same lock as create; golden row lock also serializes competing accounts.
  perform pg_advisory_xact_lock(hashtextextended('boat:' || account_id, 0));
  select * into g from public.goldens where id=target_id for update;
  if not found then raise exception 'Canonical adoption unavailable'; end if;
  select role into member_role from public.members where org_id=g.org_id and user_id=caller_id for share;
  if member_role is null or
     (g.visibility='private' and g.owner_id<>caller_id) or
     (g.visibility='org' and member_role<>'admin') or
     g.provider<>'boat' or
     g.provider_snapshot_id is distinct from snapshot_ref or
     g.provider_sandbox_id is distinct from sandbox_ref or
     snapshot_ref is null or sandbox_ref is null then
    raise exception 'Canonical adoption unavailable';
  end if;
  if exists(select 1 from public.golden_backend_slots where
    (provider='boat' and backend_id=account_id) or golden_id=target_id) then
    raise exception 'Canonical adoption unavailable';
  end if;
  if confirmation is null then
    insert into public.golden_adoption_receipts(user_id,golden_id,backend_id,acl,snapshot_id,sandbox_id)
      values(caller_id,target_id,account_id,jsonb_build_array(g.org_id,g.owner_id,g.visibility),snapshot_ref,sandbox_ref) returning id into receipt;
    return receipt;
  end if;
  delete from public.golden_adoption_receipts where id=confirmation and user_id=caller_id
    and golden_id=target_id and backend_id=account_id and acl=jsonb_build_array(g.org_id,g.owner_id,g.visibility) and snapshot_id=snapshot_ref
    and sandbox_id=sandbox_ref and expires_at>now() returning id into receipt;
  if receipt is null then raise exception 'Canonical adoption unavailable'; end if;
  insert into public.golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id)
    values('boat',account_id,1,g.org_id,g.owner_id,g.id);
  return receipt;
end;
$$;
revoke all on function public.adopt_canonical_boat_golden(uuid,uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.adopt_canonical_boat_golden(uuid,uuid,text,text,text,uuid) to service_role;
