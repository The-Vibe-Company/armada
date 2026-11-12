# Own Docker hosts (#1165)

Design only; no Docker provider or host command ships in this PR.
Part of #1160; first audience is a single owner-trusted team, not hostile tenants.
Build execution slices only after #1161 makes the Armada runtime the sole Boat path.

## Current state (main at 4902861f; recount against the implementation base)

- `packages/core/src/provider.ts` owns lifecycle, harness capabilities, events and usage.
  There is no explicit resume method: a prompt may restore compute and return `resumed`.
- `packages/core/src/sandbox-provider.ts` admits Boat/Modal and pins Modal's target binding.
  Neutral resource IDs already exist; Boat compatibility columns must remain null for Docker.
- Modal's `packages/provider-modal/src/transport.ts` sends protocol-v1 requests to a runner.
  `packages/agent-runtime/src/main.ts` receives private bootstrap on stdin, serves runner
  requests and pushes journal events upstream; `protocol.ts` carries generation-bound grants.
  Boat still uses its native runner; Docker must not copy that path.
- `packages/core/src/golden-create-service.ts` uses pinned SSH for checkout and secret scanning.
  A host behind NAT cannot satisfy this server-to-host SSH assumption directly.
- Provider-name conditions remain outside adapters. On this base, a lexical count finds
  **197 comparison/case occurrences in 66 files**, not 154 semantic branches.
  Reproduce over `packages/{core,mcp-server,cli}/src` and `apps/dashboard/src`, TS/TSX only:
  count matches of `(===|!==|==|!=)\s*["'](boat|modal)["']`, its reversed form,
  and `case\s+["'](boat|modal)["']`; exclude provider packages and tests.
  This measures syntax (including SQL strings), not distinct decisions.

## Target and trust

One host-native daemon (binary, not a sandbox container) uses the local Unix Docker socket.
Neither Docker API nor runner/SSH ports are published; agent containers never mount that socket.
The daemon is host-admin-equivalent; the owner trusts it with sandbox data and credentials.
Ordinary non-privileged containers get CPU/memory/PID limits, no host mounts or host namespaces.
Linux first; optional `--runtime=runsc` requires an installed runtime and a compatibility check.
See [Docker security](https://docs.docker.com/engine/security/) and
[gVisor setup](https://gvisor.dev/docs/user_guide/quick_start/docker/).
No stronger isolation claim is made.

Proposed one-command registration/start, after installing the binary and `armada login`:
`armada host register --name team-linux --server https://STAGING_ARMADA_ORIGIN`.
This is a future CLI contract, not a currently runnable command.
An org admin authorizes registration through the control API; the local process generates
a random host token, submits only its hash, and saves the token in a host-only 0600 file.
Registration starts the daemon; a documented service install makes it survive reboot.
Token scope is one org/host and only job claim/result/heartbeat, never user APIs.
Rotation replaces the hash and disconnects old claims; revocation rejects jobs immediately.
No raw token is returned by an API, put in argv, logs, repo, golden or container environment.
Host records expose name, ID, last heartbeat, version, capacity and online/draining/revoked state.
Membership/RLS and existing private-resource access still gate all user operations.

## Outbound job and event path

Use authenticated outbound HTTPS long-poll claim/result/heartbeat endpoints on Armada.
No new inbound listener on the host; reconnect with bounded backoff.
A durable server job binds operation ID, host, sandbox, physical generation, deadline and input digest.
A claim has a lease and attempt fence; the daemon journals receipts before acknowledging work.
Retry/reconnect returns that operation's recorded result, not a second create/prompt/commit.
Unknown outcomes stay unknown until exact labeled container/image reconciliation; never infer
success, deletion or safe replay from a timeout or missing heartbeat.
Host re-registration is a new identity, not authority over old containers.

The host adapter forwards existing runtime protocol-v1 envelopes to an unpublished runner
on a private container network; grants still bind sandbox/generation/expiry.
Reuse runtime request IDs, safe error mapping, journal cursors and acknowledged event ingestion,
not Modal SDK objects or a second harness implementation.
Runtime events go outbound to the existing ingest path; reconnect replays unacknowledged events
with deduplication. Bounded local spool/backpressure prevents silent drops or unbounded disk use.
Host diagnostics are separate, redacted and bounded; never persist secret job bodies in receipts.
Sensitive delivery uses sealed server storage (`ARMADA_ENCRYPTION_KEY`) and authenticated
private stdin/bootstrap, not Docker `Config.Env`; host token never enters a sandbox.
Use #1162's model connections and #1163's harness-reported usage/cost path; do not rebuild them.
Unavailable usage stays unknown, never zero. OpenCode belongs to #1164.

## Images and lifecycle

- Pin golden and sandbox to immutable host ID; image identity is host + image ID, tag is a label.
  No cross-host migration, automatic rescheduling or registry is needed initially.
- Create a credential-free builder; reuse checkout/scan policy through a private stdin job
  transport instead of requiring public SSH. Refactor that seam without relaxing host-key
  verification for Boat/Modal; `sshKey` is unsupported on Docker, never a fake endpoint.
- Snapshot only a quiesced, scanned credential-free builder, then commit/tag its writable layer.
  Never commit a credential-bearing agent container. Rebuild a golden instead.
  [Docker commit](https://docs.docker.com/reference/cli/docker/container/commit/) excludes
  mounted volumes: repos/dependencies must be in the builder layer, not a workspace volume.
  Scrubbing a live sandbox is not sufficient proof that image ancestry is secret-free.
- Fork creates a container from the exact image with no inherited model/account secrets;
  bootstrap the common runtime privately and inject selected launch credentials only afterward.
- Stop quiesces/checkpoints harness state, then stops the container, retaining its writable disk.
  Resume starts that same container, establishes a fresh generation/grant and restores the
  conversation via the runtime; no process-memory checkpoint or transparent live-turn resume.
- Delete removes only exactly owned containers and per-sandbox state; snapshot retirement
  removes only unreferenced Armada images, never global Docker prune or an unrelated tag.
- Store an absolute TTL in server metadata and the daemon's durable local schedule.
  The daemon stops expired containers even when Armada is unreachable; no automatic restart policy.
  On daemon/host reboot reconcile and enforce expiry before starting any sandbox.
  A dead daemon cannot enforce a deadline: show offline/unknown, reject new work, and do not
  claim a stop/delete completed. Pending cleanup reconciles on reconnect; revocation triggers
  local stop on next contact, with manual host cleanup required if it never reconnects.

## Provider-neutral prerequisites and slices

Keep provider names for routing, immutable identity validation and compatibility-column writes.
Convert behavior selection only; do not mechanically replace every comparison.
Proposed infrastructure capabilities describe snapshot naming/provenance, builder restoration,
management authority/slot limits, private checkout transport and optional SSH support.
Docker has no public pinned SSH endpoint, cloud account, remote image availability or VM isolation.
Unsupported features (including orchestrator recovery until its proof contract is implemented)
must refuse explicitly; never advertise Modal recovery/attestation as Docker support.

| PR slice (each a fresh `codex/1165-<slug>`, Refs #1165) | Scope / deletion | Coordinator staging check after deploy |
| --- | --- | --- |
| 1: capability cleanup | Start with `core/src/golden-build-jobs.ts` (12), `mcp-server/src/control.ts` (15), `core/src/golden.ts` (9), `core/src/golden-snapshot-retirement.ts` (10); split further as needed. Delete name-selected behavior, preserve fencing, authority and legacy columns. | For Boat and Modal, create, snapshot, launch, stop and retire an org golden plus a private golden; existing permissions, receipts and cleanup must be unchanged. |
| 2: host + Codex | Add host/job storage, RLS, daemon and provider adapter; registration, launch/prompt/stop only. Use runtime-only path from #1161. | On NAT Linux with inbound denied, run proposed registration above; disconnect during launch and reconnect: exactly one container/turn, events continue; revoke host and new claims fail. |
| 3: goldens + resume | Add private builder transport, images, retention/TTL and harness usage integration; delete Docker reliance on SSH. | Build secret-free golden, launch, write a marker, stop, send to resume, verify marker/conversation, stop; disconnect control plane past TTL and verify local container stopped; reconnect and confirm receipt, tokens and deduplicated usage. |
| 4: Hosts UI + CLI | Register/status/drain/revoke, host selection in golden/launch, offline diagnostics; no parallel model/usage settings. | From dashboard on NAT host: launch, send, stop, resume by send, stop; tokens reported for each turn. Non-admin cannot register; offline host cannot launch; private sandbox stays private. |

This design PR needs no deploy: coordinator reviews the contracts and dependency boundaries.
Real-host lifecycle acceptance remains open until slice 4; coordinator owns those staging runs.
No provider columns/tables are renamed wholesale; migrations, if needed, are additive new files.
Boat native runner deletion belongs to #1161; model, cost and OpenCode work stays with siblings.

## Later

Hostile multi-tenancy/microVMs, automatic host failover, shared registries/image transfer,
Windows/macOS hosts, public preview tunnels, live process migration and orchestrator continuity.
