alter table public.agent_defaults add column credential_ids uuid[];

-- Shared accounts require explicit placement and cannot seed a personal pool.
update public.agent_defaults d
set credential_ids = array(
  select c.id from public.credentials c
  where c.id = d.credential_id and c.scope = 'user' and c.owner_id = d.user_id
);

alter table public.agent_defaults alter column credential_ids set not null;

-- The overlap writer sets credential_id. Ordered-pool writers own credential_ids
-- and should update it separately from the scalar if they need to set both.
create function public.sync_agent_default_account_order() returns trigger
language plpgsql set search_path = '' as $$
declare
  preferred uuid[];
begin
  if tg_op = 'INSERT' then
    if new.credential_ids is not null then
      return new;
    end if;
  elsif new.credential_id is not distinct from old.credential_id
     or new.credential_ids is distinct from old.credential_ids then
    return new;
  end if;

  preferred := array(
    select c.id from public.credentials c
    where c.id = new.credential_id and c.scope = 'user' and c.owner_id = new.user_id
  );
  if tg_op = 'INSERT' then
    new.credential_ids := preferred;
  else
    -- A replacement or an FK clear must preserve the other pool members.
    new.credential_ids := preferred ||
      array_remove(array_remove(old.credential_ids, old.credential_id), new.credential_id);
  end if;
  return new;
end
$$;

revoke all on function public.sync_agent_default_account_order() from public, anon, authenticated, service_role;

create trigger sync_agent_default_account_order
before insert or update of credential_id on public.agent_defaults
for each row execute function public.sync_agent_default_account_order();
