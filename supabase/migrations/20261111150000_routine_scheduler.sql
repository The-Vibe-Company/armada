-- Durable occurrences. Snapshotted inputs are not exposed through user JWTs.
alter table public.routines drop constraint routines_status_check;
alter table public.routines add constraint routines_status_check check(status in ('enabled','paused','deleted'));
alter table public.routines add column next_due_at timestamptz;
alter table public.routines add column consecutive_failures integer not null default 0 check(consecutive_failures>=0);
alter table public.routines add column pause_reason text;
create index routines_due on public.routines(next_due_at) where status='enabled';
create table public.routine_runs (
 id uuid primary key default gen_random_uuid(),
 routine_id uuid not null references public.routines(id),
 org_id uuid not null references public.orgs(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 scheduled_due_at timestamptz not null,
 configuration_version integer not null,
 state text not null check(state in ('admitted','succeeded','failed','reconciling','skipped')),
 reason text check(reason in ('previous_run_alive','previous_run_uncertain','daily_limit_reached','owner_authorization_changed','launch_failed','launch_uncertain')),
 request_key text not null unique,
 template_request_id uuid,
 prompt_id text, conversation_id text,
 task_state text check(task_state in ('running','finished','failed','interrupted','unknown')),
 task_checked_at timestamptz, task_check_id uuid,
 sandbox_id uuid,
 missed_intervals integer not null default 0 check(missed_intervals>=0),
 lease_id uuid, lease_until timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(routine_id,scheduled_due_at)
);
create index routine_runs_history on public.routine_runs(routine_id,created_at desc);
create index routine_runs_recovery on public.routine_runs(lease_until) where state in ('admitted','reconciling');
create index routine_runs_task_observation on public.routine_runs(task_checked_at) where state='succeeded' and task_state in ('running','unknown');
create table public.routine_run_inputs (
 run_id uuid primary key references public.routine_runs(id),
 template_id uuid not null,template_revision integer not null,prompt text not null,ttl_seconds integer not null
);
alter table public.routine_runs enable row level security;
alter table public.routine_run_inputs enable row level security;
create policy routine_runs_read on public.routine_runs for select to authenticated using (
 exists(select 1 from public.routines r where r.id=routine_id)
);
revoke all on public.routine_runs,public.routine_run_inputs from public,anon,authenticated;
-- Sandbox links require a separate current sandbox visibility check in the control API.
grant select(id,routine_id,org_id,owner_id,scheduled_due_at,configuration_version,state,reason,request_key,template_request_id,task_state,task_checked_at,missed_intervals,created_at,updated_at) on public.routine_runs to authenticated;
grant all on public.routine_runs,public.routine_run_inputs to service_role;
