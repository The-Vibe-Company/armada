# ONE Boat prompt through Armada runtime (#1161)

Experimental model-only snapshot launch, **default off**. This API path combines
existing immutable selection, private compiled bootstrap, encrypted enrolment,
Codex app-server, fenced command/event/auth bridges and archive history. No Boat
native prompt/event/auth lifecycle hooks are used for selected workers. Native
and Modal launches remain unchanged.

## Deployment prerequisites (coordinator only)

1. Apply merged schema including `20261112235447_boat_runtime_selection.sql`
   through normal staging migrations before deploying readers. Worker never
   applied a remote migration or deployed.
2. A normal Docker/Railway build now publishes both matching Linux/glibc runtime
   architectures and selected harness bytes in `ARMADA_RUNTIME_ARTIFACT_DIR`
   (default `/opt/armada/runtime-artifacts`), with build manifests in
   `/opt/armada/runtime-manifests/{x64,arm64}.json` (#1325). No separate publication
   step is needed for staging.
3. Set `ARMADA_BOAT_RUNTIME_MANIFEST=/opt/armada/runtime-manifests/x64.json` for
   the x64 Boat target (or the matching arm64 manifest for an arm64 host). This
   is a trusted server setting, never a client value. No setting means runtime
   launches are unavailable, not a native fallback.
4. Deploy this server and dependencies. `POST /api/v1/launch/options` advertises
   `boatRuntime.enabled:true` only with configured experimental launch policy.
   Existing runtime records retain read/cleanup routing even if new opt-in is
   disabled later. Matching compiled bytes are required before new launches.

## Exact API / ONE-launch check

With coordinator staging credentials supplied as environment (never argv/logs):

```sh
# Set ARMADA_URL (armada-server HTTPS origin, NOT the dashboard origin),
# ARMADA_TOKEN, ARMADA_RUNTIME_ORG (organization UUID, NOT its name/slug),
# ARMADA_RUNTIME_GOLDEN (existing snapshotted Boat golden name),
# ARMADA_RUNTIME_CREDENTIAL_ID (authorized Codex account UUID).
# Optional ARMADA_RUNTIME_MODEL chooses that account's available model.
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts
```

This preflights options, makes **exactly one** POST to
`/api/v1/sandbox/launch-runtime-v1` with `runtimeVersion:1,boatRuntime:true,
provider:"boat",harness:"codex"`, selected golden/org/account, empty connections,
skipped skill defaults and a unique literal-answer prompt. The versioned route
fails closed on old servers instead of silently accepting an unknown flag.
Normal `sandbox/launch` never accepts runtime selection; no CLI flag is added yet.

It requires BOTH `runtime.kind:"armada"` plus epoch/prompt receipt AND archived
logs with `source:"armada-runtime"`, that prompt's non-partial assistant answer
and terminal finished event. These fields come from validated runtime commands
and the encrypted fenced journal archive, not Boat's native runner mapping or
metadata selection alone. Then it requests stop once and confirms persisted
stopped state. No automatic launch retry. On unknown transport outcome inspect
existing allocations before any retry; no second start is safe just to probe.

Expected output: a safe JSON receipt with sandbox/prompt IDs, epoch, source and
answer verified, followed by compute-stop confirmation. No model tokens or
credentials are printed. This is the ONE-launch coordinator milestone proof,
not a claim the worker ran actual Boat inference or measured launch regression.

## Deliberate limits

Fresh ordinary Boat/Codex only, initial prompt required. Use golden checkout
as-is: no pull/init replay, GitHub setup, MCP, skills/helpers, parent/toolbox
access, steer/interrupt/exec or resume. Running same-conversation follow-ups are now
available through the fenced `sandbox/send` path described below. Unsupported extras refuse
before allocation. Work preservation/resumable checkpoint are explicitly not
claimed; user/TTL cleanup stops compute with an honest preservation note, never
native quiescence/capture. This is suitable for the literal-answer staging check,
not a general work-preserving coding lifecycle yet.

Scoped serving loads persisted owner/model/target and current membership;
management credentials stay server-side. Runtime prompt reads use the bridge;
stopped terminal status/history use the bounded archive. Native optional ports
are not inherited. Full Claude/MCP/GitHub/variables/stop-resume parity and
before/after launch-time measurements (>20% owner decision) remain programme
follow-ups after staging proves this base.

## Recovery and current staging gate

The first staging attempt acknowledged launch but archived no events. Offline
regression coverage identified initial activity completion revoking the newly
enrolled epoch when it advanced the observation lifecycle generation. Migration
`20261113023000_runtime_launch_epoch_handoff.sql` carries only that initial live
epoch atomically into the completed generation. Stop, replacement, failed launch
and membership removal still revoke it. Apply this new migration through the
normal coordinator deployment, never by the worker.

A server restart does not require a new Boat start or enrolment: session hashes,
epochs, commands and acknowledged event prefixes live in SQL; the running guest
keeps its SQLite outbox. WebSocket disconnect falls back to HTTPS. Tests cover
that transport fallback and stable command receipt replay, and reconstruct all
server-side session/event handlers after a committed upload loses its response:
the same live runtime retries, gets its ACK without duplicate archive/usage, then
uploads its terminal event. This is offline evidence, not a real redeploy smoke.

## Diagnostic gate for the second launch

Merge/deploy the epoch handoff and these diagnostics before the second start;
apply the handoff migration through normal deployment. The check now refuses
before allocation unless `launch/options.boatRuntime.diagnosticsVersion` is `1`.
Use the **armada-server** origin and organization **UUID** as above. The normal
image build publishes the newly compiled runtime; no manual artifact publication.

Server logs are fixed JSON lines with `event:"armada.runtime.stage"`, authenticated
logical `sandboxId`, epoch and one of:

| Stage | Evidence |
| --- | --- |
| `bootstrap_started` | Guest Node bootstrap began (ticket, not consumed). |
| `artifact_verified` | Guest verified cached/downloaded compiled runtime digest/size. |
| `enrolled` | Guest received its one-use exchange response and current session. |
| `harness_started` | Actual Codex app-server answered initialize, before turn output. |
| `first_event` | Guest journal batch committed to encrypted archive/usage; may be queued, not an answer. |
| `bootstrap_failed`, `runtime_failed` | Authenticated guest reported failure, fixed reason persisted. |
| `startup_failed_bootstrap`, `startup_failed_enrolment`, `startup_failed_readiness` | Server startup failed in that phase, including enrolment timeout. |

Progress reports carry only a fixed stage, never credentials, error text, prompt
text, model response or a client-supplied sandbox ID. Ticket reports stop working
on consumption/expiry/replacement; runtime reports require the current epoch.
Reports are best effort, bounded to three seconds, and not proof of inference.
`first_event` is logged after commit, not after merely receiving a request.

Bootstrap/runtime failure marks the sandbox failed and revokes its authority.
Startup errors retain a phase-specific safe `statusReason`. `logs/read` returns
`runtimeFailure:{status:"failed",reason:...}` even when no guest event could be
uploaded; following that failure does not query dead compute. This diagnostic is
**server metadata, not a fabricated journal event**. If a prompt had already been
admitted but has no archived terminal status, its status reads failed;
pre-admission failure returns a failed launch, not an invented prompt receipt. The one-launch check fails immediately on this
metadata, then attempts stop once. A failed sandbox retains its failed status and
reason after compute stops; cleanup requires its confirmed `stoppedAt` timestamp.
The no-retry rule still applies.

Expected success is unchanged: exact nonce assistant answer plus finished event
with `source:"armada-runtime"`, then stopped compute. Stage lines alone, or an
empty page with source metadata, are not success. Offline failure/replay coverage
is not a claim that the second real staging model turn has passed.

## Follow-up prompts on ONE live sandbox

The coordinator proved the initial milestone on staging after #1331: sandbox
`cdfb8f23-5932-48ea-9465-baa884104ab7`, nonce answer verified and compute stopped,
80 seconds end to end (2026-11-13). Do not repeat it just for diagnostics.
The next check combines initial + context-retaining follow-up in one allocation:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --followup
```

Use the same server origin, org UUID and authorized account inputs above, after
this follow-up slice and `20261113030000_runtime_followup_epoch_handoff.sql` are
merged/deployed through normal coordinator procedures. Preflight requires
`boatRuntime.followupVersion:1` before allocating. It teaches a random token in
the initial prompt, then calls `POST /api/v1/sandbox/send` with a fresh
`request_id` UUID and the existing `conversation_id`, asking for that token
**without resending it**. Both prompts must have distinct IDs, the same logical
sandbox/conversation/runtime epoch, exact expected assistant answers and finished
events in the Armada archive. Output adds `followup:"verified"`, the second
prompt ID and conversation ID. Before sending, it prints a safe request UUID/ID
receipt so an unknown response can be reconciled without a new request ID. Then stop the same sandbox once. No allocation
retry; this does not resume the already-stopped milestone sandbox.

The API/MCP `send` path requires `request_id` for runtime work. Retain it and
reuse **identical input** after an uncertain response: durable command replay
never creates a second turn, and replay of an older completed request does not
overwrite the latest task. An unresolved admission retains its lease, rather
than guessing that no work ran. A definitive post-admission refusal also keeps
the workspace fenced for inspection/stop in this narrow slice. Other request IDs are refused until it settles
or the owner stops/inspects it. Wait for the current prompt to finish before a
new send. Only the sandbox owner can send; current membership and active pinned
account/version are revalidated under membership→credential→sandbox→epoch locks.

Observation generations still advance around send admission/completion; only
that owned same-runtime activity carries the live epoch. Stop, expiry, account
version changes, membership loss and ordinary lifecycle replacement do not
become implicit resume. The runtime performs the final conversation-busy check.
No native host/provider credential or prompt hooks run on this path.

This first follow-up slice is running-only and model-only, with the existing
conversation and launch model/effort. New conversations and model overrides
refuse; stop/resume, GitHub/MCP, subscription acceptance and usage/cost proof
remain the owner's next ordered checks. The Boat native path is not deleted.
