begin;

alter table public.jobs add constraint jobs_boat_runtime_extend_binding
  check (kind <> 'boat_runtime_extend'
    or (sandbox_id is not null and generation is not null and deadline_at is not null));

drop index public.jobs_one_lifecycle_lease;
create unique index jobs_one_lifecycle_lease
  on public.jobs (sandbox_id)
  where state = 'leased' and kind in ('launch', 'stop', 'resume', 'delete', 'boat_runtime_extend');

create or replace function public.claim_job(
  p_kind text, p_owner uuid, p_lease_seconds integer, p_concurrency integer
)
returns setof public.jobs
language plpgsql
set search_path = ''
as $$
declare
  candidate record;
  claimed public.jobs;
  lease_start timestamptz;
begin
  if p_owner is null or p_lease_seconds is null or p_lease_seconds <= 0
    or p_concurrency is null or p_concurrency <= 0 then
    raise exception 'invalid job claim parameters' using errcode = '22023';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('armada.jobs:' || p_kind, 0)) then
    return;
  end if;

  if (select count(*) from public.jobs
      where kind = p_kind and state = 'leased' and lease_until > clock_timestamp()) >= p_concurrency then
    return;
  end if;

  for candidate in
    select id, sandbox_id from public.jobs
    where kind = p_kind and run_after <= clock_timestamp()
      and (state = 'queued' or (state = 'leased' and lease_until <= clock_timestamp()))
    order by run_after, id
  loop
    if p_kind in ('launch', 'stop', 'resume', 'delete', 'boat_runtime_extend') then
      -- Admission and handoff use the same lock. Check the competing lease
      -- in a new statement after locking, including expired leases: only the
      -- existing leased row can be taken over.
      perform 1 from public.sandboxes where id = candidate.sandbox_id for update skip locked;
      if not found then
        continue;
      end if;
      perform 1 from public.jobs
        where sandbox_id = candidate.sandbox_id and id <> candidate.id
          and state = 'leased' and kind in ('launch', 'stop', 'resume', 'delete', 'boat_runtime_extend');
      if found then
        continue;
      end if;
    end if;

    perform 1 from public.jobs
      where id = candidate.id and kind = p_kind and run_after <= clock_timestamp()
        and (state = 'queued' or (state = 'leased' and lease_until <= clock_timestamp()))
      for update skip locked;
    if not found then
      continue;
    end if;

    lease_start := clock_timestamp();
    update public.jobs
      set state = 'leased', lease_owner = p_owner, lease_epoch = lease_epoch + 1,
        lease_until = case
          when kind = 'boat_runtime_extend' and deadline_at > lease_start
            then least(deadline_at, lease_start + make_interval(secs => p_lease_seconds))
          -- An elapsed deadline can be claimed for settlement. The store's
          -- deadline check still fences external dispatch.
          else lease_start + make_interval(secs => p_lease_seconds)
        end,
        attempts = attempts + 1
      where id = candidate.id returning * into claimed;
    return next claimed;
    return;
  end loop;
end;
$$;

create or replace function public.renew_job(
  p_id uuid, p_owner uuid, p_epoch bigint, p_generation bigint, p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  job_kind text;
  lease_start timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'invalid job lease duration' using errcode = '22023';
  end if;

  if p_generation is not null then
    perform 1 from public.sandboxes s join public.jobs j on j.sandbox_id = s.id
      where j.id = p_id and s.lifecycle_generation = p_generation
      for update of s;
    if not found then
      return false;
    end if;
  end if;

  select kind into job_kind from public.jobs where id = p_id for update;
  if not found then
    return false;
  end if;
  -- Until this transaction commits, a claim can see the pre-renewal
  -- expiry. Share the capacity lock so it cannot allocate that slot.
  -- Claim skips held row locks, so it cannot wait on either row above.
  perform pg_advisory_xact_lock(hashtextextended('armada.jobs:' || job_kind, 0));
  lease_start := clock_timestamp();
  update public.jobs set lease_until = case
      when job_kind = 'boat_runtime_extend' and deadline_at > lease_start
        then least(deadline_at, lease_start + make_interval(secs => p_lease_seconds))
      else lease_start + make_interval(secs => p_lease_seconds)
    end
    where id = p_id and state = 'leased' and lease_owner = p_owner
      and lease_epoch = p_epoch and generation is not distinct from p_generation
      and lease_until > lease_start;
  return found;
end;
$$;

commit;
