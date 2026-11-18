create or replace function public.record_sandbox_launch_activation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'starting' and (tg_op = 'INSERT' or old.status is distinct from 'starting') then
    -- Only an inserted row is a launch (activation 1). Re-entering 'starting' is a resume: without history (a
    -- sandbox launched before this migration) it opens activation 2, so it stays a resume and no earlier
    -- activation's timestamps are invented.
    insert into public.sandbox_launch_stages (sandbox_id, activation, stage, at)
    select new.id,
           case when tg_op = 'INSERT' then 1 else greatest(coalesce(max(l.activation), 0), 1) + 1 end,
           'accepted', clock_timestamp()
      from public.sandbox_launch_stages l where l.sandbox_id = new.id;
  elsif tg_op = 'UPDATE' and old.status = 'starting' and new.status in ('ready', 'running')
    -- Native MCP setup can publish physical readiness while the admitted activity
    -- still owns the row. The launch or prompt adapter observes harness readiness.
    and not (new.status = 'ready' and new.activity_lease_id is not null
      and new.provider in ('boat', 'modal') and not new.boat_runtime and new.runtime_transport is null)
  then
    insert into public.sandbox_launch_stages (sandbox_id, activation, stage, at)
    select new.id, max(l.activation), 'harness_ready', clock_timestamp()
      from public.sandbox_launch_stages l where l.sandbox_id = new.id having max(l.activation) is not null
    on conflict (sandbox_id, activation, stage) do nothing;
  end if;
  return null;
end $$;
