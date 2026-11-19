-- Drain row-locking transactions before the FK backfill. Otherwise an older
-- collector can hold a row lock while waiting for its UPDATE's table lock.
lock table public.sandboxes in exclusive mode;

create table public.sandbox_output_state (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  upload_scan timestamptz,
  published_scan timestamptz,
  retained_generation bigint
);

alter table public.sandbox_output_state enable row level security;
revoke all on public.sandbox_output_state from public, anon, authenticated;
grant all on public.sandbox_output_state to service_role;

-- Database deploy overlap. Both writers lock the sandbox first. Remove these
-- triggers and functions with the old sandbox columns after the code cutover.
create function public.sync_sandbox_output_state() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' and new.outputs_checked_at is null and new.outputs_published_scan is null
      and new.outputs_retained_generation is null then
    return new;
  end if;

  -- A write mirrored from the new table is already current.
  if exists (select 1 from public.sandbox_output_state
    where sandbox_id=new.id and (upload_scan, published_scan, retained_generation)
      is not distinct from (new.outputs_checked_at, new.outputs_published_scan, new.outputs_retained_generation)) then
    return new;
  end if;

  insert into public.sandbox_output_state (sandbox_id, upload_scan, published_scan, retained_generation)
    values (new.id, new.outputs_checked_at, new.outputs_published_scan, new.outputs_retained_generation)
    on conflict (sandbox_id) do update set
      upload_scan=excluded.upload_scan,
      published_scan=excluded.published_scan,
      retained_generation=excluded.retained_generation;
  return new;
end;
$$;
revoke all on function public.sync_sandbox_output_state() from public, anon, authenticated;
create trigger sync_sandbox_output_state
  after insert or update of outputs_checked_at, outputs_published_scan, outputs_retained_generation
  on public.sandboxes for each row execute function public.sync_sandbox_output_state();

insert into public.sandbox_output_state (sandbox_id, upload_scan, published_scan, retained_generation)
select id, outputs_checked_at, outputs_published_scan, outputs_retained_generation from public.sandboxes
where outputs_checked_at is not null or outputs_published_scan is not null or outputs_retained_generation is not null;

create function public.sync_legacy_sandbox_output_state() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.sandboxes set outputs_checked_at=new.upload_scan,
    outputs_published_scan=new.published_scan, outputs_retained_generation=new.retained_generation
  where id=new.sandbox_id and (outputs_checked_at, outputs_published_scan, outputs_retained_generation)
    is distinct from (new.upload_scan, new.published_scan, new.retained_generation);
  return new;
end;
$$;
revoke all on function public.sync_legacy_sandbox_output_state() from public, anon, authenticated;
create trigger sync_legacy_sandbox_output_state
  after insert or update on public.sandbox_output_state
  for each row execute function public.sync_legacy_sandbox_output_state();
