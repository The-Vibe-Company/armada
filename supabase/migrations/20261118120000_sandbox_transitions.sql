-- Journal only the writers that opt in. Their existing UPDATE predicates remain
-- the authority and compare-and-set fences for both the status and its history.
create table public.sandbox_transitions (
  id bigint generated always as identity primary key,
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  from_status public.sandbox_status not null,
  to_status public.sandbox_status not null,
  actor text not null check (actor ~ '^[a-z][a-z0-9_]*$'),
  code text not null check (code ~ '^[a-z][a-z0-9_]*$'),
  generation bigint not null,
  at timestamptz not null default clock_timestamp(),
  check (from_status <> to_status)
);

create index sandbox_transitions_sandbox_id_id_idx on public.sandbox_transitions (sandbox_id, id desc);

alter table public.sandbox_transitions enable row level security;
revoke all on public.sandbox_transitions from public, anon, authenticated, service_role;
grant select on public.sandbox_transitions to authenticated, service_role;
create policy sandbox_transitions_owner_read on public.sandbox_transitions for select to authenticated using (
  exists (
    select 1 from public.sandboxes s
    where s.id = sandbox_transitions.sandbox_id and s.owner_id = auth.uid()
  )
);

-- A write-only input to the trigger. The check ensures no context is persisted
-- or carried into a later statement, even if a writer attempts to set it on INSERT.
alter table public.sandboxes add column transition_context jsonb check (transition_context is null);

create function public.transition_sandbox() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.sandbox_transitions (sandbox_id, from_status, to_status, actor, code, generation)
    values (
      new.id, old.status, new.status,
      new.transition_context->>'actor', new.transition_context->>'code', new.lifecycle_generation
    );
  end if;
  new.transition_context := null;
  return new;
end
$$;
revoke all on function public.transition_sandbox() from public, anon, authenticated, service_role;

create trigger sandbox_transition before update of transition_context on public.sandboxes
  for each row when (new.transition_context is not null) execute function public.transition_sandbox();
