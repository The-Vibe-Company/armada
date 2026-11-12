# Own Docker hosts (#1165)

Design only; no Docker provider or host command ships. Part of #1160.
The issue's **Binding design decisions** supersede the earlier draft and govern this document.
NOW: this design and small, no-behaviour-change host-capability cleanups only.
Docker host-agent implementation is order step 5: start only on the coordinator's instruction.

## Current state (baseline 4902861f; recount against each cleanup's fresh main)

- `packages/core/src/provider.ts` combines machine lifecycle and agent operations today;
  it has harness capabilities, but not the binding decision's declared host contract.
  There is no explicit resume method: a prompt may restore compute and return `resumed`.
- `packages/core/src/sandbox-provider.ts` admits Boat/Modal and pins Modal's target binding.
  Neutral resource IDs exist; Boat compatibility columns must remain null for Docker.
- `packages/provider-modal/src/transport.ts` sends requests to a runner through a tunnel.
  `packages/agent-runtime/src/main.ts` receives stdin bootstrap and uploads journal events;
  `protocol.ts` carries generation-bound grants. These are baseline facts, not the target.
- `packages/core/src/golden-create-service.ts` assumes pinned SSH checkout/secret scanning;
  a host behind NAT cannot satisfy direct server-to-host SSH without another transport.
- On this baseline, a lexical count finds **197 comparison/case occurrences in 66 files**,
  not 154 semantic branches. Reproduce over `packages/{core,mcp-server,cli}/src` and
  `apps/dashboard/src`, TS/TSX only: count `(===|!==|==|!=)\s*["'](boat|modal)["']`,
  its reversed form, and `case\s+["'](boat|modal)["']`; exclude provider packages/tests.
  This measures syntax (including SQL strings), not distinct decisions.

## Binding split and capabilities

The host supplies a machine; every prompt, steer, event, cost, model, proxy and MCP operation
belongs to the Armada runtime, never a host API. Docker's small host agent only manages
container lifecycle; it does not relay runner envelopes, ingest events or receive model keys.

Required host contract: create a sandbox from an image or golden, run one command with stdin,
a persistent directory, outbound HTTPS, stop/resume and delete.
Optional, explicitly declared by each host: **snapshot, fork, human SSH**.
A golden remains a recipe built once per host; it is not a portable snapshot requirement.
Snapshot/fork are optimizations only where declared; no fake SSH endpoint or inferred support.
Preserve current adapters' behavior and safety proofs when declaring capabilities; do not add
Docker routing, new capability semantics or a broad interface rewrite in a cleanup PR.
Provider names remain valid for routing, immutable identity checks and compatibility writes.
Authority, provenance, slot limits and recovery fences remain mandatory existing policy,
not optional capabilities that allow an adapter to bypass authorization.

## Runtime setup and transport (owned by #1161, not this lane)

One compiled executable per OS/arch (`bun build --compile`, glibc default); harness CLIs are
pinned by version/sha256 in a manifest, and only the selected harness is fetched.
Start/resume bootstrap verifies the digest and fetches missing artifacts from Armada;
pre-filled images are warm caches. The binary can install itself on shell-less images.
Version changes happen only at start/resume, never mid-life.

The host passes only a single-use enrolment token through private stdin, never model config
or credentials. The runtime fetches those directly from the server on enrolment and every
resume. Every enrolment opens a new epoch; older epochs are rejected. Refreshed subscription
tokens return to the server, which remains their owner. No secrets in argv, logs or goldens;
server persistence uses the existing sealed store under `ARMADA_ENCRYPTION_KEY`.

The runtime itself dials out: WebSocket commands with automatic HTTPS long-poll fallback,
keep-alive under 30 seconds. Events upload as acknowledged batches from its local journal.
No host relay, published runner port or second harness implementation is needed.
Codex app-server and Claude Agent SDK stay native; #1164 owns the ACP v1 OpenCode driver.
#1162 owns model connections; #1163 prices runtime-reported per-turn tokens on the server.
Missing usage/cost stays unknown, never estimated; Armada does not host a model proxy.
Modal moves to dial-out last (order step 6), deleting its tunnel then, not in this cleanup.

## Future Docker placement (step 5 only)

Owner-trusted Linux hosts first, unprivileged where possible; Docker management is a trusted
host-level authority. Never expose Docker API or mount its socket into an agent container.
Ordinary containers use resource limits and no privileged/host-namespace access.
Plain Docker is acceptable; optional `--runtime=runsc` requires installation and validation.
See [Docker security](https://docs.docker.com/engine/security/) and
[gVisor setup](https://gvisor.dev/docs/user_guide/quick_start/docker/).
The coordinator's test host has runc only and unrelated owner data; workers have no access.

Proposed future registration, after installing the binary and `armada login`:
`armada host register --name team-linux --server https://STAGING_ARMADA_ORIGIN`.
An org admin authorizes a host-scoped machine-management token, stored locally with mode 0600
and hashed server-side; never returned by APIs or passed into a sandbox. It authorizes only
container lifecycle jobs/status, not agent commands, user APIs or runtime configuration.
Host control dials out behind NAT; lifecycle jobs bind host/resource/generation/operation IDs
with durable receipts. Reconnect reconciles exact owned resources, never blindly replays an
uncertain create. This is separate from the runtime's command channel and enrolment token.

Persist workspace and conversation state across container stop/start; resume bootstraps the
runtime with a fresh enrolment/epoch. Runtime quiescence/checkpointing precedes host stop;
no process-memory checkpoint or transparent live-turn resume is promised.
Goldens are credential-free recipes built per host. If snapshot is declared, commit/tag only
a quiesced, scanned secret-free builder, never a credential-bearing agent container.
[Docker commit](https://docs.docker.com/reference/cli/docker/container/commit/) excludes volumes;
recipe builds must account for that rather than pretending a volume is part of an image.
Pin artifacts/disks to the host; no registry, automatic failover or cross-host restore initially.
Host-local absolute TTL stops expired containers without server contact; reconcile expiry
before restart. A dead daemon cannot enforce it: report offline/unknown, not successful stop.
Revocation rejects new server admissions immediately; local stop follows on next contact.
A permanently lost/offline host needs manual cleanup, not a fictional remote deletion receipt.

Label every created label-capable Docker resource (container/image/network/volume) with
Armada ownership, org/host/resource identity; journal exact IDs and host-owned file paths.
Cleanup requires labels plus receipts, not names alone; never global prune or unrelated tags.
Proposed `armada host uninstall` drains and refuses retained sandboxes/goldens by default;
explicit confirmed `--purge` stops/removes them, stopped disks and owned images included.
Shared/in-use images or uncertain ownership block completion, never widen deletion.
Remove only the host service, token, spool/state and owned resources after confirmed cleanup;
leave unrelated Docker data, files and the user's Armada login untouched. Retry is safe.
Revoke registration first when reachable. Offline local purge still works, but reports remote
revocation pending; keep server tombstones and instruct an admin to revoke via another client.

## Slices and coordinator staging checks

Each cleanup uses fresh `origin/main`, `codex/1165-<slug>`, its own PR and `Refs #1165`.
Stay out of `packages/provider-boat` and `packages/agent-runtime` (owned by #1161).
Do not mechanically replace provider names or weaken existing authority/retention proofs.

| Slice | Scope / deletion | Coordinator check after deploy |
| --- | --- | --- |
| NOW: declared host capabilities | Small PRs, preserving Boat/Modal behavior; inspect baseline hotspots `core/src/golden-build-jobs.ts` (12), `mcp-server/src/control.ts` (15), `core/src/golden.ts` (9), `core/src/golden-snapshot-retirement.ts` (10). Replace only behavior branches justified by the required/optional host contract, not identity/security checks. | On Boat and Modal, build an org and private golden, launch, send, stop/resume and delete; supported snapshot/fork/SSH paths and unauthorized/private refusals remain unchanged. Each PR narrows these steps to its changed behavior. |
| LATER: host agent/provider | Only after coordinator authorizes step 5; lifecycle-only host agent, per-host recipe builds, runtime enrolment and host selection/registration UI/CLI. Delete any need for host-mediated agent features. | On NAT Linux with inbound denied, register once, dashboard launch → send → stop → resume → stop; retained marker/conversation and reported tokens survive. Disconnect/reconnect during create: exactly one container. Offline TTL stops locally; unknown outcomes remain honest. |
| LATER: uninstall proof | Same step-5 work, not a prerequisite implementation for the current cleanup. | Seed unrelated container/image/network/volume and file sentinel; create running/stopped Armada sandboxes and a golden. Default uninstall refuses retained data; confirmed purge removes owned resources/service/token/state only. Sentinels remain usable/unchanged. Repeat offline: local purge succeeds, remote revoke stays pending; revoke via another client, old claims fail, repeated uninstall is safe. |

This design PR needs no deploy: review binding-decision alignment. Real-host acceptance remains
pending step 5; coordinator owns staging. No migrations here; later schema changes are new files.
Delete the superseded host-to-runner forwarding design, not Boat's native path (#1161) or
Modal's tunnel (step 6). No Docker-agent implementation starts without coordinator instruction.

## Later

Hostile multi-tenancy/microVMs, shared registries, failover, non-Linux hosts, public tunnels,
live process migration and orchestrator continuity. No speculative scaffolding for these now.
