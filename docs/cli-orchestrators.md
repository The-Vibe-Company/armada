# Orchestrator command removal

The public orchestrator CLI command and MCP tools have been removed. Launch an
ordinary sandbox with scoped Armada access instead (replacement delivered in
[#1002](https://github.com/The-Vibe-Company/armada/pull/1002)):

```sh
armada launch GOLDEN --agent codex --credential-id ACCOUNT_ID --armada-access "task"
```

See [Sandbox Armada access](sandbox-armada-access.md) for authorization, child
limits, lifecycle and recovery details. The access is default-off and requires an
explicit named model account. It does not grant a sandbox an owner API token.

A retired CLI invocation fails locally with a readable removal message and does
not log in, call the server or allocate compute. Public orchestrator tools no
longer appear in MCP tool discovery.

This is step 3 of #984, not server or database retirement. Backend services,
provider lifecycle/authority infrastructure, configuration and stored resources
remain until the coordinator authorizes the later removal gates. Shared internal
delegated gateway machinery (including the internal `armada_orchestrator` name)
also supports ordinary opted-in sandboxes and must remain.
