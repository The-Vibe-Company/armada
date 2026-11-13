# Explicit Boat runtime resume (#1161)

Owner-only API `POST /api/v1/sandbox/resume-runtime-v1` / MCP `runtime_resume`:

```json
{"id":"SANDBOX_UUID","request_id":"OPERATION_UUID","runtimeVersion":1,"conversation_id":"EXISTING_UUID","prompt":"Continue the previous conversation."}
```

This is **one explicit VM activation**, never a new sandbox/fork or native Boat
prompt. The prior stop must be confirmed and its current-epoch checkpoint must
match the exact archive prefix. Secret-tainted, missing, stale or busy state
refuses before provider/model preparation. Current membership and pinned active
account/version/expiry are reauthorized under member→credential→sandbox→epoch
locks. The logical TTL is rearmed once; compute gets an explicit bounded TTL,
`noEnv:true` and an empty environment. No native GitHub/MCP lifecycle hooks run.

The runtime must restore the expected old journal identity, complete seal,
watermark/ACK and conversation mapping; saved harness file hashes/identity must
match. It then verifies the original native Codex thread using **no-text resume**
before dialing for commands. Its health reports verified `restoredFrom` evidence;
old binaries that ignore the restore requirement cannot pass. Lost/empty disks
never silently become a fresh conversation. Only then is one instruction admitted
with a stable command ID in the same conversation and a NEW runtime epoch.

## Retry and failure rules

Retain `request_id` and exact input. A completed replay returns the historical
accepted receipt without another activation/turn (not a statement of current VM
state). If the new epoch is already live, a fresh server can reconcile the same
command/lease after checking restore health, with no host call or ticket reissue.
If activation/bootstrap outcome is unknown before a live epoch exists, it is
**not retried**: inspect/stop rather than choose another key. Cleanup requests
stop for a failed owned dispatch. Live-epoch uncertainty keeps its bounded lease;
background cleanup still handles interrupted starting state. There is no general
repair/rebind path in this slice. An accepted prompt is not proof that its model
reply succeeded: use journal/status and the memory check below.

## Exact one-sandbox lifecycle staging check

After this slice and `20261113043500_runtime_resumes.sql` are migrated/deployed by
the coordinator, use updated main and existing staging env: `ARMADA_URL` is the
**armada-server HTTPS origin**, `ARMADA_RUNTIME_ORG` an org **UUID**; provide
`ARMADA_TOKEN`, `ARMADA_RUNTIME_GOLDEN`, `ARMADA_RUNTIME_CREDENTIAL_ID`, optional
`ARMADA_RUNTIME_MODEL`. No manual artifact publication: normal image builds
publish the new compiled runtime and pinned CLI manifests (#1325). The new
restore-health evidence requires those matching updated bytes.

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --resume
```

**Budget for ONE sandbox allocation plus ONE explicit VM resume activation**
(two host starts, not a promise of one plan quota charge). No deploy in flight.
Preflight requires resume v1 before allocation. The check performs:

1. Initial prompt teaches a random token and asks for a separate exact ACK.
2. Follow-up recalls the token without resending it; both archive answers finish.
3. Checkpoint epoch 1, stop, verify receipt and both histories while stopped.
4. Resume the SAME VM/logical sandbox/conversation in epoch 2 and ask for the
   remembered token **without resending it**; require a third distinct prompt,
   matching source checkpoint and a strictly next epoch.
5. Recheck old + new archive history, checkpoint epoch 2 and stop again; verify
   the second receipt and all history while stopped.

Expect final `resume:"verified"`, `source:"armada-runtime"`, same conversation,
previous/new epochs and `Runtime resume and stopped history verified.` Exact
assistant answers and finished events are required; metadata/health alone is
not success. Request UUIDs print before mutation. Unknown outcomes never cause a
second allocation/activation retry. Cleanup stops once per attempted activation.

No real cloud resume/memory pass is claimed by worker offline tests. Model-only,
existing conversation, launch model/effort only; GitHub/MCP, usage/cost acceptance
and subscriptions remain the next owner-ordered slices. Native Boat and Modal
paths are not deleted or migrated.
