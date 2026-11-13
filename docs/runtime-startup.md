# Armada runtime

The shared runtime owns harness commands, journal events and private model
configuration. Codex uses app-server; Claude uses the Agent SDK;
[OpenCode on Modal](runtime/opencode-modal.md) uses ACP v1. The enrolled dial-out
path currently selects Codex. [Boat runtime](boat-runtime-first-prompt.md) is
experimental and default off; [Docker placement](docker-host-daemon.md) is an explicit
preview. Modal retains its existing bootstrap/listener/authenticated tunnel.
Neither a successful build nor a synthetic protocol check proves real-provider
lifecycle acceptance.

## Build and publish

Use installed workspace dependencies and pinned Bun 1.4.2 on Linux x64/arm64:

```sh
bun packages/agent-runtime/build-compiled.ts
```

`packages/agent-runtime/dist/compiled/` contains the glibc runtime, manifest and
selected Codex archive. The manifest pins versions, architecture, byte counts,
SHA256 and the harness's complete regular-file inventory, including executable
bits. Codex resources retain their native layout. Credentials are never embedded.
The separate `build.ts`/native validation path still serves Modal.

The normal server Docker build runs `scripts/publish-runtime-artifacts.ts` and
publishes only x64 plus pinned harness/OpenCode bytes. The requestable architecture
list lives in `packages/agent-runtime/src/publication.ts`: current Boat goldens,
Modal apps and verified Docker hosts are x64. Launch policy composition rejects
unpublished architectures before allocation. Standalone arm64 builds remain
available for development, not server publication; native ABI validation is separate. Public
files are digest-named, read-only, and contain no configuration or credentials:

- `ARMADA_RUNTIME_ARTIFACT_DIR` defaults to `/opt/armada/runtime-artifacts`;
  an explicit empty value disables publication routes.
- Matching manifests are `/opt/armada/runtime-manifests/x64.json`.
- Public immutable `GET`/`HEAD /api/runtime/artifacts/<sha256>` serves those bytes.

Always select a manifest from the same deployed build. After deployment, HEAD
**and** GET each `runtime`, `harnesses.*.archive` and `opencode` descriptor:
require HTTP 200, exact Content-Length and matching SHA256. Do not add a manual
publication step to the normal image deployment.

## Installation and private startup

`armada-runtime install-artifact` reads non-secret metadata on stdin:

```json
{"serverUrl":"https://armada.example","cacheDir":"/private/absolute/cache","artifact":{"sha256":"<64 lowercase hex characters>","bytes":82273760}}
```

It returns a JSON path receipt without executing or replacing the running binary.
The cache must be private. Warm hits require size **and** digest; downloads use
fixed-origin HTTPS without credentials or redirects, a two-minute deadline and
512 MiB ceiling. Verification and atomic rename prevent partial executables.
Corrupt entries are repaired; interrupted downloads leave no published partial.

`install-harness` similarly reads `{serverUrl,cacheDir,harness:"codex",manifest}`.
It verifies target Linux/architecture and every extracted file's path, mode,
size and digest, rejecting links, extras and incomplete archives. Limits are
512 MiB per artifact/file, 2 GiB selected files and 4,096 files. Cold extraction
materializes selected files in memory. A fully verified extracted cache needs
neither HTTP nor a retained archive. Install/update only at start/resume while
old native work is quiescent, never during a live turn.

The trusted launcher holds exclusive launch/lifecycle ownership and supplies
only `{serverUrl,enrolmentToken}` to `armada-runtime dialout` on private stdin.
No ticket file, argv/environment secret or public runtime port is needed.
The single-use five-minute ticket exchanges at `/api/runtime/enrol`; a lost
exchange response requires a new **trusted** issuance after lifecycle
reconciliation, not automatic re-enrolment. Configuration is AES-GCM sealed with
`ARMADA_ENCRYPTION_KEY` while pending, cleared on exchange; tokens are hashes.
No user-JWT grants expose those rows.

Every fresh process, including resume, enrols again even with warm caches.
The response identifies sandbox, immutable epoch, runtime token and private
configuration. The server supplies `selectedHarness:"codex"`, the matching
artifact manifest and private root. Before journal/driver construction the
process installs/verifies the selected CLI, ignoring image CLI paths. Only its
driver gets credentials and the selected Codex PATH. Other harness-bearing
commands refuse; dial-out exec is not enabled.

`runtime-startup.ts` coordinates issuance, bounded host bootstrap and health.
After bootstrap the readiness budget defaults to 90 seconds (maximum 120).
Health must match the issued epoch **and** lifecycle generation; final authority
is rechecked before publishing ready. Bootstrap success alone means only spawned
process/stdin handoff, not enrolment or readiness. The lifecycle owner must fence
late work, mark failure and stop a failed allocation. It must not reissue a ticket,
retry a detached bootstrap or fall back to Boat's native agent on uncertainty.

## Dial-out authority and command reconciliation

Private requests use Bearer runtime token plus `X-Armada-Runtime-Epoch`, never
query credentials, cookies or ambient browser authority. Admission checks current
membership, owner, active unexpired persisted sandbox and epoch. Stop, failure,
replacement, deletion or membership loss revokes authority; re-adding membership
or resetting ready cannot revive it. Docker also requires its current immutable
host/installation and issuer fence. Short transactions lock memberships before
credential/host/sandbox/epoch work; no network call belongs inside those fences.

- `/api/runtime/channel`: WSS ready/ping/pong, 20-second heartbeat, eight-second
  connect/ready deadline and 30-second inactivity limit. Commands are at most
  1 MiB; client dispatch is serial, bounded to 16 queued commands. The server
  sends at most one unacknowledged command per connection. Invalid/overfull
  frames or disconnect switch that process permanently to HTTPS, keeping its
  epoch and IDs. Revocation closes 4401/4403 and tears down native work;
  transient drain uses 1012, not a new enrolment.
- `/api/runtime/poll`: `{epoch}` returns `{epoch,command}`. Empty polls hold up
  to 20 seconds without holding SQL locks; the client deadline is 25 seconds.
  HTTPS also validates `/api/runtime/session` every 20 seconds, independently
  of blocked native work.
- `/api/runtime/results`: `{epoch,requestId,status,body}` commits before ACK
  `{epoch,requestId}`. Lost ACKs retry before another poll. First results are
  immutable; old epochs cannot commit. Result envelopes are bounded at 2 MiB.

The encrypted durable mailbox redelivers original request IDs; it does not
promise exactly-once execution. IDs are unique per logical sandbox across epochs.
Retry only identical serialized input in the same epoch. Changed input or
cross-epoch reuse conflicts. Runner's local receipt/fence protects native side
effects, but a crash can still yield `request_outcome_unknown`.

Trusted `call` waits at most 120 seconds for command admission/result, **not**
turn completion. Abort/deadline ends the wait, not durable work;
`runtime_command_pending` requires reconciliation with the same ID. Never mint
another ID to retry uncertain side effects. New epochs do not adopt unfinished
old commands; active-owner readback labels them superseded. Validated health is
`{runtime:"armada",epoch}`; selection/health alone is not inference proof.

## Journal, history and subscription state

`/api/runtime/events` accepts at most 1 MiB/1,000 events, checking authenticated
sandbox/generation and common AgentEvent shapes. One persistent journal producer
sequence survives all epochs. Never reset an existing sandbox to an empty journal
or guess an offset; golden forks must begin with empty history.

Only a contiguous prefix commits. Identical replay after a lost ACK is safe;
conflicting replay rolls back. ACK follows encrypted archive **and** applicable
usage projection commit. Known harness counts remain known, missing values null;
private account/quota data is not usage. No age-pruning worker is implied.

Authorized archive reads work while stopped without compute. Pages identify
`source:"armada-runtime"` and use sandbox-bound `ar1_…` raw-sequence cursors,
including backward/coalesced/byte-bounded views. Native/foreign cursors refuse.
Filtering after bounding can produce an empty advancing page. Existing scoped
visibility and private-event filtering apply, with authorization rechecked after
decryption. Corruption returns fixed diagnostics, never ciphertext/raw errors.

Server-owned Codex subscriptions use `/api/runtime/model-access` to obtain
access-only token/account/plan/revision. No refresh token or stable guest capability
is exported. The broker owns refresh and encrypted state; authority is checked
again after network I/O. Clients register access tokens for redaction before
child delivery; 401/403 fences work, transient 503 does not revoke the epoch.
Legacy exclusive native holders alone may publish `nativeAuth` via events using
existing identity/CAS semantics. Such publication is not a checkpoint or host
stop proof; auth never enters the journal archive or usage.

## Validation

These local checks do not allocate provider compute:

```sh
ARMADA_DIALOUT_SMOKE=local_native bun scripts/smoke-runtime-dialout.ts
ARMADA_DIALOUT_SMOKE=local_native bun scripts/smoke-runtime-dialout.ts --http-only
ARMADA_RUNTIME_HARNESS_SMOKE=local_native bun scripts/smoke-runtime-harness.ts
```

On isolated Linux with Bun 1.4.2, build dependencies and openssl, expect compiled
health over WSS and HTTPS fallback, cold verified CLI installation, warm offline
startup, fresh enrolment per process and checkpoint/teardown. Fixtures are not
real model calls. The selected-harness smoke also checks actual Codex version and
app-server initialize. Foreign-architecture builds alone are not native proof.

The compiled model smoke is separately **billable**; supply a staging API key
through its documented environment, never argv:

```sh
ARMADA_COMPILED_SMOKE=create_real_inference bun scripts/validate-runtime-compiled.ts
```

Optional `ARMADA_COMPILED_SMOKE_MODEL` selects the model. Require COMPILED_OK,
reported turn usage and successful checkpoint. If cleanup cannot quiesce native
children, inspect/discard the isolated host rather than claiming it is clean.

Synthetic deployed protocol diagnostics require a disposable active Boat sandbox,
current member owner, no real work and secure environment:
`ARMADA_STAGING_DATABASE_URL`, `ARMADA_STAGING_ENCRYPTION_KEY`,
`ARMADA_STAGING_URL`, `ARMADA_STAGING_SANDBOX_ID`, `ARMADA_STAGING_OWNER_ID`.
They **replace runtime authority**; the event check also requires a fresh archive
and writes synthetic usage. Run only the needed diagnostic:

```sh
ARMADA_RUNTIME_ENROLMENT_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-enrolment.ts
ARMADA_RUNTIME_COMMAND_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-commands.ts
ARMADA_RUNTIME_SOCKET_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-sockets.ts
ARMADA_RUNTIME_EVENT_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-events.ts
```

Require one-use/replay rejection, stable command/result ACKs, WSS plus old-epoch
closure and duplicate-safe event/usage commit, respectively. Stop/delete the test
sandbox afterwards. The legacy publication diagnostic additionally needs a dedicated
exclusive staging subscription holder with no prompt:
`ARMADA_RUNTIME_NATIVE_AUTH_SMOKE=use_disposable_staging_subscription bun scripts/smoke-runtime-native-auth.ts`.
It republishes unchanged auth, not an OAuth refresh; normal stop/release/reconnect
cleanup is required and the holder must not be repurposed for real work.

Use the [Boat lifecycle check](boat-runtime-first-prompt.md#staging-acceptance)
for actual inference/continuity. Measure at least five matched native/runtime
cold, cached and resume launches, same golden/region/model/prompt: report artifact
bytes, install/readiness, launch-to-ready and first-event median/range. Installer
or bare-binary timings are not Boat baselines. A >20% regression needs an owner
decision; no synthetic check establishes production acceptance.
