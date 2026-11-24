# Boat runtime

Ordinary new Boat launches default to Armada's compiled runtime for prompts,
journal/history and private model configuration. Existing native Boat sessions
keep their recorded launch path and conversations. Runtime launch failures
are reported on the selected path. See [runtime operations](runtime-startup.md)
for artifacts, enrolment, transport, secrets and diagnostic checks.

## Deployment and launch

An authorized operator deploys the merged schema and matching artifact-bearing
server/runtime image through the normal process. Do not deploy or apply migrations
from a worker. Set trusted server `ARMADA_BOAT_RUNTIME_MANIFEST` to the matching
`/opt/armada/runtime-manifests/x64.json` (or arm64 on that architecture).
The normal image publishes runtime/harness bytes automatically; no manual copy.
Boat launches use the enrolled runtime. Startup requires valid installed runtime artifacts.
`POST /api/v1/launch/options` reports `boatRuntime.enabled` and capability versions.
Preflight the versions required by your check **before** allocating. Disabling
new launches does not remove existing runtime read/cleanup routing.

Launch through `POST /api/v1/sandbox/launch` with
`runtimeVersion:1`, `boatRuntime:true`, `provider:"boat"`, `harness:"codex"`,
authorized organization, snapshot and account; the initial prompt is optional. Skip skill defaults; remote
HTTP/SSE MCP uses the standard `connections` selection or registry
`defaultForLaunch` defaults as described below. See [explicit runtime launch](launch-idempotency.md#explicit-runtime-launch).

The immutable `sandboxes.boat_runtime` decision is recorded at insert. Persisted
owner, model/account version, cwd and provider identity govern later routing;
never relabel native sessions or resolve a native provider when runtime identity
is missing. The compute-only host adapter exposes no inherited native agent or
model-auth lifecycle hooks. Bootstrap forks with `noEnv:true` and empty environment;
only ticket/public artifact metadata reaches private SSH stdin. Model configuration
goes through encrypted enrolment, not fork environment or host arguments.

Use the snapshot checkout as-is: no pull/init replay or native cwd/CLI probe.
Launch-time skills/helpers, scoped toolbox access and unsupported extras refuse
before allocation; remote HTTP/SSE MCP uses the normal launch/turn lifecycle.
Owner-scoped steer, interrupt and synchronous exec use private runtime commands,
never native Boat agent APIs. Codex steering restarts the native turn within the
same runtime prompt; Claude steering joins the running turn. Idle steer refuses
with `no_running_turn`. Interrupt waits for the terminal event. Exec retains the
existing authorization, redaction and output limits. Unknown command delivery
remains unknown; do not blindly retry. New conversations and model/effort
overrides are not supported on this lane. Follow-ups use the existing
conversation and launch model/effort. GitHub requires explicit runtime refresh
below; remote MCP prepares automatically
from launch bindings/defaults, never native setup. Readable-variable/
secret parity, usage/cost and subscription lifecycle acceptance are not established
by the model-only milestone.

## Follow-up and uncertain delivery

`POST /api/v1/sandbox/send` (MCP `send`) wakes a checkpointed stopped runtime
through the existing resume path and preserves its absolute expiry. It requires a stable
`request_id` UUID. Only the owner can send;
current membership, active pinned account/version, logical expiry and runtime
epoch are revalidated. Wait for the previous prompt's finished event before
another send; the runtime performs the final busy check.

Retain every operation UUID and exact input. Identical replay reconciles the
durable receipt without a second turn. Unknown admission retains its lease;
other IDs refuse until it settles or the owner inspects/stops. A post-admission
refusal can also leave the workspace fenced. Never interpret a timeout as proof
nothing ran, change the request ID or start another sandbox to probe. A successful
command receipt means admission, not a completed assistant answer.

## Checkpoint, stop and explicit resume

Owner API `POST /api/v1/sandbox/checkpoint-runtime-v1`:

```json
{"id":"SANDBOX_UUID","request_id":"OPERATION_UUID","runtimeVersion":1}
```

The durable same-epoch intent blocks new sends until in-flight admission settles.
The runtime interrupts work, waits for native completion, closes drivers, flushes
journal outbox and seals private harness state. A complete receipt requires both
the matching encrypted command result and the **exact** acknowledged archive prefix:

```json
{"runtime":{"kind":"armada","epoch":"1"},"checkpoint":{"state":"complete","watermark":20,"acknowledgedSequence":20}}
```

Generation mismatch, missing ACK, gap, late tail or application-secret exposure
fails closed. Repeat the same UUID on uncertainty; another UUID cannot replace an
unresolved intent. A server restart can reconcile the receipt without waking compute.
A checkpoint neither stops the VM nor creates a Git work archive or proves retained
disk. Follow with ordinary `sandbox/stop` and confirm physical stop separately.
Raw stop still cleans compute but does not claim a checkpoint. Reuse requires a
same-current-epoch receipt whose final prefix still matches after stop fencing.

Enrolled Boat stop records a checkpoint note. Dirty work recovery relies on
confirmed retained disk. The stop receipt provides no Git work archive. The probe
reads the executing Linux boot ID, which can survive a retained restore. Boat can
also admit a command after an independent resume, so the preceding liveness read
cannot bind the command to the same live incarnation. Archive collection needs
that binding and trusted proof that the checkpoint barrier holds through
collection. The checkpoint note is the accepted outcome for the current Boat
host contract. [Archive gate decision](https://github.com/The-Vibe-Company/armada/issues/2741#issuecomment-7081451175)

Owner API `POST /api/v1/sandbox/resume-runtime-v1`:

```json
{"id":"SANDBOX_UUID","request_id":"OPERATION_UUID","runtimeVersion":1,"prompt":"Continue the previous conversation."}
```

This is **one explicit same-VM activation**, never a fork, new sandbox or implicit
`send` resume. Confirmed retained stop and valid checkpoint are prerequisites.
Secret-tainted, missing, stale or busy state refuses before provider/model
preparation. Membership, pinned account/version and expiry are reauthorized;
logical TTL is rearmed once with bounded compute TTL, `noEnv:true`, empty environment.

The new process verifies saved journal identity/seal/watermark/ACK, conversation
mapping and harness file hashes, then performs no-text native harness session restore.
Health must report verified `restoredFrom` evidence before one stable command is
admitted in the same conversation under a **new** epoch. Old binaries, lost disks
or empty state cannot silently start a fresh conversation.

Completed replay returns the original accepted receipt without another activation.
A fresh server can reconcile an already-live new epoch after restore-health checks.
Unknown activation/bootstrap before a live epoch is **not retried**; inspect/stop.
Failed owned dispatch requests cleanup; live uncertainty retains its bounded lease.
No general repair/rebind service or native fallback is implied.

## GitHub refresh and automatic remote MCP

After runtime readiness, the owner calls `POST /api/v1/github/refresh` with `{"id":"SANDBOX_UUID"}`. The private
`configureGitHub` command installs runtime-owned Git/gh identity and just-in-time
helpers, scoped only to snapshot repositories and the connected owner's GitHub App
access. No Boat prompt/exec/SSH credential setup is used. Private credential
delivery rechecks current membership, connection and runtime epochs.

`POST /api/v1/github/runtime-status` returns safe
epoch/revision/configured state and acquisition count, not GitHub connectivity.
Checkpoint, stop, disconnect and new enrolment invalidate authority. **Refresh
again after resume**; old wrappers are redaction-only before restore. A positive
credential count alone does not prove a successful GitHub command.

Remote HTTP/SSE MCP uses the existing `connections` launch field or registry
`defaultForLaunch` defaults. Omit the field to use defaults, or provide the exact
connected IDs (at most 32); explicit empty selection disables MCP. Selected bindings
freeze at launch; preparation runs automatically before the first, later and first
resumed prompt. There is **no** separate user setup/repair option or public
`runtime_mcp_refresh` tool/endpoint. Local pinned stdio launchers are unsupported;
unsupported defaults/selections refuse before forking, not after allocation or by
falling back to native setup. Arbitrary URLs/headers are not launch inputs.

Only sealed gateway capabilities reach the runtime, never upstream grants.
Current registry/gateway membership, personal/org visibility, connection state and
expiry still govern access. Lease authority binds the current runtime epoch/
lifecycle; checkpoint/session replacement durably revokes it, including on older
gateway replicas. Resume boots with empty MCP defaults, then automatic preparation
reauthorizes its fixed bindings before inference. MCP-v1 guest health is required;
old artifacts refuse before configuration.

Preparation and command enqueue commit together under the sandbox/epoch fence;
network waits happen afterwards. Concurrent grant updates cannot enqueue an older
snapshot behind a newer one or hide stale guest state behind a cached ACK.
Unchanged configuration reuses a verified receipt without RPC. OAuth access refresh
remains gateway-owned; reconnect/definition-generation changes refresh next turn
automatically, and deleted bindings clear the guest snapshot. Completed turn replay
does not reconfigure or start another turn.

`launch/options.boatRuntime.mcpVersion:2` identifies this automatic lifecycle;
the guest RPC capability remains v1. `POST /api/v1/sandbox/mcp-preflight-v1` with
`{runtimeVersion:1,org,connections:[...]}` checks connected HTTP/SSE selection
before allocation and returns `mcpReady:true`; it is not a configuration endpoint.
Older check/server combinations fail before allocation, not a compatibility mode.

## Diagnostics and recovery

Server `event:"armada.runtime.stage"` logs record the sandbox ID, epoch, server
observation time (`observedAtMs`), and a fixed reason when present. Fixed stages
include `bootstrap_started`, `artifact_verified`, `enrolled`,
`harness_started`, `first_event`, `bootstrap_failed`, `runtime_failed`, or startup
failure by bootstrap/enrolment/readiness phase. Stage reports are best effort,
not inference proof. `first_event` means archive commit, possibly only queued state.
No prompt/model response, credentials or raw guest error belongs in these reports.

Startup/runtime failures publish safe reasons and revoke authority. `logs/read`
can return `runtimeFailure:{status:"failed",reason:...}` without querying dead
compute or inventing journal events. An admitted prompt without terminal archive
state reads failed; pre-admission failure must not invent a prompt. Cleanup needs
confirmed `stoppedAt`, even if the sandbox retains failed status/reason.

Server restart alone needs no new enrolment or Boat start: SQL retains session
hashes, epoch, command receipts and ACKed event prefixes, and the guest retains its
SQLite outbox. WSS disconnect falls back to HTTPS with stable IDs. Inspect existing
allocations after uncertain transport; never retry allocation/activation blindly.

## Coordinator-only Boat checks

Run on demand with existing authorized Boat resources. Boat is excluded from
staging acceptance and release gates. Run with no deployment in flight and supply:

- `ARMADA_URL`: **armada-server HTTPS origin**, not dashboard.
- `ARMADA_TOKEN`: environment-only bearer; never arguments/logs.
- `ARMADA_RUNTIME_ORG`: organization **UUID**, not name/slug.
- `ARMADA_RUNTIME_GOLDEN`: the name of a ready Boat snapshot.
- `ARMADA_RUNTIME_CREDENTIAL_ID`: authorized account UUID for the selected harness.
- Optional `ARMADA_RUNTIME_MODEL`.
- `ARMADA_RUNTIME_HARNESS=claude` selects Claude (default: `codex`). Use an Anthropic key or Claude token account ID for Claude.

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --resume
```

Budget **one allocation plus one explicit same-VM activation** (two host starts,
not one quota charge), with no allocation/activation retries. The script teaches
a random token, recalls it without resending, checkpoints/stops and verifies
receipt/history while stopped, resumes the same conversation in the next epoch,
recalls memory, then checkpoints/stops and verifies all histories again.
Require exact non-partial assistant answers, terminal finished events,
`source:"armada-runtime"`, matching runtime receipts and complete watermark=ACK.
Final `resume:"verified"` is required; metadata/health alone is not a pass.
`--followup`, `--checkpoint` or no flag run narrower checks, not resume parity.

Prefer a combined check when accepting GitHub/MCP, rather than allocating separate
test sandboxes. Set `ARMADA_RUNTIME_GITHUB_REPOSITORY` to an owner-accessible snapshot
repository (Git and gh required). For MCP choose an existing connected HTTP/SSE
connection **already marked `defaultForLaunch` in the target environment**. Set its UUID in
`ARMADA_RUNTIME_MCP_CONNECTION_ID`, exact read-only `ARMADA_RUNTIME_MCP_TOOL`,
non-secret `ARMADA_RUNTIME_MCP_ARGS_JSON` (default `{}`, prefer a no-argument tool),
and stable result substring `ARMADA_RUNTIME_MCP_EXPECT` (not sent to the model).

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
bun scripts/check-boat-runtime.ts --mcp --github --resume
```

The check deliberately omits explicit connection selection to prove normal defaults,
not a setup endpoint. Budget **one allocation, one same-VM activation (two host
starts), four prompts and two stops**, with no activation/allocation retry. Require
current merged schema including runtime MCP epochs, matching artifact-bearing
server/runtime image and existing opt-in/resume/GitHub settings. No manual artifact
publication or deployment in flight. Preflight all capability versions, connection
health/default metadata and GitHub access before allocation.

1. First prompt calls MCP, teaches a random token and gives a separate exact ACK,
   proving preparation preceded first inference.
2. Follow-up calls MCP again, performs the explicit GitHub check and recalls memory
   without receiving it again. No MCP setup action is sent by the client.
3. Checkpoint/stop; re-read its receipt and both histories while stopped.
4. Resume the same VM/conversation into the next epoch. GitHub is automatically
   reauthorized before inference, using the existing connected-account policy;
   MCP is prepared and the first resumed prompt calls MCP and recalls memory.
5. Explicit GitHub refresh/check in prompt4; MCP works without a setup call.
   Checkpoint/stop and read all four histories and the same receipt.

Require exact answers/finished events from `logs/read.source:"armada-runtime"`,
complete checkpoint watermark=acknowledgedSequence, final `resume:"verified"`,
`githubAfterResume:"verified"` and `mcpAfterResume:"verified"`. GitHub proof needs
the current prompt's successful read-only gh command, new epoch/revision and
positive credentialRequests. Before the explicit refresh, GitHub status must
already be configured in the new epoch with a new revision; the check must not
repair missing automatic preparation.
Each MCP proof needs that prompt's `tools[].server`, exact tool/JSON arguments,
`isError:false` and expected result substring, rechecked while stopped. Another
server, prior prompt or assistant assertion cannot pass. Safe `mcpProof` names
new epoch/prompt/connection/server/tool. Retain printed UUIDs on uncertainty;
inspect/stop known compute, never allocate/activate again to guess.

`--mcp --resume` without GitHub is a three-prompt lifecycle; `--mcp` alone is one
activation/two prompts, not resume parity. Flags select acceptance checks, not
product behavior switches. Offline SDK/native evidence is not deployed
model/MCP acceptance. Current deployed parity remains coordinator-owned.

## Single skills + MCP acceptance check

Remote HTTP/SSE MCP already uses the normal runtime launch/turn flow (#1407),
and default skills installation is merged (#1417). To accept these together,
use the Boat inputs above and the same existing read-only MCP tool inputs:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --skills --mcp --resume
```

Budget: **one allocation + one same-VM resume activation (two host starts),
THREE prompts, TWO stops**, no retry. First prompt calls MCP; ordinary follow-up
calls MCP and recalls memory; first resumed prompt calls MCP and recalls memory
in epoch+1. No extra MCP-only post-resume prompt is needed. Adding `--github`
retains its existing fourth prompt, because explicit GitHub refresh must happen
before that check; the three-prompt mode does not claim GitHub acceptance.

Before allocation, skills are discovered through the shipped snapshot/org/personal
`skills/defaults/get` API using the existing post-deploy-smoke oracle. Empty
effective defaults stop plainly before allocation. Launch omits explicit skills
and the skip-defaults flag. Both launch receipts and persisted `status.skills`
must match exactly the effective pins, including version/ID/checksum/origin;
receipts are checked after stop and resume. No skill references, file substrings,
new credentials or manual artifact publication are required.

Require `skillsAfterResume:verified`, `mcpAfterResume:verified`,
`resume:verified`, archived `source:armada-runtime`, successful MCP server/tool/
exact-argument/result evidence on all three prompts and stopped readback,
matching receipts, remembered token and epoch+1. Neither configuration ACK nor
assistant assertion is a tool-call pass. Local pinned stdio remains unsupported;
its production use needs owner inventory, not speculative porting or deletion.
This procedure is not evidence of deployed acceptance or permission to flip defaults.

## Environment-wide Boat default

Startup requires the image's matching
`/opt/armada/runtime-manifests/<arch>.json` (or the trusted manifest override)
and the published runtime and harness artifacts in `ARMADA_RUNTIME_ARTIFACT_DIR`.
Each artifact must be a regular file named by its manifest digest with the
declared byte count.

For rollback, follow the [release rollback procedure](releasing.md).

### Workspace preparation and launch limits

Repository refresh/init is now performed at launch through private runtime
workspace commands, reusing the native command builders and execution policy:
configured repository order/branches, `pull --ff-only` without reset,600-second
step deadlines, the same single ownership retry, then ordered init in
`/home/user`. Automatic current-epoch GitHub broker setup precedes pulls when
connected; public/local git remains possible without a connection. Initialization
uses the existing model-credential-free runtime execution environment and scoped
GitHub wrappers, not borrowed model keys or native Boat exec/SSH. Background or
failed setup cannot proceed to inference. General exec remains a separate control
path; this private operation is launch-only.

Runtime launches require an authorized bound model account and refuse requested
helper capabilities. The owner `sandbox/extend` operation returns
`extension_state` for enrolled Boat before provider I/O. Choose the required lifetime at launch. Extension is
deferred to [#4011](https://github.com/The-Vibe-Company/armada/issues/4011).
The stop receipt continues to carry the checkpoint note described above.

Boat resume now automatically reauthorizes connected GitHub access after verified
restore health and before MCP/inference, under the resume activity lease. Failed
preparation prevents inference; identical-request reconciliation does not activate
compute again, and an accepted prompt replay does not rotate GitHub authority.
Modal resume behavior is unchanged. No repository/init steps rerun.

Model changes and arbitrary new conversations remain unsupported. Use the
dedicated acceptance checks for public steer, interrupt and exec controls.
Record deployed evidence separately for each required parity row.

### Ordinary launch path check

For an on-demand check of the runtime default, use the
[ordinary launch probe](#verifying-the-ordinary-launch-path)
below. Record the selected path and the archived runtime source.

## Repository/init runtime check

The coordinator-only workspace check reuses an existing snapshot recipe; no new
canary, branch, repository or secret input is required. With the same existing
Armada origin, token, organization, snapshot and Codex account:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --workspace --resume
```

ONE allocation + ONE same-VM activation (two host starts), three prompts, two
stops; no allocation/activation retry. Preflight requires workspace-v1 server
support and reads the selected snapshot's repository/init counts before allocating.
The guest independently proves workspace-v1 health in the current epoch before
GitHub authority or commands are delivered; old artifacts refuse, never use
native setup. The server image publishes the updated compiled artifact normally.

Require archived `source:armada-runtime` / `type:armada/workspaceStep`: every
configured repository and init step must finish before any first prompt event.
Failed setup prevents inference; command output is bounded/redacted, not copied
into diagnostic events. Retry is only the native completed Git-ownership refusal,
not uncertain command delivery. Stable command IDs replay cached outcomes, never
run init twice. Workspace operations are launch-only: existing journal prompts
prevent re-running setup even after process reconstruction. Cancellation closes
the owned process group before the private operation returns.

Final `workspace:verified` and `workspaceAfterResume:preserved_without_rerun`
require original setup history, exact replies/terminal events, same conversation,
epoch+1 and stopped readback. Resume must not emit new workspace setup events or
overwrite user work. The check deliberately skips skill defaults/MCP in this
bounded workspace slice; adding `--skills --mcp` can batch their existing gates
once those resources are configured, still without extra allocation. It is not a
proof of idle, public exec or other features' separate acceptance gates.

Current owner facts remain: quota exhausted today, no smoke default skills or
named MCP connection. No live attempt or setting flip by this worker; real
repository/init acceptance remained pending in that check. Idle launch/first send now has
its own check below; the remaining owned parity gates and Claude/cost/subscription
work remains with #1419/#1420.

## Cutover boundary

The [owner cutover decision](https://github.com/The-Vibe-Company/armada/issues/2741#issuecomment-7082117919)
sets the Boat runtime default with lifetime extension deferred and stop preservation
limited to the checkpoint note. After release, the coordinator runs its
production checklist on authorized resources under the
[architecture program](https://github.com/The-Vibe-Company/armada/issues/2835).

## Claude acceptance (#1419)

The coordinator runs this **single** on-demand check with an existing Boat snapshot
and an Anthropic key or Claude token account supplied by ID:

```sh
ARMADA_RUNTIME_HARNESS=claude ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --usage --resume
```

Prerequisites: apply the new `20261113131000_boat_runtime_claude.sql` migration
through the operator migration process and deploy matching server/runtime artifacts.
No manual artifact publication. Workers neither apply remote migrations nor deploy.
One allocation, one retained-VM activation, three prompts, two stops; no allocation
or activation retries. Require first ACK, same-conversation remembered-token follow-up,
epoch+1 remembered-token resume, verified checkpoint receipts and stopped history,
and per-turn usage projected against the admitted account pricing. Missing usage
fails; unknown cost stays unknown rather than becoming zero. Require final
`resume:"verified"` and `usageAfterResume:"verified"`.
Offline tests do not establish the deployed result. No native fallback, new product
launch option, default-on switch or native-path deletion is part of this slice.


## Runtime controls acceptance (#1457)

Coordinator only, using the existing Boat inputs and matching server/runtime
artifacts (no new migration or default switch):

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --steer --interrupt --exec --resume
```

This adds two control prompts and one synchronous exec to the same allocation.
It requires controls v1 before allocation, exact exec output, a running-turn
steer receipt with honest harness delivery, its exact replacement answer, and an
archived interrupted terminal event. Combine with the existing MCP/skills/usage
flags if accepting those in the same launch. No allocation retries. The
coordinator records the deployed result in the #1161 parity table; offline tests
and this procedure are not evidence of a deployed pass.


## Automatic Boat resume GitHub acceptance

Coordinator only, after normal matching server/runtime deployment, using your own
authorized production Boat resources. Use the
existing environment-only server origin, caller token, org, snapshot, bound model
account and authorized snapshot GitHub repository; no new credentials or flags:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --github --resume
```

One allocation + one same-VM activation, four prompts, two stops, no retries.
Require configured GitHub status in epoch+1 with a new revision BEFORE the
checker's explicit refresh. Then require that fourth prompt's archived successful
read-only gh command and positive current-epoch credential requests, plus
remembered token, checkpoints and stopped history. Missing automatic setup must
fail, not be repaired by the checker. Optional existing MCP/skills flags share the
same allocation only when their real resources are configured. Repeat with
`ARMADA_RUNTIME_HARNESS=claude` for Claude acceptance, as a separately authorized
lifecycle. No worker real check, deployment, default flip or native deletion.
Launch-time before/after measurement remains pending coordinator evidence; this
slice changes resumed-turn preparation, not launch.


## Idle launch and first-send acceptance

Ordinary Boat launches honor the server default selection with or without a
prompt. An idle runtime launch completes workspace/GitHub, skills, MCP and final
admission before publishing `ready`, with no conversation or inference. Its first
normal `send` opens one conversation, then follows the
same account, epoch, activity-lease and durable-command rules as later sends.
A competing first send cannot create another conversation. Reuse the original
request ID and identical payload after uncertainty; an accepted replay neither
starts another turn nor overwrites a newer task. Arbitrary new conversations
and model changes remain unsupported. Modal behavior is unchanged.

Coordinator only, with existing environment-only inputs and your own Boat
resources after normal server/runtime delivery:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --idle --resume
```

This uses explicit runtime admission, so production's default need not change.
ONE allocation + ONE same-VM activation, three prompts (first send, follow-up,
resumed send), two stops, no allocation/activation retries. Require idle
`ready` without prompt/conversation, same-epoch first-send receipt, archived
real exact answer (`idleLaunch:verified`, `firstSend:verified`), remembered
token, checkpoint/stopped readback and epoch+1 same-conversation resume.
Use `ARMADA_RUNTIME_HARNESS=claude` for a separately authorized Claude run.
Existing workspace/MCP/skills/usage/GitHub/control flags can share this allocation
when their real prerequisites are configured. Empty defaults remain a refusal.
A never-prompted idle worker still has no checkpointable conversation: automatic
idle pause/wake before any first send is not claimed.

The ordinary standard smoke above is no longer blocked by idle admission, but
still requires the operator-controlled runtime default and all its resources;
do not flip production just to test this slice. No real check or default flip was
performed by the worker. Launch timing before/after and >20% regression decisions
remain coordinator evidence, not inferred from offline tests.

### Launch timing evidence (#1161)

The coordinator checker emits `operation:runtime_launch_timing` with `harness`,
`mode` (`idle` or `prompt`), and monotonic `launchRequestMs`. Its boundary is
`launch_request_to_response`: it includes server admission, host allocation,
bootstrap and setup, but **not** first-answer latency. A timing record alone is
not a lifecycle pass; retain the complete successful checker output as evidence.

Compare with a coordinator-recorded native launch using the same request/response
boundary, harness, snapshot recipe, region and idle/prompt mode. Record both server
revisions and cold/warm cache conditions; unlike conditions are not comparable.
Report `(runtimeMs / nativeMs - 1) * 100` in the parity PR. A regression above
20% needs an owner decision, not an automatic baseline update or a retry until
fast. No baseline is supplied by this script and no improvement is inferred.

Boat measurement is coordinator-only, on demand in production under the current
repository policy; it is not part of staging or the release gate. Do not allocate
another sandbox just to obtain timing. Capture the record during the already
authorized one-allocation lifecycle check. No worker measurement has been run.

### Production 2.29.0 forward-log regression (#1161)

The coordinator's Boat parity run on 2.29.0 timed out after send while fresh
`armada logs SANDBOX_UUID --all --json` could show finished turns. The 2.29.0 Boat adapter
advances a timestamp/row-ID cursor past a running prompt or partial response;
Boat can mutate that same row without changing its timestamp/ID. Later forward
reads therefore miss its terminal state even though a fresh history read sees it.
This is a cursor visibility defect, not a reason to rewrite prompt IDs:
`provider.prompt` returns Boat's `response.promptId`, and `normalizeEvent` maps
Boat's `taskId` to the common `promptId` (not the event row's `id`).

The fix is already on main in #1629 (`35730908`), **after** release 2.29.0:
opaque Armada continuations retain unfinished row boundaries/fingerprints, reread
changed snapshots, and continue paging the raw frontier. No extra native/runtime
switch, prompt lookup, smoke timeout increase or full-history polling is needed.
The provider regression now also covers 201 older rows before the active turn,
distinct event/turn IDs, count/byte-limited pages, terminal mutation, and reaching
the newest answer. It fails against the 2.29.0 adapter and passes on main.
This reproduces missed completion; it cannot establish from code alone why the
coordinator observed no matching queued/running event in that particular run.

Dashboard follow-up submission itself calls `send` independently of logs. Its
live conversation **does depend** on the same cursor contract: `sandbox-chat`
passes its retained cursor to the events route, which uses `gateway.logs`
(`logs` MCP tool with `since_cursor`). A missed terminal/partial update can leave
the displayed turn stale even though send succeeded. Status is fetched separately;
it is not evidence that the conversation stream delivered the answer.

After the next normal release containing #1629, the coordinator alone reruns:

```sh
bun scripts/post-deploy-smoke.ts --parity --only boat --production-boat
```

Require the send receipt's exact `promptId` on the observed finished prompt and
answer, follow-up/recall success, and normal stop/delete/cleanup. If still failing,
retain receipt ID plus cursor/page event IDs to distinguish ID mismatch from
pagination; do not infer a pass from historical logs alone. No worker provider
call was made, and Boat must never be added to staging/release acceptance.

### Frozen readable variables on Boat templates/routines

On the default runtime path, Boat template and routine launches deliver their
frozen readable-variable map through encrypted runtime enrolment. Codex and Claude receive the values in their
selected harness environment; the runtime also receives `readableVariables` for
its existing model-credential-free execution environment. No native variable
installation, new public flag or mutable-source lookup is used. Resume uses the
same manifest projection before the retained machine activates; source edits do
not change the admitted values. Native launches remain unchanged.

Authorized application-secret bindings use the shared encrypted runtime
configuration command after enrolment and before the first prompt. The runtime
receives the secret key names for redaction and delivers the values to the
selected harness. Manifests and bootstrap carry no application-secret values.
Invalid pins use the same vault conflict as Modal and Docker. Reserved keys,
mismatched account/provider/actor metadata and corrupted frozen manifests
also refuse.

Coordinator-only production acceptance after normal release: use the existing
Boat runtime-default server deployment and an existing Boat Codex or Claude
template with a non-secret readable binding (no secret bindings). Launch through
`armada template launch TEMPLATE_NAME_OR_ID --request-key probe_run_1 --org ORG_UUID`.
Substitute the template name or ID, a request key unique to this attempt, and the
organization UUID. Use ordinary send/exec to read the bound key
and confirm the exact admitted value. Change the source variable, stop the
sandbox, and wake it through ordinary send: the admitted value must be preserved.
Repeat for an existing routine referencing that template. Confirm launch logs
are `source:armada-runtime`. For a separate template with an authorized
disposable secret binding, verify the value in the selected harness by
comparison without printing it. Check that the raw value is absent from launch
receipts, logs and events. Revoke the disposable vault secret, then launch the
same pinned template revision with a new request key and confirm the vault
conflict before allocation. Use only existing authorized resources.
Boat stays outside staging and release acceptance.

### Repeating launch settings on Boat follow-up

Boat runtime `send` accepts explicit `model` and/or `reasoning_effort` only when
identical to the persisted launch settings. Omitted and identical settings produce
the same durable command, so retrying the same request ID without redundant
fields does not start another turn or overwrite a newer task. Actual changes
still refuse before command admission, and the locked account/model/effort checks
remain in force. No model/account switch or new conversation is enabled. Modal
admission is unchanged. Existing omitted-field clients need no changes.

Coordinator-only production check after normal release: on an existing authorized
Boat runtime Codex or Claude sandbox, use ordinary `sandbox/send` with a new
`request_id`, a short prompt, and that sandbox's exact persisted `model` and
`reasoning_effort`. Require a normal runtime receipt and a finished answer bearing
the receipt's prompt ID in `logs/read`. Replay the identical request ID/prompt
without the two redundant fields: require the same receipt and no extra turn.
A different model/effort must refuse without starting work. Do not allocate a
sandbox just for this check; Boat is never included in staging acceptance.

### Verifying the ordinary launch path

The coordinator checker accepts `--ordinary`. It checks runtime availability before allocation, then calls
ordinary `sandbox/launch` without `runtimeVersion` or `boatRuntime` opt-in fields.
A native receipt or non-runtime history fails the proof checks.
Timing output labels `launchPath:ordinary` so explicit opt-in evidence cannot be
mistaken for evidence of the ordinary default path. Without this flag the existing
explicit opt-in launch is unchanged.

Once the coordinator has authorized a normal production server deployment with
runtime selection, use existing credentials/snapshot/account, no new test resources:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --ordinary --idle --workspace --usage --resume
```

Use `ARMADA_RUNTIME_HARNESS=claude` with an existing Claude account for its
separately authorized check. Require idle readiness, first-send/follow-up answers,
setup before inference, archived `source:armada-runtime`, usage/cost evidence,
same-conversation recall under the new epoch and stopped history. The lifecycle
still uses one allocation and one retained-machine activation, no automatic
allocation retry. Add existing MCP/skills flags only with their real prerequisites.
Boat is coordinator-only/on-demand in production, never staging/release acceptance.
Record the release, deployment SHA, UTC date and evidence for ordinary launch,
follow-up, Git, stop and account counters.

### OpenCode on the shared Boat runtime (#2052)

OpenCode is admitted by the existing shared runtime launch, configuration, turn,
checkpoint and restore paths. Native Boat has no OpenCode harness alias and stays
unsupported. Apply `20261115071000_boat_runtime_opencode.sql` through the normal
release migration path and deploy matching server/runtime artifacts first.

Use `sandbox/launch` with `runtimeVersion:1`, `boatRuntime:true`,
`provider:"boat"`, `harness:"opencode"` and an authorized OpenCode account/model.
`launch/options.boatRuntime.opencodeVersion:1` advertises explicit runtime support.
The dashboard offers OpenCode when launch discovery advertises the harness and OpenCode runtime
support. Missing or older runtime support disables the choice with an
explanation. The launch action rereads server options before submitting the
ordinary launch, and the server enforces runtime admission.

Coordinator-only production verification after normal release: use an existing
OpenCode account and Boat snapshot, launch one runtime sandbox, send a prompt and a
same-conversation follow-up, then checkpoint/stop and resume it, requiring archived
runtime answers and remembered context. With the existing runtime-default server
setting, `post-deploy-smoke.ts --parity --only boat --production-boat --feature opencode`
uses the standard harness probe and refuses before allocation unless OpenCode
runtime support is advertised. Boat remains outside staging and the release gate.
No live provider check, migration application, deployment or default change was
performed by this worker.

### Custom model endpoints on Boat (#2051)

Custom Claude gateways and Codex Responses endpoints (including Morph and Azure)
use the shared Armada runtime on Boat.

The old refusal was a delivery-path restriction, not evidence of blocked Boat
egress: native Boat agent APIs do not consume Armada's endpoint descriptors.
Modal's runtime and Docker's runtime already parse those descriptors into harness
configuration. Boat now uses that same runtime machinery: empty fork environment,
encrypted enrolment carrying the key and endpoint descriptor, persisted model and
immutable runtime selection for subsequent turns. Keys are not put in Boat account
environment, public arguments or the snapshot. OpenCode support is described separately
above. Template application-secret delivery follows the same enrolled admission
and redaction rules described above.

Coordinator-only production acceptance after a normal release: with existing Boat
snapshot and Morph accounts, launch Claude and Codex through ordinary launch, verify
runtime history and a completed answer with the selected Morph model, then send a
follow-up and stop/delete the owned sandbox. Also verify an existing Azure or
custom gateway account preserves its base URL/model configuration. Inspect logs
for absence of credentials. Network reachability and real inference remain
unverified by offline tests. Do not add Boat to staging or release gates; Modal
and Docker keep their existing staging acceptance.


### Boat OpenCode dashboard acceptance (#2052)

Coordinator-only production check after normal dashboard/server release, using
existing authorized resources: on a server with OpenCode runtime support,
open a ready Boat snapshot, choose OpenCode and its usable
account/model, then launch. Require persisted `boatRuntime:true`, an archived
runtime answer and normal follow-up. No default flip is authorized by this check.
On an older or unavailable runtime, verify OpenCode is disabled with its reason.
The action rereads discovery before submitting the launch. Boat remains outside
staging and the release gate.

## Automatic OpenCode admission (#2105)

Coordinator-only production acceptance after normal release: plain-launch
OpenCode on a Boat snapshot with a Morph account and then an OpenCode-compatible
OpenAI account, require a reply and usage for each, and clean up both allocations.
Do not pass runtime flags or change the server default. Boat remains excluded
from staging/release gates. These are acceptance instructions, not live evidence.

### API-key model connection checks on running Boat runtimes (#2052)

The existing `sandbox/test-model-connection` API and `armada account test SANDBOX_UUID --model DEPLOYMENT_MODEL`
now support an already-running, owner-controlled Boat shared-runtime sandbox. No
start, resume, native Boat model API or SSH/exec fallback is used. Native Modal
checks retain their existing path. The dashboard now lists matching running Boat
shared-runtime sandboxes alongside Modal targets, with the provider named in the
selector. Native Boat and Docker connection checks remain unavailable.

Checks accept only sandbox ID, model and optional org: no key, endpoint, headers
or arbitrary prompt. The sandbox's pinned current account/version must remain
active and authorized. Only API-key accounts are accepted; OpenCode requires a
custom connection and one of its declared models, not a plan key. Subscription
credentials remain refused. Enrolled runtime health and the model-test command
are owner/account/binding fenced; the command pins the exact health epoch at its
first durable enqueue. Busy, checkpointing, stopped, revoked or superseded targets
fail closed. Pending commands fence idle checkpoint/stop, and guest execution is
exclusive. A check does not mutate lifecycle generation, create a conversation or
require the prompt-only generation handoff. Diagnostics use the existing closed
non-secret result schema, not upstream response bodies or private RPC errors.

Coordinator-only production acceptance, on an existing authorized running Boat
runtime after normal release: invoke the existing CLI check with its selected
API-key account and model; require a safe success or closed authentication/model
failure and unchanged sandbox conversation/generation. A stopped or native Boat
sandbox, another member, a rotated pinned account and subscription/OpenCode-plan
accounts must refuse without starting or resuming compute. The dashboard action
rereads user-JWT metadata, including immutable `boat_runtime` and
`stop_requested_at`, before calling the same API; it does not accept eligibility
from the form. No provider calls, deployment, default flip or migration application
were performed by this worker; these steps are not evidence of acceptance.


### Dashboard connection-check acceptance (#2052)

Coordinator-only production check after the normal dashboard/server release,
using existing resources: open Models → an API-key account → Test connection.
Require a matching owner-controlled Boat shared-runtime target to appear with
its provider and date, select its declared model and verify safe success or
closed authentication/model guidance. Existing Modal targets must remain usable.
Native Boat, Docker, stopping/stopped, foreign-owner/org and stale-account-version
targets must not be offered; a stale open form must be rejected after a stop
request or account change. No machine is started or resumed by testing. The
fixture UI check is not production/provider evidence; no real provider call or
deployment was performed by this worker. Boat remains outside staging and the
release gate, with no default or schema change.
