# Ordinary sandbox access: operator staging check

Python 3 standard library only; runs on macOS/Linux. This is an **operator-only
live staging check**; `verify`/CI run only its offline unit tests, never live checks.
The runner never reads provider credentials; the server resolves existing
configured accounts. No deployment or migration is invoked, and production
endpoints are refused.

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
The current sandbox-access admission supports Boat/Codex and Modal/Codex only;
selecting Claude does not enable an unsupported server pair.
`--repo <configured repository>` is optional. Deadline defaults to 900 seconds
(`--timeout 60..1800`), followed by a separate 90-second cleanup grace. Requests
have socket and monotonic wall deadlines and bounded response sizes; redirects
are refused, including on the guest-side anonymous probe.

## Evidence, not model assertions

The fixed task asks the opted-in parent to launch exactly one child with a
tool-free quick ACK, poll its initial prompt event until explicitly finished,
then message the challenge, poll its answer and stop it through native delegated
tools. The controller requires that completed initial-turn read before the
message; busy/ambiguous messages are never blindly retried. The controller
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
best effort. Both parent proof turns and the control are audited for native actions:
only the expected scoped methods and child-targeted inputs are accepted. Shell,
file/write/read/search, dynamic/unknown tools and native action items such as
`fileChange`/`webSearch` fail closed before the allocation audit is cleared.
Claude result-only frames must correlate to an already allowed native call ID;
orphan results are not evidence. Reasoning, plan, usage and system metadata are
not rejected just for being metadata. This prevents a correct nonce obtained
through an explicit file/tool side channel from passing as conversation memory. Native event formats without completed tool evidence fail closed.
Modal Codex currently normalizes MCP events to bare tool names, dropping server
namespace: the isolated-golden prerequisite matters. Parent-child attribution is
inferred from successful scoped receipts, not a nonexistent public database
attribution endpoint.

A no-option control must have no successful scoped native call. A completed,
child-targeted native read with explicit **401** status and the exact closed
`invalid_epoch_authority` code establishes a no-auth native denial. A foreign-child
403 `scoped_authority_denied` is **not** absence proof: a valid differently scoped
grant receives that same refusal. If the model declines to call, says a tool is unavailable, emits no tool evidence, or produces only a
generic error, the native check is **UNVERIFIED**, even with an old-grant file.
It also leaves the native-turn allocation audit incomplete, so the final run is
**FAILED** with `cleanup_not_confirmed` even if all *known* machines were stopped.
The same applies to a resumed turn without its expected completed read: absence
of a recognized launch event is not proof that nothing allocated.
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
summary with `PASS`, `UNVERIFIED` or `FAILED`, a closed proof phase/cause, check
names, cleanup confirmation
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
a stopped parent do not prove that an in-flight child never allocated. The
resumed/control audit is only cleared by its expected completed scoped read or
exact native 401 denial, respectively—not merely an empty recognized-tool list.
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

## First-launch diagnostics and repository selectors

Each controller API call emits an additional JSON line with **only** `step`,
`route`, HTTP `status`, `code` and `reason`. Steps/routes are fixed local labels
(including `parent_launch` and `control_launch`), never URLs or submitted arguments.
Machine codes/reasons use finite allowlists; unknown supplied values become
`unknown_code` or `unknown_reason`. The runner reads either `error.reason` or
`error.details.reason`, never server messages/bodies. A missing server reason
stays `null`; local transport/deadline labels appear only without an HTTP status.
The final summary retains the first failing API step and the closed local cause
through cleanup. Known owner/current request credentials are redacted even if
they equal an allowlisted word. Output writes are best effort: a broken pipe
never changes the request outcome or prevents cleanup, with no stderr fallback.

The reported `--repo /home/user/armada` was not a valid selector in the old
runner: the API accepts a configured directory selector or `owner/repo`, not
an arbitrary absolute working directory. A local real-handler regression using
an absolute path returns HTTP 400 `invalid_config` before any provider fork or
sandbox registration. This proves the input-contract issue, **not** the sole
cause of the reported staging failure: access-service availability is checked
earlier and can instead refuse with HTTP 503 `dependency_unavailable`. Read the
new `parent_launch` trace before claiming a deployed configuration/root cause.

For compatibility the runner now translates only exact `/home/user/<dir>` paths
whose single directory segment exactly matches one selected golden
`config.repos[].dir`. The same selector goes to parent, control and child. There
is no basename guessing, trailing-slash normalization or traversal (`..`);
unmatched absolute paths fail preflight before allocation flags. Existing
directory and `owner/repo` selectors are unchanged. Server validation is unchanged.

This MCP-only probe does not need a repository cwd. The safest rerun **omits
`--repo`**, without guessing the golden layout. With the three required staging
environment variables already set securely, set `BOAT_GOLDEN_ID`,
`MODAL_GOLDEN_ID` and `MODEL_ACCOUNT_ID` to the actual authorized UUIDs (the same
owner account, version 1, for both placements):

```sh
python3 scripts/sandbox-access/staging-check.py \
  --provider modal --harness codex \
  --golden smoke-modal --golden-id "${MODAL_GOLDEN_ID:?Set the smoke-modal golden UUID}" \
  --account-id "${MODEL_ACCOUNT_ID:?Set the authorized owner account UUID}" \
  --account-version 1 --model gpt-6.1-sol --confirm-real-compute
```

Inspect that run and confirm cleanup before starting the other placement; do not
automatically continue after an unknown allocation/cleanup outcome.

```sh
python3 scripts/sandbox-access/staging-check.py \
  --provider boat --harness codex \
  --golden smoke-boat --golden-id "${BOAT_GOLDEN_ID:?Set the smoke-boat golden UUID}" \
  --account-id "${MODEL_ACCOUNT_ID:?Set the authorized owner account UUID}" \
  --account-version 1 --model gpt-6.1-sol --confirm-real-compute
```

Optionally add `--repo armada` only if `armada` is actually configured on each
selected golden. This is not a promise of a live pass: old-grant audit, native
negative-control evidence, provider readiness and approved staging rollout remain
prerequisites. This change performed no live staging rerun.
