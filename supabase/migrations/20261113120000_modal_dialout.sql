-- Temporary immutable opt-in until Modal common-transport parity and cutover.
alter table public.sandboxes add column runtime_transport text,
  add constraint sandboxes_runtime_transport_target check (
    runtime_transport is null or (runtime_transport='dialout' and provider='modal' and harness='codex' and not boat_runtime)
  );
create function public.guard_sandbox_runtime_transport() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.runtime_transport is distinct from old.runtime_transport then
    raise exception 'Sandbox runtime transport is immutable';
  end if;
  return new;
end;
$$;
create trigger sandbox_runtime_transport_immutable before update of runtime_transport
  on public.sandboxes for each row execute function public.guard_sandbox_runtime_transport();
grant select(runtime_transport) on public.sandboxes to authenticated;
revoke all on function public.guard_sandbox_runtime_transport() from public,anon,authenticated;
