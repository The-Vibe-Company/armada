-- Additive rollout: existing v1 clients remain readable; canonical new writes use cron/timezone.
alter table public.routines add column cron text;
alter table public.routines add column timezone text not null default 'UTC';
alter table public.routines alter column interval_hours drop not null;
alter table public.routines add constraint routines_cron_shape check (
 cron is null or (length(cron) between 9 and 200 and array_length(regexp_split_to_array(btrim(cron),'\s+'),1)=5)
);
alter table public.routines add constraint routines_timezone_shape check(length(timezone) between 1 and 100);
alter table public.routines add constraint routines_schedule_present check(cron is not null or interval_hours is not null);
alter table public.routines add constraint routines_legacy_timezone check(cron is not null or timezone='UTC');

-- Minute precision can delay the inherited phase by <60 seconds, never advance it.
-- Uniform sub-day divisors and weekly intervals have exact calendar equivalents.
-- Arbitrary elapsed periods (e.g.7/25/48h) do not: retain their exact UTC v1 timing
-- until the owner explicitly supplies a cron. Never silently approximate or pause them.
with anchors as (
 select id,interval_hours,
   date_trunc('minute',coalesce(next_due_at,created_at+interval_hours*interval '1 hour'))+
   case when coalesce(next_due_at,created_at+interval_hours*interval '1 hour')=
     date_trunc('minute',coalesce(next_due_at,created_at+interval_hours*interval '1 hour'))
    then interval '0' else interval '1 minute' end as anchor
 from public.routines where mod(24,interval_hours)=0 or interval_hours=168
), schedules as (
 select id,anchor,
  extract(minute from anchor at time zone 'UTC')::integer::text||' '||
  case when interval_hours=168 then extract(hour from anchor at time zone 'UTC')::integer::text||' * * '||extract(dow from anchor at time zone 'UTC')::integer::text
   when interval_hours=1 then '* * * *'
   when interval_hours=24 then extract(hour from anchor at time zone 'UTC')::integer::text||' * * *'
   else mod(extract(hour from anchor at time zone 'UTC')::integer,interval_hours)::text||'-23/'||interval_hours::text||' * * *' end as expression
 from anchors
)
update public.routines r set cron=s.expression,
 next_due_at=case when r.status='enabled' then s.anchor else null end,
 version=r.version+1,updated_at=now() from schedules s where r.id=s.id;

alter table public.routine_runs add column missed_count_capped boolean not null default false;
alter table public.routine_runs drop constraint routine_runs_reason_check;
alter table public.routine_runs add constraint routine_runs_reason_check check(reason in (
 'previous_run_alive','previous_run_uncertain','daily_limit_reached','owner_authorization_changed',
 'launch_failed','launch_uncertain','schedule_unavailable'
));
-- Table-level SELECT already grants access to new readable routine columns. Run history
-- has explicit column grants: expose only the non-secret aggregate saturation marker.
grant select(missed_count_capped) on public.routine_runs to authenticated;
