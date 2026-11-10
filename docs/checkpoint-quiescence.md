# Modal checkpoint quiescence and legacy recovery (#732)

## Repair

Modal/gVisor can permanently deny `/proc/1/ns/*`, even to root. The scrub no
longer reads PID1 namespace links. The SDK-selected physical sandbox, generation,
PID1 start identity and captured root control-process allowlist fence the scope;
readable self namespace links remain supplementary identity evidence. Unreadable
self links do not turn an idle sandbox into a conflict.

Additional writers are frozen, killed and rescanned. Supported pidfds anchor
signals. If gVisor denies/does not implement pidfds, the scrub rechecks process
start identity immediately before signaling within the selected sandbox. An
exited/zombie process is not a survivor; an actual surviving writer still refuses
the checkpoint. Logs retain closed `processCategory` / `processFailure` and
`processInspection` (primitive plus errno class), never command lines or secrets.

Legacy recovery now clears `sandboxes.status_reason` when publishing `stopped`.
The existing `sandboxes_status_reason_chk` permits a non-null reason only for
`failed`; the old publication retained the failed reason and violated it.

## Deployment prerequisites

Deploy the new server artifact through the normal coordinator-owned procedure.
No migration, golden rebuild, credential change or production SQL edit is needed.
The agent runtime/image requirements are unchanged. No deployment was performed
while developing this repair.

## Operator commands after deployment

Use an authenticated API-only CLI. Set `ORG`, `GOLDEN` (the Modal native golden
UUID), and `MODEL_ACCOUNT` (the accessible Codex account UUID).

### Retire the existing legacy parent

Replay the **original** recovery key and revision, even though detail shows the
recovery's later revision. This retries only the exact registered termination and
publication; it never allocates a new sandbox:

```sh
: "${ORG:?Set the owning organization UUID}"
armada orchestrator detail 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --json
armada orchestrator recover 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --expected-revision 1 --idempotency-key recover-52b264fd-v1 --json
armada orchestrator detail 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --json
```

Expect the existing receipt to become `succeeded` and the parent `stopped`.
Repeat the same recovery command to verify read-only replay if desired. Do not
manually delete a Modal sandbox or modify SQL rows.

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
initialized stdio MCP servers. It proves PID1 namespace access is denied, denies
pidfds using real seccomp (and separately denies numeric kill to prove native pidfds), then requires
the real checkpoint scrub to succeed with no live writers. Removing CAP_KILL
separately proves an actual survivor still refuses with closed diagnostics. The
PGlite regression uses the real migrations and reproduces the exact legacy
constraint violation before the repair, including same-key recovery/replay.
