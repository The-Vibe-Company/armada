# Modal checkpoint quiescence and legacy recovery (#732)

## Repair

Legacy recovery was fixed in #755 and is confirmed stopped in production. This
follow-up changes no recovery or database behavior.

The remaining `privileged_writer / unproven` failure came from treating every
new root process as an Armada writer. Platform controls and their same-session,
root-only descendants may legitimately survive. PID1, the scrub's own ancestors,
pre-admission control identities, verified kernel threads and exact Armada
launcher helpers are classified separately. User ancestry, a different session,
a known Runner/harness, or positive managed-state FD/cwd evidence prevents a
new root process from inheriting a platform-child exemption. Unknown root
orphans remain writers, not a blanket root allowlist.

The private Runner still owns the journal and must terminate after its barrier;
only its non-writing flock/runuser launcher helpers are control exceptions.
A persistent root exec-service fixture reproduces the exact production label on
main; the repaired checkpoint succeeds while its harmless root child remains.
The same test refuses an unkillable root managed-state writer and a detached root
writer. Both native and fallback signal modes are exercised with actual seccomp.

Survivor logs include closed `processUidClass`, `processIsAncestor`, `processIsPid1`,
`processCommClass`, `processExeClass`, `processRole`, `processStateClass`,
`processManagedState` and `processSurvivorCount` alongside existing category,
failure and inspection-primitive/errno fields. The traits describe the first
survivor; count covers all remaining writers (capped at 4096). No raw process name,
command line, executable path, PID or environment is logged. An opaque orphan may
still refuse; these fields distinguish it from recognized platform control work.

## Deployment prerequisites

Deploy the new server artifact through the normal coordinator-owned procedure.
No migration, golden rebuild, credential change or production SQL edit is needed.
The agent runtime/image requirements are unchanged. No deployment was performed
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

The real Linux fixture starts the flock/runuser launcher, native Codex and two
initialized stdio MCP servers. A root control service starts before baseline
capture and spawns a persistent root child afterwards. Seccomp makes signals to
that child succeed without killing it, reproducing `privileged_writer/unproven`
on main. The fixed ownership scope preserves the root control child while
checkpointing and terminating actual managed processes. Additional cases prove
root children with managed-state FDs and detached/root-session writers still
refuse, with the closed diagnostic traits. PID1 namespace access is denied;
pidfd-denied and numeric-kill-denied modes independently prove both signal paths.
