-- Deploy before template dispatch can enter allocating without a golden fence.
-- Admission must serialize the allocating transition with this RPC's golden row lock.
create or replace function public.remove_golden(target uuid) returns timestamptz
language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.goldens%rowtype; member_role public.member_role;
begin
  select * into g from public.goldens where id=target for update;
  if not found or (g.visibility='private' and g.owner_id<>auth.uid()) then
    raise exception 'No such golden' using errcode='P0002';
  end if;
  select role into member_role from public.members where org_id=g.org_id and user_id=auth.uid() for share;
  if not found then raise exception 'No such golden' using errcode='P0002'; end if;
  if g.visibility='org' and member_role<>'admin' then
    raise exception 'Only an org admin can remove this golden' using errcode='42501';
  end if;
  if g.removed_at is not null then return g.removed_at; end if;
  if exists(select 1 from public.golden_operation_fences where golden_id=target)
    or exists(
      select 1 from public.template_launch_requests r
      where r.org_id=g.org_id and r.manifest#>>'{golden,id}'=target::text
        and r.manifest#>>'{golden,provider}'=g.provider::text
        and r.golden_operation_fence_id is null and r.state in ('allocating','reconciling')
        and not exists(
          select 1 from public.sandboxes s
          where s.id=r.sandbox_id and s.org_id=r.org_id and s.golden_id=target and s.provider=g.provider
        )
    )
    or exists(select 1 from public.golden_backend_slots where golden_id=target and build_id is not null)
    or exists(select 1 from public.golden_build_jobs where org_id=g.org_id and name=g.name
      and provider=g.provider and state in ('queued','running','recovery_required')) then
    raise exception 'Golden has unresolved operations' using errcode='23514';
  end if;
  update public.goldens set removed_at=clock_timestamp() where id=target returning removed_at into g.removed_at;
  return g.removed_at;
end $$;
