-- A user JWT can no longer select the hash of a service or MCP token.
-- Never edit a migration that has been applied.
--
-- 20261108190000_revoke_default_grants.sql granted SELECT on the whole of service_tokens and
-- mcp_tokens, hash included. The hash is the credential's lookup key: it is compared by the
-- server's service_role, never read back by a person. Listing and revoking go by id, and creating
-- a service token only inserts the hash, so column-level SELECT without it changes nothing the
-- dashboard or the CLI does.

revoke select on public.service_tokens from authenticated;
revoke select on public.mcp_tokens from authenticated;

grant select (id, user_id, org_id, label, revoked_at, created_at) on public.service_tokens to authenticated;
grant select (id, user_id, org_id, label, revoked_at, created_at) on public.mcp_tokens to authenticated;
