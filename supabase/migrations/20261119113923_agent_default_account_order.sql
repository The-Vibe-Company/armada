alter table public.agent_defaults add column credential_ids uuid[] not null default '{}';

-- Shared accounts require explicit placement and cannot seed a personal pool.
update public.agent_defaults d
set credential_ids = array[c.id]
from public.credentials c
where c.id = d.credential_id and c.scope = 'user' and c.owner_id = d.user_id;

-- Keep scalar-only writers in sync while both database shapes are in use.
create function public.sync_agent_default_account_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if cardinality(new.credential_ids) > 0 then
      return new;
    end if;
  elsif new.credential_id is not distinct from old.credential_id
     or new.credential_ids is distinct from old.credential_ids then
    return new;
  end if;

  new.credential_ids := array(
    select c.id from public.credentials c
    where c.id = new.credential_id and c.scope = 'user' and c.owner_id = new.user_id
  );
  return new;
end
$$;

revoke all on function public.sync_agent_default_account_order() from public, anon, authenticated, service_role;

create trigger sync_agent_default_account_order
before insert or update of credential_id on public.agent_defaults
for each row execute function public.sync_agent_default_account_order();
