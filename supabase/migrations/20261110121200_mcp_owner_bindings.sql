-- Personal grants follow the sandbox owner, not legacy access visibility.
create or replace function public.check_mcp_binding() returns trigger language plpgsql set search_path = public as $$
begin
 if not exists(select 1 from public.sandboxes s join public.mcp_connections c on c.org_id = s.org_id
 join public.mcp_grants g on g.connection_id = c.id
 where s.id = new.sandbox_id and c.id = new.connection_id and g.id = new.grant_id
 and not c.disabled and public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until) = 'connected'
 and exists(select 1 from public.members m where m.org_id = s.org_id and m.user_id = s.owner_id)
 and (c.scope = 'org' or c.owner_id = s.owner_id))
 then raise exception 'Connection cannot be bound to this sandbox'; end if;
 return new;
end $$;
revoke all on function public.check_mcp_binding() from public,anon,authenticated;
