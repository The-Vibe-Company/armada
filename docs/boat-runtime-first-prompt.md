# Boat runtime

Experimental, **default off**, ordinary Boat Codex/Claude workers only. Selected launches
use Armada's compiled runtime for prompts, journal/history and private model
configuration. Native Boat sessions remain native; Modal retains its existing
tunnel. There is no native-agent fallback after runtime failure and no migration
of existing native conversations. See [runtime operations](runtime-startup.md)
for artifacts, enrolment, transport, secrets and diagnostic checks.

## Enablement and launch

An authorized operator deploys the merged schema and matching artifact-bearing
server/runtime image through the normal process. Do not deploy or apply migrations
from a worker. Set trusted server `ARMADA_BOAT_RUNTIME_MANIFEST` to the matching
`/opt/armada/runtime-manifests/x64.json` (or arm64 on that architecture).
The normal image publishes runtime/harness bytes automatically; no manual copy.
Missing configuration means unavailable, not native fallback.

`POST /api/v1/launch/options` advertises `boatRuntime.enabled:true` when enabled,
plus capability versions for diagnostics/follow-up/checkpoint/resume/GitHub/MCP.
Preflight the versions required by your check **before** allocating. Disabling
new launches does not remove existing runtime read/cleanup routing.

Launch through `POST /api/v1/sandbox/launch-runtime-v1` with
`runtimeVersion:1`, `boatRuntime:true`, `provider:"boat"`, `harness:"codex"`,
authorized org/golden/account; the initial prompt is optional. Skip skill defaults; remote
HTTP/SSE MCP uses the standard `connections` selection or registry
`defaultForLaunch` defaults as described below. Ordinary `sandbox/launch` does not
accept runtime selection;
there is no CLI launch flag. The versioned route fails closed on old servers.

The immutable `sandboxes.boat_runtime` decision is recorded at insert. Persisted
owner, model/account version, cwd and provider identity govern later routing;
never relabel native sessions or resolve a native provider when runtime identity
is missing. The compute-only host adapter exposes no inherited native agent or
model-auth lifecycle hooks. Bootstrap forks with `noEnv:true` and empty environment;
only ticket/public artifact metadata reaches private SSH stdin. Model configuration
goes through encrypted enrolment, not fork environment or host arguments.

Use the golden checkout as-is: no pull/init replay or native cwd/CLI probe.
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
`request_id` UUID and the existing `conversation_id`. Only the owner can send;
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

Owner API `POST /api/v1/sandbox/checkpoint-runtime-v1` / MCP `runtime_checkpoint`:

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

Owner API `POST /api/v1/sandbox/resume-runtime-v1` / MCP `runtime_resume`:

```json
{"id":"SANDBOX_UUID","request_id":"OPERATION_UUID","runtimeVersion":1,"conversation_id":"EXISTING_UUID","prompt":"Continue the previous conversation."}
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

After runtime readiness, the owner calls `github_refresh` /
`POST /api/v1/github/refresh` with `{"id":"SANDBOX_UUID"}`. The private
`configureGitHub` command installs runtime-owned Git/gh identity and just-in-time
helpers, scoped only to golden repositories and the connected owner's GitHub App
access. No Boat prompt/exec/SSH credential setup is used. Private credential
delivery rechecks current membership, connection and runtime epochs.

`runtime_github_status` / `POST /api/v1/github/runtime-status` returns safe
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

Server `event:"armada.runtime.stage"` logs contain only authenticated sandbox ID,
epoch and fixed stages: `bootstrap_started`, `artifact_verified`, `enrolled`,
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

## Staging acceptance

Run only under coordinator authorization, no deployment in flight, with:

- `ARMADA_URL`: **armada-server HTTPS origin**, not dashboard.
- `ARMADA_TOKEN`: environment-only bearer; never arguments/logs.
- `ARMADA_RUNTIME_ORG`: organization **UUID**, not name/slug.
- `ARMADA_RUNTIME_GOLDEN`: snapshotted Boat golden name.
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
test sandboxes. Set `ARMADA_RUNTIME_GITHUB_REPOSITORY` to an owner-accessible golden
repository (Git and gh required). For MCP choose an existing connected HTTP/SSE
connection **already marked `defaultForLaunch` on staging**. Set its UUID in
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
product behavior switches. Offline SDK/native evidence is not real staging
model/MCP acceptance. Current deployed parity remains coordinator-owned.

## Single skills + MCP acceptance check

Remote HTTP/SSE MCP already uses the normal runtime launch/turn flow (#1407),
and default skills installation is merged (#1417). To accept these together,
use the staging inputs above and the same existing read-only MCP tool inputs:

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

Before allocation, skills are discovered through the shipped golden/org/personal
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
This procedure is not evidence of a staging pass or permission to flip defaults.

## Environment-wide Boat default switch (prepared, not flipped)

Trusted **server** setting `ARMADA_BOAT_AGENT_PATH=native|runtime` chooses the
ordinary Boat launch path. Unset means `native`; any other value fails startup.
Set `runtime` on **staging first**, through the normal operator deployment
process, not in the smoke client's shell. Ordinary API, CLI, dashboard, MCP
`sandbox_launch`, template and routine launches share the same Core launch
selection: no client flag/endpoint change. Modal/Docker selection is unchanged.
Runtime mode uses the image's matching `/opt/armada/runtime-manifests/<arch>.json`
(or the existing trusted manifest override); in runtime-default mode,
missing/invalid manifest metadata fails startup rather than selecting native. Valid
image-installed artifacts keep the explicit runtime route/retained sessions
available during rollback. Missing/corrupt runtime-only metadata does not prevent
native rollback from booting; explicit runtime bootstrap remains unavailable
until artifacts are fixed (never converted to native). `launch/options.boatRuntime.defaultPath` reports the ordinary selection.

Rollback: set the same server setting to **`native`** and redeploy normally.
Native code is retained. This changes new ordinary launches only, never converts
an existing runtime/native session or its conversation, and never retries a
failed launch on the other path. Existing template request keys retain their
recorded success/refusal; use the normal new-request policy for new work.

### Refused today / remaining parity (do not call this cutover-ready)

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

Remaining refusals:
- OpenCode on Boat, private scoped Armada-access launches, and requested helper
  capabilities. Claude support is merged separately; it is not implemented here.
- Templates/routines requiring native readable-variable or application-secret
  environment delivery; plain requests still traverse the runtime default policy.
- Pinned local stdio MCP; connected remote HTTP/SSE defaults remain supported.
- Legacy unbound model credentials; runtime requires an authorized bound account.

Boat resume now automatically reauthorizes connected GitHub access after verified
restore health and before MCP/inference, under the resume activity lease. Failed
preparation prevents inference; identical-request reconciliation does not activate
compute again, and an accepted prompt replay does not rotate GitHub authority.
Modal resume behavior is unchanged. No repository/init steps rerun.

Other follow-on gaps include model changes/arbitrary new conversations and the remaining scoped/binding/helper
features above. Public steer/interrupt/exec controls merged separately; use their
own acceptance gates, not this workspace check. Unsupported operations do not
use native fallback.
Do not interpret the switch or a merged PR as a staging pass for any missing row.

### Standard post-deploy Boat check

Once quota/resources permit, an operator sets the **staging server** setting to
`runtime` and deploys this revision through the normal process. Keep the existing
staging `ARMADA_URL`, environment-only `ARMADA_TOKEN`, and configured smoke cases.
Run **the standard smoke**, selecting one existing Boat case; no runtime-only API:

```sh
ARMADA_SMOKE_CASES="$(printf '%s' "$ARMADA_SMOKE_CASES" | jq '[.[] | select(.provider == "boat")][0:1]')" \
ARMADA_SMOKE=create_real_compute bun scripts/post-deploy-smoke.ts
```

Confirm `launch/options.boatRuntime.defaultPath:runtime`. A successful future
case must have persisted `boatRuntime:true` and archived
`logs/read.source:armada-runtime`, not Boat-native events; standard send/wait,
git probes and stop must all pass. Repository/init and idle launch/first send are implemented; the merged public
exec/git controls still need their own accepted evidence. Do not relax the standard smoke to conceal remaining work, and do not
retry allocation after an ambiguous result. Roll back the server setting to
`native` for ordinary native launches; no deletion is authorized here.

Owner staging facts (12:38:43Z): Boat quota exhausted (`launch-runtime-v1`429),
no effective smoke golden/org/user default skills and no named MCP connection.
No live check or setting flip by this worker. Skills/MCP rows remain orange.

## Repository/init runtime staging check

The operator-only workspace check reuses an existing golden recipe; no new
canary, branch, repository or secret input is required. With the same existing
staging Armada origin/token/org/golden/Codex account:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --workspace --resume
```

ONE allocation + ONE same-VM activation (two host starts), three prompts, two
stops; no allocation/activation retry. Preflight requires workspace-v1 server
support and reads the selected golden's repository/init counts before allocating.
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
repository/init staging acceptance remains pending. Idle launch/first send now has
its own check below; the remaining owned parity gates and Claude/cost/subscription
work remains with #1419/#1420.

## Cutover boundary

The [owner parity table](https://github.com/The-Vibe-Company/armada/issues/1161#issuecomment-6848248708)
is the live gate: converge production-used MCP/tools, skills, usage/cost,
subscriptions and Claude parity first. The owner flips staging, then production
only after accepted staging proof. Native Boat deletion is a separate PR after
one production day, not part of documentation consolidation. Do not add product
modes/compatibility layers or automatically port unused native-only features;
ask the owner which features are actually used. Modal keeps its existing tunnel.

## Claude acceptance (#1419)

The coordinator runs this **single** staging check with an existing Boat golden
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
Offline tests do not establish this staging result. No native fallback, new product
launch option, default-on switch or native-path deletion is part of this slice.


## Runtime controls acceptance (#1457)

Coordinator only, using the existing staging inputs and matching server/runtime
artifacts (no new migration or default switch):

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --steer --interrupt --exec --resume
```

This adds two control prompts and one synchronous exec to the same allocation.
It requires controls v1 before allocation, exact exec output, a running-turn
steer receipt with honest harness delivery, its exact replacement answer, and an
archived interrupted terminal event. Combine with the existing MCP/skills/usage
flags if accepting those in the same launch. No allocation retries. The
coordinator records the staging result in the #1161 parity table; offline tests
and this procedure are not evidence of a deployed pass.


## Automatic Boat resume GitHub acceptance

Coordinator only, after normal matching server/runtime deployment, using your own
production Boat sandbox resources when staging credit is unavailable. Use the
existing environment-only server origin, caller token, org, golden, bound model
account and authorized golden GitHub repository; no new credentials or flags:

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
normal `send` (omit `conversation_id`) opens one conversation, then follows the
same account, epoch, activity-lease and durable-command rules as later sends.
A competing first send cannot create another conversation. Reuse the original
request ID and identical payload after uncertainty; an accepted replay neither
starts another turn nor overwrites a newer task. Arbitrary new conversations
and model changes remain unsupported. Modal behavior is unchanged.

Coordinator only, with existing environment-only inputs and your own Boat
resources when staging credit is unavailable, after normal server/runtime
delivery:

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
