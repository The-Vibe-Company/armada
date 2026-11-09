-- Provider-neutral durable jobs. Existing Boat admissions keep their mandatory capacity reservation.
alter table public.golden_build_jobs
  add column provider public.sandbox_provider not null default 'boat',
  alter column reservation_id drop not null;
alter table public.golden_build_jobs add constraint golden_build_jobs_boat_reservation
  check (provider <> 'boat' or reservation_id is not null);
comment on column public.golden_build_jobs.provider is
  'Immutable provider routing. Pinned Modal App metadata is sealed in payload_enc; management credentials are never persisted here.';

create function public.guard_golden_build_provider() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.provider is distinct from old.provider or new.reservation_id is distinct from old.reservation_id then
    raise exception 'Golden build provider and reservation are immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_golden_build_provider() from public,anon,authenticated;
create trigger guard_golden_build_provider before update on public.golden_build_jobs
for each row execute function public.guard_golden_build_provider();
-- The existing table RLS/revoked user grants remain unchanged; service_role already holds table privileges.
