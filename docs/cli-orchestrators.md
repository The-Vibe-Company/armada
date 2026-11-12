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

## Existing-compute recovery during the compatibility window

The sandbox replacement does **not** inspect, recover or stop an existing managed
orchestrator. Its owner must use the retained HTTP API or the last compatible CLI,
**2.21.0**, until the coordinator authorizes server retirement. Do not use the
current CLI's removed command or create another sandbox to replace an uncertain
operation.

On the authorized operator host, define an explicitly pinned command without
downgrading the installed current CLI:

```sh
armada_legacy() {
  npm exec --yes --package=@the-vibe-company/armada@2.21.0 -- armada "$@"
}
armada_legacy --version  # must print 2.21.0; stop if it does not
```

This requires npm and access to the published pinned package. Use the existing
owner Armada session or owner-authorized `ARMADA_TOKEN` environment and set
`ARMADA_URL` to the approved control origin. Never put tokens in arguments or
logs. The function is shell-local; define it again in each operator shell.
Use it only for existing-compute inspection/cleanup, not new orchestrator work.

```sh
armada_legacy orchestrator detail "$ID" --org "$ORG" --json
armada_legacy orchestrator events "$ID" --org "$ORG" --all --json
# Read the current revision and inspect pending operations before a NEW attempt.
# For a previously uncertain attempt, reuse its ORIGINAL revision and key.
armada_legacy orchestrator recover "$ID" --org "$ORG" \
  --expected-revision "$ORIGINAL_REVISION" --idempotency-key "$ORIGINAL_RECOVERY_KEY" --json
armada_legacy orchestrator detail "$ID" --org "$ORG" --json
```

A completed key replays its original receipt; a genuinely new recovery needs a
new key after inspecting current detail. Do not reuse a failed stop's key for a
recover request. On unknown outcomes, never recalculate the revision or silently
generate a fresh key. Follow the incident-specific
[Modal recovery](operations/modal-orchestrator-recovery.md) and
[troubleshooting](orchestrator-troubleshooting.md) rules. Recovery can terminate
compute without a resumable checkpoint; do not delete provider resources or SQL
rows manually. The coordinator must stop/release existing compute before retiring
these backend routes in step 4.

Create/smoke examples in older runbooks are historical evidence, not current
rollout instructions or permission to allocate new orchestrators. The pinned CLI
is a temporary compatibility tool, not reversal of the public feature removal.
