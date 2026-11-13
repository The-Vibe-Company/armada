# Docker hosts (#1165)

## Scope and current state

Design only; no host agent, provider, schema change or deployment in this slice.
The [owner decisions](https://github.com/The-Vibe-Company/armada/issues/1160#issuecomment-6819684687)
override earlier proposals. Build starts only after coordinator approval of order step 5.
Armada remains a launcher, not a workflow engine.

- `packages/core/src/provider.ts` currently combines machine and agent operations.
  `sandbox-provider.ts` already separates HOST_CAPABILITIES and PROVIDER_LIMITS.
- Boat runtime integration is still staged; Modal still has its tunnel.
  Read `docs/runtime-{dialout-client,command-bridge,websocket-bridge,event-ingestion}.md`
  and `runtime-{enrolment,bootstrap-cache,enrolled-bootstrap,readiness,startup}.md`.
  These describe implemented pieces, not proof of complete provider parity.
- Recipes remain in golden config; provider snapshot IDs and immutable Modal
  bindings are persisted separately. Never reinterpret a Boat alias as a Docker ID.

## Target split and trust

Host agent: machine lifecycle only. Runtime: prompt, steer, interrupt, events,
MCP, model/proxy, subscription refresh and usage. No host-level agent API.
Required machine contract: create from image/golden, run one command with private
stdin, persistent directory, outbound HTTPS, stop/resume and delete.
Optional declared capabilities: snapshot, fork and human SSH; fail explicitly if absent.
Existing required Provider snapshot/fork methods will need optional capability
admission before a backend lacking them is accepted; do not fake support.

An org admin registers a host against staging using a future one-command installer.
Registration exchanges a one-use, short-lived token supplied on stdin for a
revocable host credential scoped to that org and host (no model/DB authority).
Server stores only its hash; host stores its credential privately, never in logs,
argv, images or public API responses. Revocation stops new job admission.
Runtime enrolment is separate: reuse the existing single-use enrolment exchange,
fresh epoch at every start/resume, configuration fetched directly from server,
old epochs refused. Generalizing today's Boat-bound admission is later work,
not permission to weaken ownership/membership/lifecycle checks.

Run the host binary under a dedicated account with private state. Docker daemon
access is powerful even without root: this is owner-trusted, not tenant isolation.
Never expose Docker API or mount its socket inside sandbox/agent containers.
Prefer rootless Docker where available; coordinator verifies local compatibility.
Default runc; optional runsc only if installed and explicitly selected, never
silently downgrade. No privileged containers or arbitrary host bind mounts.

## Transport, artifacts and jobs

Reuse runtime WSS dial-out with automatic HTTPS long-poll fallback, heartbeat
20s (under 30s), and acknowledged event batches from its persistent journal.
Reuse `/api/runtime/artifacts/<sha256>`, pinned manifest/digest verification and
selected-harness-only install. Warm images cache artifacts, not credentials.
Only start/resume selects a new runtime version; never hot-swap a live process.
Bootstrap passes only server origin and single-use enrolment token on stdin.
Runtime talks directly to Armada, not through a host event/proxy service.
Tokens come from harness reports; server prices them; missing usage is unknown.

Host control also dials out; reuse transport framing/mailbox patterns, but use
separate host-scoped authority, jobs and routes, not sandbox runtime credentials.
Jobs contain stable ID, host ID, sandbox ID, generation, operation and bounded
input. ACK only after a durable local receipt; reconnect redelivers the same ID.
Duplicate IDs with different inputs refuse. Uncertain create/commit outcomes
require label/receipt reconciliation; never retry side effects with a fresh ID.
Host receipts report machine state/error only, not agent completion.
Server commands must not accept arbitrary Docker flags, mounts or image sources.

## Golden, lifecycle and cleanup

Golden = credential-free recipe built once per host; images never migrate by
pretending a different host's local image ID is available. Disposable builders
run checkout/init/secret scan before commit/tag. Publish immutable image ID only
after success, retaining uncertain builders until reconciled. No runtime/model
secrets may enter snapshots; a live agent container is not a golden builder.
Snapshot/commit does not capture mounted volume data: rebuild recipes or manage
explicit owned data copies, never claim commit alone preserves workspace volumes.

Launch creates a labelled container and owned persistent workspace; stop/start
retain that workspace and runtime journal. Stop revokes runtime authority first;
resume obtains fresh enrolment/configuration and verifies runtime readiness.
Delete removes only this installation's exact labelled resources after reference
checks. Label all containers, images and volumes with installation/host/resource
identity; reconcile exact IDs too, never broad prune or label-only deletion.
Host enforces persisted TTL deadlines locally even when disconnected; server
marks unreachable state unknown, not deleted. Expired jobs cannot revive a
sandbox. Offline cleanup remains pending until positive host reconciliation.
Uninstall first drains jobs, revokes host/runtime grants, then deletes only
owned unreferenced resources; preserve unrelated images, containers and data.

## Slices and verification

1. This design: coordinator reads it against the owner decisions. No deploy or
   real-host action required; `git diff --check` must pass.
2. Small independent capability cleanups: preserve Boat/Modal behavior, run
   affected unit tests and `bun run verify`; no provider-boat/runtime edits.
   After deploy coordinator repeats existing Boat/Modal golden build/rebuild,
   restore and stop/resume flows; same receipts, conflicts and cleanup as before.
3. Only after go: host agent + Docker placement, Codex lifecycle. Then goldens,
   resume, usage, Hosts dashboard and CLI. No speculative implementation now.

Inventory on the design's base: count literal `===/!== "boat"/"modal"` comparisons
(including identity/compatibility, not only replaceable branches):
golden-build-jobs.ts 4, golden.ts 0, golden-snapshot-retirement.ts 2, control.ts 17.
Reproduce with `rg -n '(===|!==) "(boat|modal)"' <file>`.
Earlier programme cleanups already removed many of the original ~154 branches.
Next: build admission's management revalidation becomes a declared capability.
Keep binding validation, credential routing, Boat compatibility aliases and
provider-specific request parsing explicit; they are identity, not host features.
Do not rename applied columns/tables or remove safety/provenance checks.
Delete replaced policy branches only; native Boat runner removal belongs to
#1161, Modal tunnel deletion to the owner's later order step, not this ticket.

## Coordinator-only real-host acceptance (future implementation)

Worker has no SSH access. On the owner's Linux x64 host (Docker 29, runc,
32 CPUs), coordinator runs `docker version`, `docker info --format '{{json .Runtimes}}'`
and records `docker ps -a`, `docker image ls`, `docker volume ls` before install.
Future PR must supply the actual stdin-only one-command registration syntax.
Using a disposable staging org/host: register, confirm online in Hosts, launch
Codex from dashboard, send a second prompt, stop, resume, send, stop.
Require persisted workspace/conversation, harness tokens per turn and no
inbound listener. Block WSS while allowing HTTPS: repeat via long-poll.
Disconnect host through TTL: confirm local stop and server unknown/pending
cleanup; reconnect, reconcile, delete. Revoke host token: new jobs refuse.
Uninstall and compare inventories: only labelled test resources removed;
unrelated workloads/data unchanged. Capture redacted receipts and digests,
never credentials. No host access or deployment is implied by this design.

## Later and owner questions

Later: multi-tenant hardening, stronger isolation, cross-host image distribution,
scheduling/HA and transparent host-loss recovery.
Owner decisions still needed: host credential expiry/rotation policy; default TTL
and offline retention window; host disk quota and resource admission defaults.
