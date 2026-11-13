-- Per-launch routing decision, not proof that bootstrap or a prompt succeeded.
-- Existing Boat native sessions and Modal behavior remain unchanged.
alter table public.sandboxes
  add column boat_runtime boolean not null default false,
  add constraint sandboxes_boat_runtime_target check (
    not boat_runtime or (provider = 'boat' and harness = 'codex')
  );

create function public.guard_sandbox_boat_runtime() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.boat_runtime is distinct from old.boat_runtime then
    raise exception 'Sandbox runtime selection is immutable';
  end if;
  return new;
end;
$$;
create trigger sandbox_boat_runtime_immutable
before update of boat_runtime on public.sandboxes
for each row execute function public.guard_sandbox_boat_runtime();

-- Safe metadata only; no user-JWT insert/update grant for routing authority.
grant select (boat_runtime) on public.sandboxes to authenticated;
revoke all on function public.guard_sandbox_boat_runtime() from public, anon, authenticated;
