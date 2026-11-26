begin;

set local lock_timeout = '2s';
set local statement_timeout = '5s';

create or replace function public.claim_next_job(
  p_kinds text[], p_limits integer[], p_owner uuid, p_lease_seconds integer
)
returns setof public.jobs
language plpgsql
set search_path = ''
as $$
declare
  idx integer;
  v_kind text;
  v_limit integer;
  candidate record;
  claimed public.jobs;
  lease_start timestamptz;
begin
  if p_owner is null
    or p_lease_seconds is null or p_lease_seconds <= 0
    or p_kinds is null or p_limits is null
    or cardinality(p_kinds) <> cardinality(p_limits) then
    raise exception 'invalid job claim parameters' using errcode = '22023';
  end if;

  if cardinality(p_kinds) = 0 then
    return;
  end if;

  if array_ndims(p_kinds) <> 1 or array_ndims(p_limits) <> 1
    or array_lower(p_kinds, 1) <> 1 or array_lower(p_limits, 1) <> 1 then
    raise exception 'invalid job claim parameters' using errcode = '22023';
  end if;

  for idx in 1 .. cardinality(p_kinds) loop
    if p_kinds[idx] is null or p_kinds[idx] = ''
      or p_limits[idx] is null or p_limits[idx] <= 0 then
      raise exception 'invalid job claim parameters' using errcode = '22023';
    end if;
  end loop;

  for idx in 1 .. cardinality(p_kinds) loop
    v_kind := p_kinds[idx];
    v_limit := p_limits[idx];

    if not exists (
      select 1 from public.jobs
      where kind = v_kind and run_after <= clock_timestamp()
        and (state = 'queued' or (state = 'leased' and lease_until <= clock_timestamp()))
    ) then
      continue;
    end if;

    if not pg_try_advisory_xact_lock(hashtextextended('armada.jobs:' || v_kind, 0)) then
      continue;
    end if;

    if (select count(*) from public.jobs
        where kind = v_kind and state = 'leased' and lease_until > clock_timestamp()) >= v_limit then
      continue;
    end if;

    for candidate in
      select id, sandbox_id from public.jobs
      where kind = v_kind and run_after <= clock_timestamp()
        and (state = 'queued' or (state = 'leased' and lease_until <= clock_timestamp()))
      order by run_after, id
    loop
      if v_kind in ('launch', 'stop', 'resume', 'delete', 'boat_runtime_extend') then
        -- Admission and handoff use the same lock. Check the competing lease
        -- in a new statement after locking, including expired leases: only the
        -- existing leased row can be taken over.
        perform 1 from public.sandboxes where id = candidate.sandbox_id for update skip locked;
        if not found then
          continue;
        end if;
        -- Read legacy ownership after taking the sandbox lock. The candidate
        -- scan can predate an activity or reconcile claim on this sandbox.
        if v_kind = 'boat_runtime_extend' then
          perform 1 from public.sandboxes
            where id = candidate.sandbox_id
              and (activity_until > clock_timestamp() or reconcile_lease_until > clock_timestamp());
          if found then
            continue;
          end if;
        end if;
        perform 1 from public.jobs
          where sandbox_id = candidate.sandbox_id and id <> candidate.id
            and state = 'leased' and kind in ('launch', 'stop', 'resume', 'delete', 'boat_runtime_extend');
        if found then
          continue;
        end if;
      end if;

      perform 1 from public.jobs
        where id = candidate.id and kind = v_kind and run_after <= clock_timestamp()
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
  end loop;
end;
$$;

revoke all on function
  public.claim_next_job(text[], integer[], uuid, integer)
  from public, anon, authenticated;
grant execute on function
  public.claim_next_job(text[], integer[], uuid, integer)
  to service_role;

commit;
