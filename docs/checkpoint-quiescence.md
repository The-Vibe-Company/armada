# Modal checkpoint quiescence and legacy recovery (#732)

## Repair

Legacy recovery was fixed in #755 and is confirmed stopped in production. This
follow-up changes no recovery or database behavior.

Bootstrap introduces root control/launcher processes after the original baseline
capture. The adapter now seals exact root PID/start identities once after trusted
bootstrap health, before active publication or user admission. The authenticated
health responder PID is excluded even if UID/inspection is ambiguous: the private
Runner owns the journal and must terminate. Positive managed-state FD/cwd evidence
also vetoes a control exemption.

There is no general descendant, session or root-UID exemption. Real root orphans
adopted by `PR_SET_CHILD_SUBREAPER` cannot gain trust through a new parent. Once
admitted, a baseline can never be recaptured; legacy health without a PID grants
no extra control trust. Unknown post-admission root processes still refuse.

Survivor logs include closed `processUidClass`, `processIsAncestor`, `processIsPid1`,
`processCommClass`, `processExeClass`, `processRole`, `processStateClass`,
`processManagedState` and `processSurvivorCount` alongside existing category,
failure and inspection-primitive/errno fields. The traits describe the first
survivor; count covers all remaining writers (capped at 4096). No raw process name,
command line, executable path, PID or environment is logged. An opaque orphan may
still refuse; these fields distinguish it from recognized platform control work.

## Deployment prerequisites

Deploy the updated server and rebuilt runtime artifact through the normal
coordinator-owned procedure. Fresh launches receive the public runtime overlay;
no migration, golden rebuild, credential change or production SQL edit is needed.
Existing admitted parents never acquire a reconstructed control set. Old checkpoint
images whose health lacks a PID retain conservative legacy scope. No deployment was performed
while developing this repair.

## Operator commands after deployment

Use an authenticated API-only CLI. Set `ORG`, `GOLDEN` (the Modal native golden
UUID), and `MODEL_ACCOUNT` (the accessible Codex account UUID).

### Inspect the currently blocked parent

```sh
: "${ORG:?Set the owning organization UUID}"
armada orchestrator list --org "$ORG" --json
# Select the full UUID matching the affected 07cdaaa1 prefix from list output:
: "${AFFECTED_ORCHESTRATOR:?Set the full affected orchestrator UUID}"
armada orchestrator detail "$AFFECTED_ORCHESTRATOR" --org "$ORG" --json
armada orchestrator events "$AFFECTED_ORCHESTRATOR" --org "$ORG" --all --json
```

Do not resume an uncertain stop or assume a new key retries it. Preserve its
original key/revision for supported reconciliation. The fresh smoke below avoids
mutating an already uncertain checkpoint. Do not rerun the completed legacy
recovery as part of this follow-up, delete provider sandboxes or edit SQL rows.

### Fresh stop → resume → second stop smoke

Keep the same `RUN_ID` and keys when retrying uncertain commands. Set
`ORCHESTRATOR` to the full UUID returned by create. Wait for create to succeed and
state `ready`, and for the send turn to finish, before advancing. The expected
revisions below are for this fresh parent with no intervening mutations.

```sh
: "${ORG:?}" "${GOLDEN:?}" "${MODEL_ACCOUNT:?}"
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
armada orchestrator create checkpoint-smoke --org "$ORG" --golden "$GOLDEN" --provider modal --agent codex --model gpt-6.1-sol --model-account "$MODEL_ACCOUNT" --idempotency-key "732-create-$RUN_ID" --json
# Set ORCHESTRATOR to the returned full UUID, then inspect readiness:
: "${ORCHESTRATOR:?Set the newly created orchestrator UUID}"
armada orchestrator detail "$ORCHESTRATOR" --org "$ORG" --json
armada orchestrator send "$ORCHESTRATOR" 'Remember checkpoint marker armada-732 and reply briefly.' --org "$ORG" --expected-revision 1 --idempotency-key "732-send-$RUN_ID" --json
armada orchestrator events "$ORCHESTRATOR" --org "$ORG" --all --json
# After the turn finishes (inspect detail/events again if necessary):
armada orchestrator detail "$ORCHESTRATOR" --org "$ORG" --json
armada orchestrator stop "$ORCHESTRATOR" --org "$ORG" --expected-revision 2 --idempotency-key "732-stop1-$RUN_ID" --json
armada orchestrator detail "$ORCHESTRATOR" --org "$ORG" --json
armada orchestrator resume "$ORCHESTRATOR" --org "$ORG" --expected-revision 3 --idempotency-key "732-resume-$RUN_ID" --json
armada orchestrator detail "$ORCHESTRATOR" --org "$ORG" --json
armada orchestrator stop "$ORCHESTRATOR" --org "$ORG" --expected-revision 4 --idempotency-key "732-stop2-$RUN_ID" --json
armada orchestrator detail "$ORCHESTRATOR" --org "$ORG" --json
```

Expect `stopped` with verified native continuity, then `ready` with the restored
native session (resume sends no prompt), then `stopped` again. Wait for each
operation to settle before the next. If a stop is uncertain, retain its exact
key/arguments and the closed diagnostic fields; do not resume an unverified stop.

## Local regression commands

```sh
bun packages/agent-runtime/build.ts
sudo unshare --pid --fork --mount-proc "$(which bun)" packages/provider-modal/test/checkpoint-process-conformance.ts
sudo unshare --pid --fork --mount-proc "$(which bun)" packages/provider-modal/test/checkpoint-process-conformance.ts --native-pidfds
bun test packages/mcp-server/test/orchestrator-create-recovery.test.ts
```

The real Linux fixture starts a root subreaper service before capture and adds a
root control child during trusted bootstrap. It seals exact identities before
admission, then starts cleanup against a real native Codex/two-MCP process tree.
Seccomp makes control signals succeed without terminating it; the exact old
`privileged_writer/unproven` refusal is reproduced before this repair. Both native
and fallback modes retain the known control child while terminating managed work.
A real same-session orphan is reparented to the service using
`PR_SET_CHILD_SUBREAPER` and must remain a writer. An exact control which later
opens managed state must also refuse. The fixture verifies the service exists in
the initial baseline and checks actual kernel reparenting, not a direct-child proxy.
