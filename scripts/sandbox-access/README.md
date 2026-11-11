# Ordinary sandbox access: operator staging check

Python 3 standard library only; runs on macOS/Linux. This is **not** a CI/live
smoke test and is never invoked by `verify`. Its offline unit tests are.
No deployment, migration, production endpoint or provider credentials are used.

## Preconditions

Use a dedicated, trusted **staging** golden/account and a staging-scoped Armada
owner token. The golden must have no unrelated native MCP servers (in particular
none exposing `launch`, `message`, `read` or `stop`), no automatic orchestration,
and no hostile startup processes. The runner requests no user connections or
launch/default skills. The source golden and model credentials must already work.
Keep provider spending quotas low; this is real model/compute expenditure.

Required environment: `STAGING_URL`, `STAGING_ORG` (organization **UUID**) and
`ARMADA_TOKEN`. Supply the token securely through the environment, never argv or
a file in this repository. The URL must be a root HTTPS origin with `stage` or
`staging` as a hostname component; known production origins are refused. There
is no default origin. This naming check is a guard, not independent proof that
an operator's endpoint is nonproduction.

```sh
export STAGING_URL=https://armada-staging.example.com
export STAGING_ORG='<staging organization UUID>'
# ARMADA_TOKEN must already be exported securely.
python3 scripts/sandbox-access/staging-check.py \
  --provider boat --harness codex \
  --golden '<staging golden name>' --golden-id '<same golden UUID>' \
  --account-id '<authorized named account UUID>' --account-version 1 \
  --model '<authorized model>' --confirm-real-compute
```

Repeat for `--provider modal --harness codex` with its own golden/account.
`--repo <configured repository>` is optional. Deadline defaults to 900 seconds
(`--timeout 60..1800`), followed by a separate 90-second cleanup grace. Requests
have socket and monotonic wall deadlines and bounded response sizes; redirects
are refused, including on the guest-side anonymous probe.

## Evidence, not model assertions

The fixed task asks the opted-in parent to launch exactly one child, message it,
poll its answer and stop it through the native delegated tools. The controller
checks native tool inputs/server results, new owner resource metadata and the
exact initial child prompt marker before adopting a native-result ID for cleanup,
the selected
golden/provider/harness/model/account binding, the child's independent assistant
answer to a random challenge, and independently recorded stopped status. Parent
assistant statements such as “PASS” are never execution evidence.

The controller stops the parent, resumes the same conversation with `send`, and
requires recall of a nonce/child ID **not supplied again** plus a new successful
native read of that child. This proves retained conversation behavior, not the
orchestrator's stronger no-text/native-session checkpoint proof. Boat remains
best effort. Native event formats without completed tool evidence fail closed.
Modal Codex currently normalizes MCP events to bare tool names, dropping server
namespace: the isolated-golden prerequisite matters. Parent-child attribution is
inferred from successful scoped receipts, not a nonexistent public database
attribution endpoint.

A no-option control must have no successful scoped native call. A completed,
child-targeted native read with explicit **401** status and the exact closed
`invalid_epoch_authority` code establishes a no-auth native denial. A foreign-child
403 `scoped_authority_denied` is **not** absence proof: a valid differently scoped
grant receives that same refusal. If the model declines to call, says a tool is unavailable, emits no tool evidence, or produces only a
generic error, native absence/denial is **UNVERIFIED**, even with an old-grant file.
The controller also executes a fixed anonymous gateway request **inside that control**, requiring
401 `invalid_epoch_authority`. No owner token is sent to a guest. This tests the
unauthenticated fence, not native authority absence (an opted-in sandbox would
also receive an anonymous 401), an outbound firewall, or exhaustive proof that a
guest could never acquire separately supplied credentials.

## Optional old-grant audit: required for full PASS

Public APIs intentionally do not export epoch grants. It is impossible to replay
an old grant unattended through those APIs alone. A random invalid token is not
stale-grant proof. Without an authorized operator audit, the runner completes the
other checks/cleanup and emits **UNVERIFIED**, exit 1—not PASS.

If an operator already has an approved private audit procedure, add
`--old-grant-file /private/operator/path`. After the safe `parent_created` UUID
progress line, the runner waits within its deadline for that file. It must be a
regular, nonsymlink file owned by the current user with mode **0600**, containing
only that parent's current `armada_epoch_…` grant. The runner never creates,
changes or deletes this file, never retrieves a token from a sandbox, and never
prints it. Do not put it under the repository; dispose of it securely afterward.
Do **not** ask the model to print a grant, scrape private runtime files, or add a
token-export route to make this test pass.

The file's grant must successfully read the run's discovered child **before**
parent stop. The exact same grant must then receive 403
`scoped_authority_denied` both after stop and after resume. Only that positive /
negative sequence establishes stale-grant refusal. An invalid/stale/unrelated
file cannot provide passing evidence. An approved audit mechanism and staging
rollout are external operator prerequisites, not work performed by this PR.

## Output, cleanup and limits

Output is safe JSON lines: validated new resource UUID progress, then one closed
summary with `PASS`, `UNVERIFIED` or `FAILED`, check names, cleanup confirmation
and resource UUIDs. Exit 0 means all checks—including the optional operator-grant
sequence—and native negative-control proof—passed and cleanup was confirmed. All other results exit 1. No token,
grant, server body, prompt/answer or exception text is emitted.

Cleanup fences known parent/control producers **before** inventory, then discovers
and stops marked children, including children published during the stop. It runs after
timeout, Ctrl-C and SIGTERM. It does **not delete disks/conversations**. Existing
owner deletion rules refuse attributed children, so this runner does not invent
a deletion bypass. Inspect/retain or dispose of stopped artifacts through your
normal authorized process. SIGKILL, machine failure and network partition cannot
guarantee cleanup; the report never labels unknown outcomes as success.

Any native turn without a complete allocation audit, or an ambiguous/unpublished
delegated launch receipt, leaves cleanup **unconfirmed**: an empty owner list and
a stopped parent do not prove that an in-flight child never allocated.
No launch/send is blindly retried after an ambiguous response. Discovery may
only stop independently verified new owner resources on the selected golden whose
first prompt exactly matches this run's child-init or owner-launch task. A native
receipt naming an unmatched/admin-visible foreign resource never authorizes its
cleanup. An allocation that never published that marker cannot safely be inferred
from a list; `cleanup_not_confirmed` and nonzero exit require operator follow-up.
Parent/control TTLs and the active-child cap (1) bound exposure, but delegated
children retain the server's ordinary default TTL (currently four hours); the
public child schema offers no per-child TTL override. Thus a total strict dollar
budget/unknown-allocation cleanup guarantee requires external provider quotas.

Run the offline tests without credentials/network:

```sh
python3 -m unittest discover -s scripts/sandbox-access -p 'test_*.py'
bun test scripts/sandbox-access/staging-check.test.ts
```
