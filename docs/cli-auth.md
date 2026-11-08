## Session refresh

The `armada` CLI refreshes its stored Supabase session shortly before expiry. Read-only Supabase
requests may refresh once and retry after a 401; state-changing requests are never replayed.
External MCP monitoring scripts that send a bearer directly to `/mcp` do not use the CLI session
store and must refresh or renew their own credentials.
