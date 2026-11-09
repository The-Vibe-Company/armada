alter table public.mcp_connections
  add column catalog_id text check (catalog_id in ('notion','linear','slack')),
  add column default_for_launch boolean not null default false;
-- Metadata changes must not close live gateway streams or invalidate pending OAuth.
drop trigger mcp_definition_invalidation on public.mcp_connections;
create trigger mcp_definition_invalidation after update of org_id,owner_id,scope,transport,url,command,args,auth_type,disabled,catalog_id on public.mcp_connections
for each row execute function public.emit_mcp_invalidation();
create trigger mcp_definition_delete_invalidation after delete on public.mcp_connections
for each row execute function public.emit_mcp_invalidation();
