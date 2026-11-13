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
authorized org/golden/account and initial prompt. Skip skill defaults; remote
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
Steer, interrupt, exec, new conversations and
model/effort overrides are not supported on this lane. Follow-ups use the existing
conversation and launch model/effort. GitHub requires explicit runtime refresh
below; remote MCP prepares automatically
from launch bindings/defaults, never native setup. Readable-variable/
secret parity, usage/cost and subscription lifecycle acceptance are not established
by the model-only milestone.

## Follow-up and uncertain delivery

For a running sandbox, `POST /api/v1/sandbox/send` (MCP `send`) requires a stable
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
4. Resume the same VM/conversation into the next epoch. The first resumed prompt
   calls MCP and recalls memory, proving automatic new-epoch preparation.
5. Explicit GitHub refresh/check in prompt4; MCP works without a setup call.
   Checkpoint/stop and read all four histories and the same receipt.

Require exact answers/finished events from `logs/read.source:"armada-runtime"`,
complete checkpoint watermark=acknowledgedSequence, final `resume:"verified"`,
`githubAfterResume:"verified"` and `mcpAfterResume:"verified"`. GitHub proof needs
the current prompt's successful read-only gh command, new epoch/revision and
positive credentialRequests; old GitHub authority must initially be unconfigured.
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

- **Repository refresh, automatic GitHub initialization and golden init commands.**
  Ordinary native launch promises these, while runtime currently uses a saved
  checkout as-is. The default switch conservatively refuses this mismatch before
  allocation. **Every newly valid golden requires a repo, so all such ordinary
  Boat launches are currently refused in runtime-default mode.** The existing
  explicit snapshot-runtime endpoint is unchanged. This gate needs real repo/
  GitHub setup parity (or explicit owner approval of changed snapshot semantics),
  not a silent skip. The switch is preparation, not a usable production cutover.
- Idle launches with no initial prompt; current continuation requires an existing
  runtime conversation.
- Claude/OpenCode (current ordinary runtime admission is Codex-only), private
  scoped Armada-access launches, and requested helper capabilities.
- Templates/routines requiring native readable-variable or application-secret
  environment delivery; plain requests still traverse the runtime default policy.
- Pinned local stdio MCP; connected remote HTTP/SSE defaults remain supported.
- Legacy unbound model credentials; runtime requires an authorized bound account.

Other follow-on gaps, including automatic GitHub setup, native exec/git probes,
steer/interrupt, model changes/new conversations and related controls, remain
explicit parity work; unsupported runtime operations do not use native fallback.
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
git probes and stop must all pass. **Today the repo/init gate should refuse
clearly before allocating**, so the standard case cannot pass yet. Do not remove
that gate or relax the standard smoke to conceal remaining work, and do not
retry allocation after an ambiguous result. Roll back the server setting to
`native` for ordinary native launches; no deletion is authorized here.

Owner staging facts (12:38:43Z): Boat quota exhausted (`launch-runtime-v1`429),
no effective smoke golden/org/user default skills and no named MCP connection.
No live check or setting flip by this worker. Skills/MCP rows remain orange.

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
