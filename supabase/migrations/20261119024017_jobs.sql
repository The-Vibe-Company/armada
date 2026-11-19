-- Service-owned queue for the machine contract. IDs also identify durable
-- launch receipts, which survive retirement of sandbox and caller metadata.
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  sandbox_id uuid,
  org_id uuid not null,
  generation bigint check (generation > 0),
  idem_key text not null unique,
  request_owner_id uuid,
  request_digest text,
  state text not null default 'queued' check (state in ('queued', 'leased', 'done', 'failed')),
  run_after timestamptz not null default now(),
  deadline_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts > 0),
  lease_owner uuid,
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  lease_until timestamptz,
  payload_enc bytea,
  outcome jsonb,
  created_at timestamptz not null default now(),
  check ((state = 'leased') = (lease_owner is not null)),
  check ((state = 'leased') = (lease_until is not null)),
  check (generation is null or sandbox_id is not null),
  check (kind not in ('launch', 'stop', 'resume', 'delete')
    or (sandbox_id is not null and generation is not null and deadline_at is not null)),
  check (kind <> 'launch' or (request_owner_id is not null and request_digest is not null))
);

create unique index jobs_one_lifecycle_lease
  on public.jobs (sandbox_id)
  where state = 'leased' and kind in ('launch', 'stop', 'resume', 'delete');

create index jobs_claim_due on public.jobs (kind, run_after, id)
  where state in ('queued', 'leased');

create index jobs_kind_capacity on public.jobs (kind, lease_until)
  where state = 'leased';

alter table public.jobs enable row level security;
revoke all on public.jobs from public, anon, authenticated;
grant select, insert, update, delete on public.jobs to service_role;

-- The scheduler calls once per registered kind with its configured ceiling.
-- Attempts and deadlines bound dispatch in the runner. Even after either
-- bound is exhausted, a successor must be able to claim for reconciliation.
create function public.claim_job(
  p_kind text, p_owner uuid, p_lease_seconds integer, p_concurrency integer
)
returns setof public.jobs
language plpgsql
set search_path = ''
as $$
declare
  candidate record;
  claimed public.jobs;
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
    if p_kind in ('launch', 'stop', 'resume', 'delete') then
      -- Admission and handoff use the same lock. Check the competing lease
      -- in a new statement after locking, including expired leases: only the
      -- existing leased row can be taken over.
      perform 1 from public.sandboxes where id = candidate.sandbox_id for update skip locked;
      if not found then
        continue;
      end if;
      perform 1 from public.jobs
        where sandbox_id = candidate.sandbox_id and id <> candidate.id
          and state = 'leased' and kind in ('launch', 'stop', 'resume', 'delete');
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

    update public.jobs
      set state = 'leased', lease_owner = p_owner, lease_epoch = lease_epoch + 1,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempts = attempts + 1
      where id = candidate.id returning * into claimed;
    return next claimed;
    return;
  end loop;
end;
$$;

create function public.renew_job(
  p_id uuid, p_owner uuid, p_epoch bigint, p_generation bigint, p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = ''
as $$
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

  perform 1 from public.jobs where id = p_id for update;
  update public.jobs set lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = p_id and state = 'leased' and lease_owner = p_owner
      and lease_epoch = p_epoch and generation is not distinct from p_generation
      and lease_until > clock_timestamp();
  return found;
end;
$$;

-- Finish a lease with done/fail, or release it back to the queue with retry.
-- Call in the same transaction as fenced lifecycle writes or cleanup handoff.
create function public.complete_job(
  p_id uuid, p_owner uuid, p_epoch bigint, p_generation bigint,
  p_state text, p_outcome jsonb, p_run_after timestamptz default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_state is null or p_state not in ('queued', 'done', 'failed')
    or (p_state = 'queued') <> (p_run_after is not null) then
    raise exception 'invalid job completion parameters' using errcode = '22023';
  end if;

  if p_generation is not null then
    perform 1 from public.sandboxes s join public.jobs j on j.sandbox_id = s.id
      where j.id = p_id and s.lifecycle_generation = p_generation
      for update of s;
    if not found then
      return false;
    end if;
  end if;

  perform 1 from public.jobs where id = p_id for update;
  update public.jobs
    set state = p_state, outcome = p_outcome, run_after = coalesce(p_run_after, run_after),
      lease_owner = null, lease_until = null
    where id = p_id and state = 'leased' and lease_owner = p_owner
      and lease_epoch = p_epoch and generation is not distinct from p_generation
      and lease_until > clock_timestamp();
  return found;
end;
$$;

revoke all on function
  public.claim_job(text, uuid, integer, integer),
  public.renew_job(uuid, uuid, bigint, bigint, integer),
  public.complete_job(uuid, uuid, bigint, bigint, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.claim_job(text, uuid, integer, integer),
  public.renew_job(uuid, uuid, bigint, bigint, integer),
  public.complete_job(uuid, uuid, bigint, bigint, text, jsonb, timestamptz)
  to service_role;
