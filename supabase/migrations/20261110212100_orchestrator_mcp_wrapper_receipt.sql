-- Private installation receipt, never a user grant or a secret. Includes the
-- physical boot, MCP generation and generated managed-wrapper hash.
alter table public.orchestrator_runtime add column mcp_wrapper_revision text;
revoke all (mcp_wrapper_revision) on public.orchestrator_runtime from public,anon,authenticated;
