-- #2560: one timestamp per launch stage, per activation (a launch or a resume) of a sandbox.
-- Activation 1 is the launch; each later transition into 'starting' opens the next one (a resume).
-- This is provider-neutral: native Boat/Modal, runtime Boat/Modal and Docker all move a sandbox
-- through 'starting'. Written only by the server; a stage keeps its earliest timestamp.
create table public.sandbox_launch_stages (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  activation bigint not null check (activation > 0),
  stage text not null check (
    stage in (
      'accepted', 'provider_claimed', 'machine_started', 'checkout_done',
      'bootstrap_started', 'enrolled', 'harness_ready', 'first_token'
    )
  ),
  at timestamptz not null,
  primary key (sandbox_id, activation, stage)
);

alter table public.sandbox_launch_stages enable row level security;
revoke all on public.sandbox_launch_stages from public, anon, authenticated;
grant all on public.sandbox_launch_stages to service_role;
grant select (sandbox_id, activation, stage, at) on public.sandbox_launch_stages to authenticated;
-- Sandbox visibility is the access rule: the subquery runs under the caller's sandboxes policy.
create policy sandbox_launch_stages_visible on public.sandbox_launch_stages for select to authenticated using (
  exists (select 1 from public.sandboxes s where s.id = sandbox_launch_stages.sandbox_id)
);

-- The activation boundaries every path shares, recorded where the status changes:
-- entering 'starting' accepts a launch or resume (the server lowers a launch's time to the
-- request when it inserts the row after the provider allocation); leaving 'starting' for
-- 'ready'/'running' is the latest possible harness-ready time (an earlier precise report wins).
create function public.record_sandbox_launch_activation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'starting' and (tg_op = 'INSERT' or old.status is distinct from 'starting') then
    insert into public.sandbox_launch_stages (sandbox_id, activation, stage, at)
    select new.id, coalesce(max(l.activation), 0) + 1, 'accepted', clock_timestamp()
      from public.sandbox_launch_stages l where l.sandbox_id = new.id;
  elsif tg_op = 'UPDATE' and old.status = 'starting' and new.status in ('ready', 'running') then
    insert into public.sandbox_launch_stages (sandbox_id, activation, stage, at)
    select new.id, max(l.activation), 'harness_ready', clock_timestamp()
      from public.sandbox_launch_stages l where l.sandbox_id = new.id having max(l.activation) is not null
    on conflict (sandbox_id, activation, stage) do nothing;
  end if;
  return null;
end $$;
revoke all on function public.record_sandbox_launch_activation() from public, anon, authenticated;

create trigger sandboxes_launch_activation after insert or update of status on public.sandboxes
  for each row execute function public.record_sandbox_launch_activation();
