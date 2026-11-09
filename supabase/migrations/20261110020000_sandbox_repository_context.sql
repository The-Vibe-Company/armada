-- Persisted agent guidance, not a process cwd or an access boundary. Old rows remain null.
alter table public.sandboxes add column repository_dir text;
comment on column public.sandboxes.repository_dir is
  'Immutable configured golden repo directory selected at launch. Agent guidance only; no cwd or confinement guarantee.';

create function public.sandboxes_repository_context_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.repository_dir is distinct from old.repository_dir then
      raise exception 'sandbox repository context is immutable' using errcode = '23514';
    end if;
  elsif new.repository_dir is not null then
    if new.repository_dir !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$' or not exists (
      select 1 from public.goldens g, jsonb_array_elements(g.config->'repos') r
      where g.id = new.golden_id and r->>'dir' = new.repository_dir
    ) then
      raise exception 'repository context must name a configured golden repository' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger sandboxes_repository_context_guard before insert or update on public.sandboxes
for each row execute function public.sandboxes_repository_context_guard();
revoke all on function public.sandboxes_repository_context_guard() from public, anon, authenticated;
