-- Service-owned publication provenance and retry outbox. No TTL proves a delete or fork settled.
alter table public.golden_operation_fences add column expected_snapshot_id text;
alter table public.golden_operation_fences add column expected_sandbox_id text;
alter table public.golden_build_jobs add column expected_snapshot_id text;

create table public.golden_snapshot_publications (
 id uuid primary key default gen_random_uuid(), golden_id uuid not null references public.goldens(id),
 provider text not null check(provider in ('boat','modal')), backend_id text not null,
 proven boolean not null default false, snapshot text not null, source_id text, artifact_id text, authority jsonb,
 target jsonb not null, manager_id uuid not null references auth.users(id),
 job_id uuid references public.golden_build_jobs(id), created_at timestamptz not null default now(),
 unique(provider,backend_id,snapshot)
);
create table public.golden_snapshot_retirements (
 id uuid primary key default gen_random_uuid(), golden_id uuid not null references public.goldens(id),
 provider text not null check(provider in ('boat','modal')), backend_id text not null,
 old_snapshot text not null, new_snapshot text not null check(old_snapshot<>new_snapshot),
 publication_id uuid not null references public.golden_snapshot_publications(id),
 replacement_id uuid not null references public.golden_snapshot_publications(id),
 state text not null default 'pending' check(state in ('pending','deferred','uncertain','retired')),
 sealed boolean not null default false, delete_started boolean not null default false,
 claim_id uuid, claim_until timestamptz, attempts integer not null default 0,
 review_receipt text check(review_receipt is null or review_receipt ~ '^[a-f0-9]{64}$'), reviewed_by uuid references auth.users(id),
 reason text, next_attempt_at timestamptz not null default now(), created_at timestamptz not null default now(),
 unique(provider,backend_id,old_snapshot)
);
alter table public.golden_snapshot_publications enable row level security;
alter table public.golden_snapshot_retirements enable row level security;
revoke all on public.golden_snapshot_publications,public.golden_snapshot_retirements from public,anon,authenticated;
grant all on public.golden_snapshot_publications,public.golden_snapshot_retirements to service_role;

-- Global provider/handle locking is deliberately conservative across accounts: hidden references
-- may protect a candidate, but never leak their identity or let a handle reappear during deletion.
create function public.lock_golden_snapshot(provider_name text, saved_handle text) returns void
language sql set search_path=public,pg_temp as $$
 select pg_advisory_xact_lock(hashtextextended(provider_name || ':saved:' || coalesce(saved_handle,''),0));
$$;
revoke all on function public.lock_golden_snapshot(text,text) from public,anon,authenticated;
grant execute on function public.lock_golden_snapshot(text,text) to service_role;

create function public.guard_retired_golden_snapshot() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
begin
 if new.provider_snapshot_id is not null then
  perform public.lock_golden_snapshot(new.provider::text,new.provider_snapshot_id);
  if exists(select 1 from public.golden_snapshot_retirements r
    where r.provider=new.provider::text and r.old_snapshot=new.provider_snapshot_id and r.sealed) then
   raise exception 'Saved revision unavailable' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
revoke all on function public.guard_retired_golden_snapshot() from public,anon,authenticated;
create trigger guard_retired_golden_snapshot before insert or update of provider_snapshot_id,boat_snapshot_id on public.goldens
for each row execute function public.guard_retired_golden_snapshot();

create function public.guard_golden_revision_admission() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
declare g public.goldens%rowtype;
begin
 select * into g from public.goldens where id=new.golden_id for update;
 if not found or g.removed_at is not null or g.provider_snapshot_id is distinct from new.expected_snapshot_id
   or g.provider_sandbox_id is distinct from new.expected_sandbox_id then
  raise exception 'Golden revision changed' using errcode='23514';
 end if;
 perform public.lock_golden_snapshot(g.provider::text,g.provider_snapshot_id);
 if exists(select 1 from public.golden_snapshot_retirements r
   where r.provider=g.provider::text and r.old_snapshot=g.provider_snapshot_id and r.sealed) then
  raise exception 'Saved revision unavailable' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function public.guard_golden_revision_admission() from public,anon,authenticated;
create trigger golden_revision_admission before insert on public.golden_operation_fences
for each row execute function public.guard_golden_revision_admission();

create index golden_retirement_retry on public.golden_snapshot_retirements(next_attempt_at,id) where state<>'retired';
create index golden_publication_history on public.golden_build_jobs(golden_id,provider,snapshot) where state='succeeded';

-- Published provenance and permanent collection barriers cannot be rewritten by later service code.
create function public.guard_golden_publication_proof() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'Publication namespace cannot be erased' using errcode='23514'; end if;
 if (old.id,old.golden_id,old.provider,old.backend_id,old.snapshot,old.target) is distinct from
    (new.id,new.golden_id,new.provider,new.backend_id,new.snapshot,new.target)
    or (old.proven and new is distinct from old)
    or (old.authority is not null and old.authority<>'null'::jsonb and new.authority is distinct from old.authority) then
   raise exception 'Publication provenance is immutable' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function public.guard_golden_publication_proof() from public,anon,authenticated;
create trigger golden_publication_proof before update or delete on public.golden_snapshot_publications
for each row execute function public.guard_golden_publication_proof();
create function public.guard_golden_retirement_barrier() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'Retirement barrier cannot be erased' using errcode='23514'; end if;
 if (old.golden_id,old.provider,old.backend_id,old.old_snapshot,old.new_snapshot,old.publication_id,old.replacement_id)
    is distinct from (new.golden_id,new.provider,new.backend_id,new.old_snapshot,new.new_snapshot,new.publication_id,new.replacement_id)
    or (old.sealed and not new.sealed) or (old.state='retired' and new.state<>'retired')
    or (old.review_receipt is not null and (new.review_receipt,new.reviewed_by) is distinct from (old.review_receipt,old.reviewed_by)) then
   raise exception 'Retirement identity and barrier are immutable' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function public.guard_golden_retirement_barrier() from public,anon,authenticated;
create trigger golden_retirement_barrier before update or delete on public.golden_snapshot_retirements
for each row execute function public.guard_golden_retirement_barrier();
