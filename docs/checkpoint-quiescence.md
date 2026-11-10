# Checkpoint quiescence investigation (#732)

This branch adds diagnostics and a real Linux regression, **not yet a proven fix for
Modal stop**. Keep the PR draft until the production failure's cause is established.
No database migration is included. Deployment would require the server artifact;
no production access or deployment was performed during this investigation.

## Local evidence

```sh
bun install --frozen-lockfile
bun packages/agent-runtime/build.ts
sudo unshare --pid --fork --mount-proc "$(which bun)" packages/provider-modal/test/checkpoint-process-conformance.ts
```

The disposable namespace starts a flock/runuser launcher, Codex app-server and two
real stdio MCP servers. Both MCP startup acknowledgements are required. With
CAP_KILL removed, the real scrub refuses and identifies `runtime_or_mcp`;
with normal privileges, it kills every non-control process. This does **not**
prove that missing CAP_KILL is the production cause. The pre-change code fails
the diagnostic assertion; the unrestricted tree already quiesced on main.

## Operator commands after deployment (not executed here)

Set `ORG` to the owning organization UUID. Inspect current revision/state first:

```sh
: "${ORG:?Set the owning organization UUID}"
armada orchestrator detail c9110041-af53-4b62-ab45-e89beb1ff937 --org "$ORG" --json
armada orchestrator detail 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --json
```

For the legacy row, replay the original recovery request exactly (not a new key
or revised arguments) to retry the original nonallocating termination:

```sh
armada orchestrator recover 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --expected-revision 1 --idempotency-key recover-52b264fd-v1
```

This is an investigation command, **not a verified retirement procedure**. If
publication still fails, retain SQLSTATE, table and constraint identifiers from
`orchestrator_operation_failure`; never copy SQL detail, row values or tokens.
Checkpoint failures now report closed `processCategory` and `processFailure`
fields without process IDs, command lines, paths, environment or exception text.
Do not manually delete provider sandboxes or change SQL rows.

Unmet acceptance: a proven Modal stop repair, stop/resume/second-stop continuity,
and a verified supported retirement of the legacy row. These need the exact safe
failure metadata; local unrestricted Linux execution does not reproduce them.
