begin;

set local lock_timeout = '2s';
set local statement_timeout = '5s';

create function public.guard_boat_legacy_lease() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  checked_at timestamptz := clock_timestamp();
begin
  if ((new.activity_until > checked_at
        and (new.activity_lease_id is distinct from old.activity_lease_id
          or old.activity_until is null or new.activity_until > old.activity_until))
      or (new.reconcile_lease_until > checked_at
        and (new.reconcile_lease is distinct from old.reconcile_lease
          or old.reconcile_lease_until is null or new.reconcile_lease_until > old.reconcile_lease_until)))
    -- UPDATE holds the sandbox row lock shared with claim_job. A volatile
    -- function reads the job after that lock even if the UPDATE snapshot is older.
    and exists (
      select 1 from public.jobs
      where sandbox_id = old.id and kind = 'boat_runtime_extend'
        and state = 'leased' and lease_until > checked_at
    )
  then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_boat_legacy_lease() from public, anon, authenticated, service_role;

-- Run before sandbox_transition so a refused claim cannot append to the journal.
create trigger boat_legacy_lease_guard
before update of activity_lease_id, activity_until, reconcile_lease, reconcile_lease_until on public.sandboxes
for each row when (old.provider = 'boat' and old.boat_runtime)
execute function public.guard_boat_legacy_lease();

commit;
