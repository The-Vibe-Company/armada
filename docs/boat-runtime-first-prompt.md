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
2. Build matching Linux/glibc runtime/harness artifacts on the target architecture
   using `bun packages/agent-runtime/build-compiled.ts`. Publish only the public
   executable/archive bytes in `ARMADA_RUNTIME_ARTIFACT_DIR`, each named by SHA256.
3. Set `ARMADA_BOAT_RUNTIME_MANIFEST` to that build's trusted manifest.json on the
   server (not a client value). Its architecture selects the pinned host target.
   No setting means runtime launches are unavailable, not a native fallback.
4. Deploy this server and dependencies. `POST /api/v1/launch/options` advertises
   `boatRuntime.enabled:true` only with configured experimental launch policy.
   Existing runtime records retain read/cleanup routing even if new opt-in is
   disabled later. Matching compiled bytes are required before new launches.

## Exact API / ONE-launch check

With coordinator staging credentials supplied as environment (never argv/logs):

```sh
# Set ARMADA_URL (HTTPS origin), ARMADA_TOKEN, ARMADA_RUNTIME_ORG,
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
access, subsequent send/steer/interrupt/exec or resume. Unsupported extras refuse
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
