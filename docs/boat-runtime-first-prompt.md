# Boat runtime

Experimental, **default off**, ordinary Boat/Codex workers only. Selected launches
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
authorized org/golden/account and initial prompt. Select empty connections and
skip skill defaults. Ordinary `sandbox/launch` does not accept this selection;
there is no CLI launch flag. The versioned route fails closed on old servers.

The immutable `sandboxes.boat_runtime` decision is recorded at insert. Persisted
owner, model/account version, cwd and provider identity govern later routing;
never relabel native sessions or resolve a native provider when runtime identity
is missing. The compute-only host adapter exposes no inherited native agent or
model-auth lifecycle hooks. Bootstrap forks with `noEnv:true` and empty environment;
only ticket/public artifact metadata reaches private SSH stdin. Model configuration
goes through encrypted enrolment, not fork environment or host arguments.

Use the golden checkout as-is: no pull/init replay or native cwd/CLI probe.
Launch-time MCP/skills/helpers, managed-parent/toolbox access and unsupported
extras refuse before allocation. Steer, interrupt, exec, new conversations and
model/effort overrides are not supported on this lane. Follow-ups use the existing
conversation and launch model/effort. GitHub and remote MCP require explicit
runtime setup below, not native setup or launch defaults. Claude, readable-variable/
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
mapping and harness file hashes, then performs no-text native Codex thread restore.
Health must report verified `restoredFrom` evidence before one stable command is
admitted in the same conversation under a **new** epoch. Old binaries, lost disks
or empty state cannot silently start a fresh conversation.

Completed replay returns the original accepted receipt without another activation.
A fresh server can reconcile an already-live new epoch after restore-health checks.
Unknown activation/bootstrap before a live epoch is **not retried**; inspect/stop.
Failed owned dispatch requests cleanup; live uncertainty retains its bounded lease.
No general repair/rebind service or native fallback is implied.

## Explicit GitHub and remote MCP

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

For existing remote HTTP/SSE registry connections, call `runtime_mcp_refresh` or:

```text
POST /api/v1/sandbox/configure-mcp-runtime-v1
{"id":"SANDBOX_UUID","connections":["CONNECTED_MCP_UUID"]}
```

Select 1–32 connected IDs under current owner/member/org/personal authorization.
Existing bindings must match; this is not an editor for an established binding
set or arbitrary URLs/headers. Local pinned stdio MCP is not supported here.
Only sealed gateway capabilities reach Codex, never upstream grants. The safe
receipt identifies epoch/revision/connections/generated server names. Identical
input can reconcile delivery across server restart.

MCP configuration is fixed within an epoch. Definition/grant-generation changes
need checkpoint/stop/resume and explicit refresh; ordinary server-owned OAuth
access-token refresh does not. Disconnect/disable/membership revocation acts
immediately. Checkpoint intent and replacement revoke old leases, including on
older rolling-deploy replicas. Resume starts with empty MCP defaults; refresh in
the new epoch rather than trusting restored thread configuration.

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
- `ARMADA_RUNTIME_CREDENTIAL_ID`: authorized Codex account UUID.
- Optional `ARMADA_RUNTIME_MODEL`.

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

Prefer a combined check when also accepting GitHub/MCP, rather than allocating
separate test sandboxes. Set `ARMADA_RUNTIME_GITHUB_REPOSITORY` to an owner-accessible
golden repository (Git and gh required). For MCP additionally set connection UUID
`ARMADA_RUNTIME_MCP_CONNECTION_ID`, exact `ARMADA_RUNTIME_MCP_TOOL`, non-secret
`ARMADA_RUNTIME_MCP_ARGS_JSON` (default `{}`), and stable result substring
`ARMADA_RUNTIME_MCP_EXPECT` (not sent to the model). Choose read-only operations.

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
bun scripts/check-boat-runtime.ts --mcp --github --resume
```

This uses **one allocation, one resume activation, four prompts, two stops**.
Preflight all capabilities, registry health and GitHub access before allocation.
Epoch 1 teaches memory then explicitly configures GitHub/MCP and exercises both.
After checkpoint/stop/resume, the third prompt proves retained memory; current
GitHub status must initially be unconfigured. Refresh both under different new
epoch revisions; the fourth prompt must independently succeed at both operations.
Finally checkpoint/stop and read all four archived histories.

Require `resume:"verified"`, `githubAfterResume:"verified"`,
`mcpAfterResume:"verified"`; GitHub proof needs that fourth prompt's successful
read-only `gh api` command plus current revision and positive credentialRequests.
MCP proof needs that prompt's selected server/exact tool/exact JSON arguments,
successful result and expected substring. An earlier tool result or assistant
assertion is insufficient. `--github`/`--mcp` alone check only a running epoch.
Retain printed UUIDs on failure, stop known compute and reconcile, never create
or activate again to guess. These are acceptance procedures, not a statement that
all current deployed features or launch timing have passed.
