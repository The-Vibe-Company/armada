-- #2560: one timestamp per launch stage, per runtime activation (enrolment epoch).
-- Written only by the server (first write wins); readable by whoever can see the sandbox.
create table public.sandbox_launch_stages (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  epoch bigint not null check (epoch > 0),
  stage text not null check (
    stage in ('created', 'machine_started', 'bootstrap_started', 'enrolled', 'harness_ready', 'first_event')
  ),
  at timestamptz not null,
  primary key (sandbox_id, epoch, stage)
);

alter table public.sandbox_launch_stages enable row level security;
revoke all on public.sandbox_launch_stages from public, anon, authenticated;
grant all on public.sandbox_launch_stages to service_role;
grant select (sandbox_id, epoch, stage, at) on public.sandbox_launch_stages to authenticated;
-- Sandbox visibility is the access rule: the subquery runs under the caller's sandboxes policy.
create policy sandbox_launch_stages_visible on public.sandbox_launch_stages for select to authenticated using (
  exists (select 1 from public.sandboxes s where s.id = sandbox_launch_stages.sandbox_id)
);
