-- Keep receipt admission and job admission in one transaction across server revisions.
begin;
lock table public.golden_build_jobs in share row exclusive mode;

create function public.enqueue_golden_build_job() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.jobs (id, kind, idem_key, org_id, run_after, max_attempts)
  values (new.id, 'golden_build',
    format('["internal","%s","golden_build",null,null,"%s"]', new.org_id, new.id),
    new.org_id, new.created_at, 1);
  return new;
end;
$$;
revoke all on function public.enqueue_golden_build_job() from public, anon, authenticated;

create trigger golden_build_job_on_admission
  after insert on public.golden_build_jobs
  for each row execute function public.enqueue_golden_build_job();

insert into public.jobs (id, kind, idem_key, org_id, run_after, max_attempts)
select id, 'golden_build',
  format('["internal","%s","golden_build",null,null,"%s"]', org_id, id),
  org_id, created_at, 1
from public.golden_build_jobs
where state in ('queued', 'running', 'recovery_required')
on conflict (idem_key) do nothing;

commit;
