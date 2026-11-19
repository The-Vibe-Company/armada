begin;

-- Publication and approved reconciliation already insert the retirement
-- intent in their own transaction.
create function public.enqueue_snapshot_retirement_job() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.jobs (id, kind, idem_key, org_id, max_attempts)
  select new.id, 'snapshot_retirement', 'snapshot_retirement:' || new.id, g.org_id, 2147483647
  from public.goldens g where g.id = new.golden_id;
  return new;
end;
$$;

-- Called under the golden and shared job locks. Both old selection queries
-- check claim_until. Infinity marks retired scheduler ownership, not a lease.
-- Clearing claim_id also fences out a late legacy completion.
create function public.adopt_snapshot_retirement(p_id uuid) returns boolean
language plpgsql set search_path = '' as $$
begin
  update public.golden_snapshot_retirements
  set claim_id = null, claim_until = 'infinity', next_attempt_at = 'infinity'
  where id = p_id and state <> 'retired'
    and (claim_until is null or claim_until <= clock_timestamp())
    and next_attempt_at <= clock_timestamp();
  return found or exists (
    select 1 from public.golden_snapshot_retirements
    where id = p_id and claim_until = 'infinity'
  );
end;
$$;

revoke all on function public.enqueue_snapshot_retirement_job(), public.adopt_snapshot_retirement(uuid)
from public, anon, authenticated;
grant execute on function public.adopt_snapshot_retirement(uuid) to service_role;

create trigger snapshot_retirement_enqueue
after insert on public.golden_snapshot_retirements
for each row execute function public.enqueue_snapshot_retirement_job();

insert into public.jobs (id, kind, idem_key, org_id, max_attempts, run_after)
select r.id, 'snapshot_retirement', 'snapshot_retirement:' || r.id, g.org_id, 2147483647,
       greatest(r.next_attempt_at, r.claim_until)
from public.golden_snapshot_retirements r join public.goldens g on g.id = r.golden_id
where r.state <> 'retired';

commit;
