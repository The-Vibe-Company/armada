-- Additive metadata only: never resize active machines or infer historical capacity.
alter table public.goldens add column size_policy jsonb;
alter table public.sandboxes add column machine_size jsonb;
grant select (size_policy) on public.goldens to authenticated;
grant select (machine_size) on public.sandboxes to authenticated;
-- Writes remain server-only, with live org-admin/private-owner checks.
create function public.guard_machine_size_evidence() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.machine_size is distinct from old.machine_size then
    raise exception 'Launch machine size evidence is immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_machine_size_evidence() from public,anon,authenticated;
create trigger sandboxes_machine_size_immutable before update on public.sandboxes
for each row execute function public.guard_machine_size_evidence();
