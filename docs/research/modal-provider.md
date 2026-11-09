# Modal provider: full boat.dev feature parity

Researched 2026-11-08 against Armada's current `Provider` and boat adapter,
Modal's official documentation, and official SDK source. This is research,
not an implementation or a completed cloud integration test.

## Conclusion

**Modal is a plausible infrastructure backend, but not a replacement for boat's
agent API by itself.** Its public SDK exposes machines, processes, files and
network access; Armada's contract additionally requires durable conversations,
prompt state, steering and structured cursor events. Those require an Armada
agent runner and durable control state. This conclusion is an architectural
inference from the two API surfaces, not a Modal product guarantee.
[Armada contract](../../packages/core/src/provider.ts),
[boat adapter](../../packages/provider-boat/src/provider.ts), [Modal API][sandbox].

Full parity is the acceptance target: both Claude Code and Codex, all currently
advertised boat capabilities, golden lifecycle, resume after stop, concurrent
conversations, synchronous/detached exec and durable event pagination. Lowering
capabilities is not full parity. Boat currently advertises Claude native steer,
Codex restart steer, interrupt/resume/parallel/reasoning/fast/partials/tool events,
and no approvals. [Current boat capabilities](../../packages/provider-boat/src/provider.ts).

Two material obstacles remain: Modal's documented **24-hour machine lifetime**
versus boat's accepted 30-day TTL, and the absence of a managed harness/conversation
layer in the inspected Modal SDK. Restoring a filesystem into a new sandbox is
not uninterrupted execution or restoration of the original provider ID.
[Modal lifecycle][lifecycle], [SDK source][sandbox-source].

## Confirmed SDK and authentication facts

- The official npm package is **`modal`**, exporting `ModalClient`; the inspected
  source package version is **0.11.1**. JS SDK 0.x is beta and minor releases may
  contain breaking changes. Pin and evaluate a specific release.
  [Package source][package], [versioning][intro], [release notes][releases].
- Bun **runtime support is documented**, alongside Node.js 22+ and Deno; ESM and
  CommonJS builds ship. This does not document `bun build --compile` support.
  Local session validation confirmed authenticated, read-only App lookup with
  JS 0.11.1 under Bun and a compiled macOS arm64 binary. Other target binaries,
  process streaming, exec and snapshots remain unverified. [SDK intro][intro].
- Source dependencies include `nice-grpc`, `protobufjs`, `cbor-x`, `long`,
  `smol-toml` and `uuid`. The client uses gRPC; direct use of Modal's gRPC API is
  explicitly not a stable public API. Do not bypass SDK gaps with private RPCs.
  [Package source][package], [ModalClient API][client].
- Explicit `tokenId` and `tokenSecret` constructor parameters are supported;
  environment variables and `~/.modal.toml` are fallbacks. Inject the resolved
  pair explicitly so Armada cannot silently use the machine's active profile.
  This last sentence is an integration recommendation. [SDK intro][intro].
- API tokens authenticate to a **Modal Workspace**; environments scope resources
  within the workspace. An Armada org is not automatically a Modal Workspace.
  Store connection/environment/app configuration explicitly and retain Armada's
  own visibility rules. [Workspaces][workspaces], [client configuration][client].

## Infrastructure mapping and exact gaps

| Armada requirement | Confirmed Modal support | Work needed for parity |
| --- | --- | --- |
| `createGolden` | App + Image + `sandboxes.create`; explicit env/secrets | Ship tools/runner image; omit credential injection and inherited model configuration |
| `snapshot` | `snapshotFilesystem({ ttlMs: null })` yields Image | Persist name, Image ID, owner, source, status, failure and creation time |
| `getSnapshot` | `images.fromId`; named Image lookup | Persist lifecycle status; a lookup is not Armada's asynchronous save job API |
| `deleteSnapshot` | `images.delete(imageId)` | Ownership checks, reference handling and fork-survival validation |
| `fork` | Create several sandboxes from same filesystem Image | Inject only launch credentials; initialize runner without copying conversations into a golden |
| `get` | `fromId` handle; `poll` reports exit | Registry supplies names, labels, timestamps, stopped state and rich failures |
| `list` | Running sandboxes, App/environment and all-tags filter | Durable stopped/history records, state filter, stable limit/cursor pagination |
| `exec` | Argument array, workdir, timeout, stdin/out/err, exit status | Shell wrapper, bounded output, timeout normalization and detached PID ownership |
| `stop` | Snapshot + terminate; create replacement from Image | Transactional lifecycle and stable logical identity; conversations/session files must persist |
| `delete` | Terminate machine; delete retained Images separately | Delete session storage, recovery snapshots and registry according to retention policy |
| Prompt/steer/interrupt/events | No matching managed agent API in inspected SDK | Build and operate the runner and durable prompt/event/session layer |

Table evidence: [Armada contract](../../packages/core/src/provider.ts),
[Sandbox implementation][sandbox-source], [Image implementation][image-source].
The rightmost column consists of integration conclusions, not provider features.

### Creation, identity, listing and retries

JS 0.11.0 made the next-generation sandbox backend the default; creation waits
for scheduling and may raise `ResourceExhaustedError`. The current source routes
ordinary `create()` and `list()` to that backend unless configuration disables
it (GPU creation takes another path). Older `experimentalCreate` reference text
saying V2 sandboxes cannot be listed is stale relative to this implementation;
do not use it as evidence that current `list()` cannot see them.
[Release notes][releases], [create/list source][sandbox-source], [configuration][config-source].

The source's list methods use internal timestamp pagination and return only
running machines (`includeFinished: false`). Public parameters have App,
environment and tags, not Armada's state/limit/cursor controls. `fromId()` builds
a handle; it does not resurrect a terminated machine. Persist logical metadata
and map it to the current physical ID when restoring. [SDK source][sandbox-source].

Named sandboxes are unique within an App and can be looked up by name; this
helps reconcile a possibly completed creation. No caller-supplied idempotency
key appears in inspected public create parameters. A name plus an Armada ledger
is a proposed reconciliation mechanism, not proof of exactly-once creation
across timeout, concurrent retry, termination and name reuse. Validate those
cases before declaring the existing `idempotencyKey` contract implemented.
[Creation/lookup source][sandbox-source].

### Exec and process control

`exec()` starts a process and returns a `ContainerProcess`; `wait()` returns its
exit status. Source parameters include `workdir`, `timeoutMs`, env and secrets.
The public object has streams and `wait`, but no public numeric PID, per-process
kill method or reattachment-by-exec-ID method. Its internal task/exec IDs are
private. Stopping a stream or waiting call is not evidence of remote process
cancellation. [Process reference][process], [process implementation][sandbox-source].

**Proposed implementation:** let the runner own process groups, numeric PIDs,
detached-job records and captured output. Invoke shell commands deliberately
with `bash -lc`, drain stdout/stderr together and bound retained output. Implement
turn interruption through the harness protocol or owned process group; never
terminate the whole sandbox to interrupt one concurrent conversation. Validate
remote timeout/kill and client-disconnect behavior rather than infer it from
`AbortSignal` cancellation in SDK internals. [Available exec surface][sandbox-source].

## Disk, goldens, stop and restoration

**Product requirement (user clarification): goldens belong to one sandbox
provider and are not portable across Boat and Modal.** Persist immutable provider
identity on each golden and snapshot reference. A fork must dispatch to that
provider; reject a mismatched provider before any remote creation. Updating a
configuration or switching the preferred provider cannot reinterpret a Boat
snapshot as a Modal Image. Rebuild a separate golden for the other provider.
Modal Image IDs and boat snapshot names remain opaque provider-owned references;
native named Images do not make cross-provider migration supported.

Filesystem snapshots are root-filesystem Images, excluding mounted Volumes.
The current JS option is **`ttlMs`**, not `persistenceTTL`: default 30 days from
creation, `null` retains indefinitely. Save returned Image IDs durably; a
filesystem restore starts a new machine. [Snapshot guide][snapshots], [JS source][sandbox-source].

Images support `publish(name[:tag])`, `fromName`, `fromId`, and deletion by ID.
Thus Modal now has native named Images, although Armada still needs ownership,
status, errors and source-sandbox metadata. Deletion is irreversible and does
not delete intermediate layers. Whether deleting a source Image leaves an
already-running fork unaffected must be verified against Armada's exact
`deleteSnapshot` promise. [Image API][image], [Image source][image-source].

**Recommended stop model (inference):** quiesce active writes according to a
defined policy, flush runner/session state, take an indefinite filesystem
snapshot, durably record its ID, then terminate. Report `stopping` until the
recovery reference is committed. On the next operation, create a machine from
that Image, reinject credentials and restart runner/harness sessions. A failed
snapshot must not be reported as a successful durable stop.
[Relevant snapshot/termination primitives][sandbox-source].

Exit snapshots are a separate **beta**: opt in with
`experimentalOptions: { enable_exit_snapshot: true }`, then call
`experimentalGetExitSnapshot()` after exit. They cover termination, entrypoint
exit, TTL, idle expiry and OOM, with a 30-day retention period. They exclude
memory/mounts and do not guarantee persistence through rare hardware failures.
They are useful recovery assistance, not a substitute for an indefinite,
verified stop checkpoint. [Exit snapshot guide][exit-snapshots].

Memory snapshots are **alpha**, have a fixed seven-day retention, and currently
terminate the source. Open TCP connections close; active exec prevents snapshot
and exec-launched background processes are not properly restored. Same-instance
placement constraints also apply. Do not base durable conversational resume on
keeping harness processes alive through these snapshots. [Memory snapshots][snapshots].

The 24-hour maximum lifetime is explicit; docs recommend filesystem checkpoint
and replacement for longer workloads. A rolling replacement could preserve a
logical session but introduces scheduling, network and active-turn interruption.
It cannot honestly promise an uninterrupted 30-day machine. [Lifecycle limits][lifecycle].

**Timeout-extension check:** the current JS `Sandbox` reference and pinned full
implementation expose no `setTimeout`, `extendTimeout`, `resetTimeout`, or
equivalent lifetime-update method. The source's `setTimeout` import is
`timers/promises`, used for client polling/backoff; it does not update the
machine's deadline. `timeoutMs` becomes `timeoutSecs` in the create request.
Exec/wait/snapshot operation deadlines and idle activity are distinct from
machine lifetime. Positive whole-second client validation is not proof the
server accepts more than 24 hours. [JS API][sandbox], [full source][sandbox-source].

There is therefore **no confirmed public SDK route to retain the same physical
Modal sandbox for 30 days**. The 30-day maximum belongs to the current boat
adapter, not an explicit cross-provider maximum in `Provider`. Options are an
explicit Modal-specific 24-hour rejection limit (reduced accepted TTL range),
an agreed logical-session rollover design (changed continuity/identity
semantics), or a separately verified Modal agreement/API permitting longer
machine lifetime. None is currently demonstrated as exact boat TTL parity.
[Boat validation](../../packages/provider-boat/src/provider.ts),
[contract](../../packages/core/src/provider.ts), [documented limit][lifecycle].

## Runner, durable conversations and security

Modal supports an entrypoint service, readiness probes and authenticated HTTP/
WebSocket access via `createConnectToken({ port })`. Token credentials contain
the URL and bearer token; the service receives verified caller metadata. This
is sufficient transport for a proposed runner API; it supplies no conversation
or prompt durability by itself. [Networking guide][networking].

The runner must own conversation-to-harness-session mappings, prompt receipts,
queued/running/final transitions, concurrent turns, interrupt and steer routing,
reasoning/model/fast validation, partial messages and structured tool events.
Store monotonic event IDs and replayable cursor history outside volatile
stdout. Persist harness session files as well as Armada mappings, and reconcile
in-flight turns after restart. These requirements derive from the
[Armada contract](../../packages/core/src/provider.ts); the inspected
[Modal SDK][sandbox-source] provides infrastructure rather than this layer.

Default sandboxes cannot access Modal resources and accept no inbound network
connections without explicit configuration. Explicit env/secrets are supported;
keep Modal management credentials outside the sandbox. Credential-free goldens
also require inspecting the base image, filesystem and harness home directories:
omitting `secrets` cannot sanitize credentials baked into an Image. This is a
security inference from snapshotting the filesystem. [Networking][networking],
[Image/sandbox source][sandbox-source].

### Interactive connect and SSH parity

Current `armada golden connect` prints a boat-specific shell fallback, while the
inspected PR #505 adds `Provider.sshKey()` returning `sshEndpoint` and `hostKey`
and uses a real OpenSSH executor with a pinned host key. Interactive
connect must therefore be an acceptance requirement alongside prompts; a Modal
exec stream alone does not establish compatible SSH behavior.
[Current CLI](../../packages/cli/src/run.ts),
[golden-builder PR](https://github.com/The-Vibe-Company/armada/pull/505).

Modal's `Tunnel` exposes `tlsSocket: [host, port]` and `tcpSocket: [host, port]`;
the latter throws unless an unencrypted TCP endpoint was configured. A TLS
tunnel terminates the outer TLS connection and forwards the underlying byte
stream; a plain SSH client cannot speak directly to that TLS socket without a
TLS wrapper. Modal's tunnel guide explicitly describes raw TCP forwarding for
an SSH server. This is transport, not managed SSH user/key provisioning.
[Tunnel API][tunnel], [source][sandbox-source], [tunnel guide][tunnels].

**Recommended design (inference, not exercised):** run `sshd` in the runner/base
image and implement the SSH-session operation in the provider/control service
(`sshKey` in the inspected PR, or its eventual successor). The CLI
generates a short-lived session key locally and sends only its public key;
the server checks Armada ownership, resolves Modal credentials, authorizes that
key inside the sandbox and returns scoped connection details plus the pinned
SSH host key. No Modal management token reaches the CLI. Session expiry/revoke
and golden snapshot preparation must remove transient SSH authorization and
exclude private host/session keys from reusable goldens.
[SSH public-key configuration][sshd-config].

Prefer an encrypted-port endpoint plus a TLS byte-stream helper in the Armada
binary, invoked through OpenSSH `ProxyCommand`, with TLS hostname/certificate
verification and SSH host-key verification. The helper needs only endpoint
metadata, not Modal credentials. This requires transport metadata/helper support
beyond the PR's current plain `host:port` executor. Alternatively expose `sshd` through an
unencrypted tunnel and use ordinary SSH on `tcpSocket`; SSH still encrypts its
own protocol, but Modal's inbound CIDR allowlist is explicitly not enforced on
unencrypted tunnels. Neither option has been integration-tested here.
[OpenSSH ProxyCommand][ssh-config], [tunnel behavior][tunnels],
[inbound restrictions][networking].

An authenticated WebSocket terminal using Sandbox Connect Tokens is another
possible user-facing shell, but it does not satisfy an API promising an SSH
session without changing that contract. Keep it a separate transport decision.
[Connect-token transport][networking].

## Validation gates before calling this full parity

1. Compile the pinned SDK into Armada's supported Bun binaries; exercise actual
   auth, gRPC streaming, exec, filesystem, snapshots and reattachment.
2. Prove Claude native steer and Codex restart steer, reasoning/fast validation,
   partial/tool events and simultaneous conversations with real harnesses.
3. Stop/restart with unchanged logical identity and resumed conversation; recover
   after server crash, TTL expiry, interrupted checkpoint and orphan creation.
4. Validate indefinitely retained golden Images, deletion with live forks,
   snapshot failures and credential-free image/session state.
5. Prove stable stopped/history listings, cursor replay, idempotent creation,
   detached PID handling, timeout classification and scoped process cancellation.
6. Resolve the 24-hour/30-day lifetime difference explicitly. Do not represent a
   capability downgrade or periodic replacement as proven equivalent behavior.

These are proposed checks. Only authenticated read-only App lookup under Bun
and compiled macOS arm64 was validated during this investigation; no cloud
resources were created. This research agent accessed no credentials.

## Implementation guidance for #510 and #513

This section is a proposed design, not an implemented or cloud-validated system.
It follows the complete acceptance scope in
[#510](https://github.com/The-Vibe-Company/armada/issues/510) and
[#513](https://github.com/The-Vibe-Company/armada/issues/513).

### Composition boundary and state ownership

The current server factory accepts only `providerFor(apiKey: string)`, resolves
boat credentials and constructs fresh adapters. The logs path separately does
the same. Providers cannot depend on an instance's in-memory map. Replace this
composition boundary with a server-side, authorized connection context carrying
provider ID, immutable connection reference, org, app/environment and injected
registry/runtime dependencies. Route launch, control/logs, MCP tools, cleanup
and resume through the same persisted provider binding. Do not select a provider
by guessing an ID prefix or silently falling back to another connection.
[Server composition](../../packages/mcp-server/src/serve.ts),
[HTTP provider factory](../../packages/mcp-server/src/http.ts).

Use PostgreSQL for the durable registry: logical sandbox ID, provider connection,
physical ID/generation, creation operation/name, phase/lease/fencing epoch,
checkpoint Image reference/watermark, timestamps/tags and redacted failure. Keep
physical generation history and retained-image references for reconciliation and
delete. Add schema via new migrations with explicit grants/RLS; service queries
must carry the existing visibility predicate because the privileged connection
bypasses RLS. Require a real transaction implementation for atomic operations;
the current `Sql.transaction` is optional but production `bunSql` provides one.
[Scoped SQL](../../packages/mcp-server/src/data.ts),
[SQL contract](../../packages/core/src/golden-store.ts),
[production transactions](../../packages/mcp-server/src/sql.ts).

Keep runner-local `bun:sqlite` state and harness session files beneath a defined
root-filesystem directory, for example `/var/lib/armada-runtime`. SQLite holds
request dedupe, prompt/conversation state, process ownership and an event outbox.
WAL plus transactions is a concrete restart-safe boundary; checkpoint the WAL
and close writers for an Image checkpoint. Do not put this WAL database on an
assumed shared/network filesystem. [Bun SQLite][bun-sqlite], [SQLite WAL][sqlite-wal].

For acknowledged events to survive physical machine loss, also persist them in
the service SQL ledger before exposing them as durable. Root SQLite plus a
future snapshot cannot guarantee that: exit snapshots explicitly have failure
cases. The runtime package can own the persistence/replication interface and
SQLite adapter; registry migrations and service integration belong to the
provider/integration slices. This is durability plumbing for existing Provider
operations, not a new agent scheduler. [Exit snapshot limits][exit-snapshots].

### HTTPS runner authorization and durable events

Run the runner as the sandbox entrypoint, with a readiness probe. Prefer
`createConnectToken({ port, userMetadata })` for server-to-runner HTTP; do not
also expose the runner port as an unauthenticated raw tunnel. The current token
parameters expose **no TTL or revoke operation**. Enforce runtime authorization
separately with a random per-generation key and expiring, request-bound grants
or signatures in a dedicated header. Do not assume Modal forwards its bearer
header unchanged. Verify sandbox/generation, protocol version, expiry, request
ID and body binding before mutation. [Token API/source][sandbox-source].

Only the Armada service holds Modal management credentials. The runner receives
its own generation key and an independently scoped append-only ingest grant;
neither is an Armada user bearer, encryption key or database/service-role key.
The service stores grant hashes or encrypted signing material, checks that the
generation is current and fences replaced runners. Metadata in Modal's verified
header can additionally bind logical identity, but contains no secrets. A
generation change rotates runtime/ingest grants and cached connect credentials.
[Verified metadata behavior][networking]; grant design is an Armada recommendation.

Runner state changes and outbox events commit together locally. An ingest
endpoint commits deduplicated events and prompt status in one SQL transaction,
locking the logical sandbox row while allocating its next sequence. Use unique
`(sandbox_id, generation, producer_sequence)` keys; acknowledgment loss replays
the same event without duplicate append. A plain database sequence without
serialization can allocate numbers in a different order from transaction
commit, allowing a cursor reader to skip late commits. Row-lock serialization
is the proposed remedy. [PostgreSQL locking][pg-locking].

Use a sandbox-bound opaque cursor encoding the committed sequence, independent
of physical IDs and process uptime. Read `sequence > cursor`, filter conversation
within that ordered query, request `limit + 1` for `hasMore`, and preserve the
input cursor on an empty page. Do not advance beyond unseen events on a full
page. Assign stable event IDs; redact before SQLite/outbox/SQL writes, including
tool output and errors. Read history from SQL while stopped. Existing outcome
and wait logic consumes prompt events and cursor progress, so synthetic "done"
or stdout-only replay would break behavior.
[Contract](../../packages/core/src/provider.ts),
[outcome](../../packages/core/src/outcome.ts),
[turn readers](../../packages/mcp-server/src/turns.ts).

Reserve request/prompt IDs transactionally before starting a model process;
retries return the existing receipt. Preserve conversation-scoped process groups
and an honest recovery state for a lost running turn. On runner-only restart,
verify process identity/start time rather than trusting a recycled numeric PID.
On filesystem restore, old process IDs are historical evidence, not live jobs.
Do not mark an uncertain prompt finished or silently start the same task again.

### Unknown creation, checkpoints and secret-free restoration

Reserve a logical creation operation and deterministic name under the immutable
Modal app/environment/connection; persist intent before calling `create()`.
Use leases and fencing for Armada writers. On timeout/crash, reconcile the same
name with `fromName({ includeTerminated: true })`, check tags/generation, and
record the observed ID/outcome. A single `not_found` is not proof an earlier
request cannot still complete. Keep uncertain outcomes pending and reconcile;
do not allocate a new name and create a duplicate. Name uniqueness helps for
running resources but does not prove caller-supplied idempotency across terminal
resources or late requests. This remains an actual integration test gate.
[Lookup/name semantics][sandbox-source].

Stop takes a fenced lifecycle lease, marks `stopping`, and bars new work. The
runner drains or explicitly interrupts active turns according to the eventual
stop contract, flushes harness sessions/outbox and records a checkpoint token
with the acknowledged event watermark. Wait for every owned writer, including
detached exec, to quiesce; merely stopping prompt submission is insufficient.
Then snapshot with `ttlMs: null`, durably record the returned Image/checkpoint
mapping in SQL, and terminate the old physical machine. Report `stopped` only
after verified termination. Resume under the same logical ID with a new physical
generation, matching checkpoint and fresh grants. [Snapshot primitives][sandbox-source].

There is no distributed transaction covering SQL and Modal. Persist phases so
recovery distinguishes snapshot-success/SQL-failure, recorded-image/terminate-
failure, and restore-created/registry-failure. A filesystem snapshot call returns
its Image ID only after completion; unlike create, it exposes no caller-owned
job ID for recovering a response lost after completion. Unreferenced Image
cleanup after that exact failure remains unresolved with the inspected public
API. Never terminate the source without a durably recorded recovery Image.
[Filesystem snapshot implementation][sandbox-source].

Build goldens before any model/session/SSH authorization is introduced. Keep
Modal credentials outside every sandbox; inject model/GitHub credentials only
when starting an active generation and avoid files/Image ENV layers containing
them. The existing GitHub helper reads `GH_TOKEN` at use time rather than storing
it. Drivers must persist conversation history without serializing environment,
headers, auth caches or raw request objects. Before checkpoints, remove runtime
auth files/private SSH host keys and flush only the intended durable data.
Filesystem snapshots offer no exclusion-list parameter, so arbitrary credential
files cannot be assumed absent or omitted automatically. Validate restored
Image config/environment and known harness auth locations on actual Modal;
the proposed filesystem hygiene is not yet proof of credential-free recovery.
[GitHub setup](../../packages/core/src/github.ts), [snapshot API][sandbox-source].

Remaining hard gates: real Claude/Codex driver parity; consistent disk checkpoints
with active processes; expired-machine disk recovery; snapshot deletion with
live forks; unknown create/snapshot outcomes; revocation/restart auth; and the
documented 24-hour physical lifetime. Expose a truthful infrastructure TTL limit
as required by #513 while retaining the full agent feature set.

## Coordinator lifecycle probe (2026-11-08)

A real disposable Modal sandbox under the dedicated `armada-provider-conformance`
App was created using the public JavaScript SDK and `python:3.13-slim`. An exec
wrote a checkpoint marker to disk and confirmed a synthetic environment marker.
The filesystem snapshot was restored into a second sandbox with no environment
injection: the disk marker survived and the synthetic environment variable was
absent. Both sandboxes were terminated and the snapshot Image deleted. The named
App remains available for subsequent conformance runs; no machine remains running
from this probe.

This validates a narrow exec/filesystem-restore path and environment isolation for
this fixture. It does not prove harness credential-file scrubbing, conversation
resume, runner/event durability, SSH, or full provider parity. The probe snapshot
used a one-hour retention for cleanup; indefinite golden retention remains to be
validated separately.

## Coordinator protected-HTTP probe (2026-11-08)

A second real disposable sandbox ran a minimal HTTP server through the public
SDK's `createConnectToken`. The HTTPS endpoint returned401 without the token and
200 with it. The proxy overwrote a forged `X-Verified-User-Data` header with the
metadata issued alongside the token, preserved an application-specific header,
and removed the incoming `Authorization` header before forwarding. Runner-layer
expiring grants therefore need a separate application header, rather than reuse
of the Modal bearer header. The sandbox was terminated after the probe. Tokens
remained in memory and were never printed or written. This does not validate
application grant expiry/revocation or the agent-runtime implementation.

## Sources

Official SDK source links below pin commit
`4791c5380981f6cdaa9096b088268d6005b1a1fa` (2026-11-08).

[intro]: https://modal.com/docs/sdk/js/latest/intro
[releases]: https://modal.com/docs/sdk/js/releases
[client]: https://modal.com/docs/sdk/js/latest/ModalClient
[sandbox]: https://modal.com/docs/sdk/js/latest/Sandbox
[process]: https://modal.com/docs/sdk/js/latest/ContainerProcess
[image]: https://modal.com/docs/sdk/js/latest/Image
[lifecycle]: https://modal.com/docs/guide/sandboxes#timeouts
[snapshots]: https://modal.com/docs/guide/sandbox-snapshots
[exit-snapshots]: https://modal.com/docs/guide/sandbox-exit-snapshots
[networking]: https://modal.com/docs/guide/sandbox-networking
[workspaces]: https://modal.com/docs/guide/workspaces
[package]: https://github.com/modal-labs/modal-client/blob/4791c5380981f6cdaa9096b088268d6005b1a1fa/js/package.json
[sandbox-source]: https://github.com/modal-labs/modal-client/blob/4791c5380981f6cdaa9096b088268d6005b1a1fa/js/src/sandbox.ts
[image-source]: https://github.com/modal-labs/modal-client/blob/4791c5380981f6cdaa9096b088268d6005b1a1fa/js/src/image.ts
[config-source]: https://github.com/modal-labs/modal-client/blob/4791c5380981f6cdaa9096b088268d6005b1a1fa/js/src/config.ts
[tunnel]: https://modal.com/docs/sdk/js/latest/Tunnel
[tunnels]: https://modal.com/docs/guide/tunnels
[ssh-config]: https://man.openbsd.org/ssh_config#ProxyCommand
[sshd-config]: https://man.openbsd.org/sshd_config#PubkeyAuthentication
[bun-sqlite]: https://bun.sh/docs/runtime/sqlite
[sqlite-wal]: https://www.sqlite.org/wal.html
[pg-locking]: https://www.postgresql.org/docs/current/explicit-locking.html

### Conformance namespace retirement (#668)

The historical shared `armada-provider-conformance` App
`ap-MQmau5HWSdX2t036SWIP7A` is now operator-verified stopped/Tasks0. Its previous
deployed/Tasks0 state was an idle namespace, not evidence of hidden compute.
Do not reuse that AppID. Future opt-in runs create newly owned per-run fixtures
and retain creation, exact resource/image cleanup and stopped-state readback
receipts; see [the tooling contract](../../packages/provider-modal/README.md).
Registered production Apps and unrelated resources must remain untouched.
