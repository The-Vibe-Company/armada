-- Hand the retirement backlog to the shared runner. Existing claims may finish
-- during deploy overlap. Prevent new claims, including a claim already selected
-- by an old worker that has yet to update the row.
-- Drain transactions that already selected a retirement FOR UPDATE before
-- installing triggers and updating the backlog under the same lock.
lock table public.golden_snapshot_retirements in exclusive mode;

create function public.handoff_snapshot_retirement() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.claim_id is not null and new.claim_id is distinct from old.claim_id then
    raise exception 'Snapshot retirement claims moved to jobs';
  end if;
  new.next_attempt_at := 'infinity';
  return new;
end;
$$;

create function public.enqueue_snapshot_retirement_job() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.jobs (id, kind, idem_key, org_id, max_attempts)
  select new.id, 'snapshot_retirement', 'snapshot_retirement:' || new.id, g.org_id, 2147483647
  from public.goldens g where g.id = new.golden_id;
  return new;
end;
$$;

revoke all on function public.handoff_snapshot_retirement(), public.enqueue_snapshot_retirement_job()
from public, anon, authenticated;

-- Installing the triggers takes a table lock, so no publication can fall between
-- backfill and trigger installation.
create trigger snapshot_retirement_handoff
before insert or update on public.golden_snapshot_retirements
for each row execute function public.handoff_snapshot_retirement();

create trigger snapshot_retirement_enqueue
after insert on public.golden_snapshot_retirements
for each row execute function public.enqueue_snapshot_retirement_job();

insert into public.jobs (id, kind, idem_key, org_id, max_attempts, run_after)
select r.id, 'snapshot_retirement', 'snapshot_retirement:' || r.id, g.org_id, 2147483647,
       greatest(r.next_attempt_at, r.claim_until)
from public.golden_snapshot_retirements r join public.goldens g on g.id = r.golden_id
where r.state <> 'retired';

update public.golden_snapshot_retirements set next_attempt_at = 'infinity'
where state <> 'retired';
