# Docker hosts and placement

Docker hosts support normal dashboard/API/CLI launch, follow-up and retained
stop/resume, plus host-local snapshot builds. See the
[user quickstart](own-machine-quickstart.md) for the current path.
Machine lifecycle is the dial-out host daemon; enrolment, health, prompt and
journal use the existing Armada runtime channel. No inbound host port, Docker
socket in the sandbox, agent host API, fabricated cloud snapshot or Boat
compatibility ID is needed. Boat and Modal are unchanged.

This reference also retains historical plain-image preview procedures. Their
Codex-only, no-snapshot and no-resume limits describe that preview slice, not
the current normal launch path. Use server launch discovery for enabled harnesses;
later sections describe normal follow-up, snapshots and capacity.
These procedures do not assert deployed acceptance. Workers do not receive host
SSH/staging credentials, deploy or apply migrations.

## Staging prerequisites (coordinator only)

Deploy the merged revision through the normal process, with its existing migrations
(including the already merged Docker schema/mailbox/bound-job and runtime fences).
The normal server Docker build
already publishes the compiled runtime, Codex archive and manifests. Set explicitly:

```text
ARMADA_DOCKER_HOSTS=1
ARMADA_DOCKER_PLACEMENT=1
ARMADA_DOCKER_RUNTIME_MANIFEST=/opt/armada/runtime-manifests/x64.json
```

The coordinator reference host uses Linux x64 and Docker 29/runc. The manifest must be
from the **same deployed server build** as `/api/runtime/artifacts/<digest>`.
Other supported installations may choose the arm64 manifest on an arm64 host;
there is no scheduler/automatic architecture detection. Manifest/origin/architecture
are server deployment inputs, not request fields. The image must match that ABI and contain working HTTPS CA roots.
The smoke uses the official Debian-based [buildpack-deps curl image](https://github.com/docker-library/buildpack-deps/blob/master/debian/bookworm/curl/Dockerfile),
whose recipe explicitly installs ca-certificates; a bare Debian slim image lacks that guarantee.
The server needs its normal encryption key and model-account configuration.
Use an org-admin Armada bearer and an active Codex-compatible account ID/version
that bearer can use (user-owned or this org's). API key/custom endpoint and the
existing Codex subscription broker are reused; no provider credential is a model key.

Defaults pending later owner decisions: host credential has no expiry and is
revocable; default sandbox TTL is the existing four hours; no disk quota. Ordinary
owner-trusted Docker only. The historical plain-image preview excludes snapshot
builds, resume, gVisor and multi-tenancy. That preview admits **one native conversation per sandbox**, with explicit follow-up prompts
using the returned conversationId. Retries reuse the same request UUID and input;
a new request without that conversation or for another conversation is refused.
Wait for the previous turn's acknowledged finished event before sending a follow-up.
Unresolved RPC admission blocks new requests; the runtime owns busy-turn refusal.

## Dashboard availability

The dashboard contains a Hosts page, admin add/revoke dialogs and a launch form
for an online host: supported agent, usable account, model/effort and optional
task. Armada chooses the image; users never type or choose a base image.
It acts as the signed-in viewer through server-side control calls;
registration tickets are shown once, never stored/logged. Launch keeps a stable
request key for identical choices after an unanswered request, rather than
allocating again blindly.

With `ARMADA_DOCKER_HOSTS=1`, the server now supplies bearer-only
`POST /api/v1/docker/hosts/list` with `{org}` for current members. The dashboard
uses that same signed-in user's bearer from server actions, without forwarding
browser Origin or using a Supabase service key. Without the opt-in the routes/page
remain absent. Admin register/revoke stay admin-only and registration tickets
are shown once, never stored/logged.

The list returns `placement` and safe `hosts` metadata: id, name (currently null),
state, createdAt, lastSeenAt, revokedAt and retained non-deleted sandbox count.
Pending means unregistered; online requires current registration/issuer membership
and a heartbeat within 60 seconds; otherwise offline, with revoked taking priority.
Online is not scheduling eligibility, capacity or runtime readiness. SQL current
membership scopes every list; no credentials, token hashes or installation secrets
are returned and no direct user-JWT host-table grant is added.

`POST /api/v1/launch/options` adds typed `providers` entries with id, enabled,
launchSources, harnesses, capabilities and English unsupportedReasons. These are
installed-feature discovery, not authorization or account health. With all three
staging inputs above and a valid installed runtime manifest, Docker advertises
`capabilities.launch:true` and the host list advertises `placement:true`.
Host-only opt-in retains normal list/status/logs/stop/delete without admitting new
placement. A request field cannot enable placement. Docker is a host-bound
source with no fabricated Boat alias; golden providers
remain Boat/Modal. The explicit preview API below is unchanged.

### Normal dashboard/API/CLI launch

`POST /api/v1/sandbox/launch` accepts the existing dashboard body:

```json
{
  "org": "ORG_UUID",
  "provider": "docker",
  "hostId": "HOST_UUID",
  "harness": "codex",
  "credentialId": "MODEL_ACCOUNT_UUID",
  "requestId": "FRESH_SANDBOX_UUID",
  "visibility": "private",
  "model": "gpt-6.1-sol",
  "reasoningEffort": "medium",
  "prompt": "Reply with exactly DOCKER_OK."
}
```

The account's current version is resolved and frozen on first admission; optional
`credentialVersion` must match if provided. `prompt` and `ttlSeconds` are optional
(default TTL four hours, maximum one day). The example selects Codex; the launch
dialog offers the harnesses advertised by the server. Armada selects the environment, or the user selects a host-local
snapshot with `--golden SNAPSHOT_UUID` (the retained flag spelling, not a cloud
golden). Boat/Modal snapshots and machine-size policy do not apply.
The server composes durable create, existing enrolment
and artifact bootstrap, runtime health and first-prompt admission. It returns the
existing `DockerLaunchResult`: `sandbox`, null `golden`/`helper`, unavailable
`github`, `runtime:{kind:"armada",epoch}`, TTL/expiry and optional native
`promptId`/`conversationId`. Admission is not completion: read the answer through
normal `/api/v1/logs/read` and status through `/api/v1/sandbox/detail`.

`requestId` is the logical sandbox ID and durable replay key. Identical retries
resume the original phase IDs; changed input conflicts. Store this UUID before
launch. A timeout is an unknown outcome, not permission to allocate a replacement.
The request and receipt are encrypted in a service-only ledger; no model secret
is copied into it. A completed retry returns its original admission receipt with
current sandbox metadata (even after stop/delete), never restarts the sandbox.

The API-only CLI uses the same normal route, not the private preview. Normal
API requests, CLI launches and dashboard forms do not accept an image selector.
Armada chooses the official image pinned by the deployed server's release;
source/dev builds without a release pin use the server-owned immutable bootstrap
baseline. Users may instead select their own host-local snapshot. See
[official image policy](official-sandbox-image.md#slice-2-normal-launch-policy).
The server freezes the admitted image for exact request retries, including
retries across a release upgrade; clients must not send an `image` field.
The host automatically fetches a missing image. The dashboard shows preparation
progress, and a failed fetch is reported in plain language.

```sh
bun run armada launch --provider docker --org "$ARMADA_ORG" \
  --host "$DOCKER_HOST_ID" \
  --credential-id "$ARMADA_CREDENTIAL" --request-id "$REQUEST_ID" \
  --agent codex --json 'Reply with exactly DOCKER_OK.'
```

Normal follow-up and retained stop/resume are available; see
[the current contract](#normal-follow-up-and-stopresume-1422). The private
preview's explicit same-conversation follow-up is a separate historical path.

### Coordinator acceptance: normal launch on the existing host

Deploy this revision and its new `docker_launch_requests` migration through the
normal staging process, with the three flags above. No new host binary is needed
for this server-side composition. Keep the daemon stopped before running; the
helper starts it and never removes a lock. Reuse the passed-check SSH alias,
staging org/account and image (these are public IDs, not credential values):

```sh
export ARMADA_STAGING='https://armada-mcp-staging.up.railway.app'
export DOCKER_HOST_ID='70bde9cd-36c9-40af-b15e-65b2f9d3c2a2'
export DOCKER_IMAGE='buildpack-deps@sha256:58021c2a0204361b62a23d2e0244d144d74c29af2d678e2a1f7e6611885d6949'
# DOCKER_SSH, ARMADA_ORG and ARMADA_CREDENTIAL: use the previous passed check.
read -r -s -p 'Staging org-admin Armada bearer: ' ARMADA_TOKEN; printf '\n'
export ARMADA_TOKEN
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_STAGING" --org "$ARMADA_ORG" \
  --credential "$ARMADA_CREDENTIAL" --ssh "$DOCKER_SSH" --image "$DOCKER_IMAGE" \
  --host-id "$DOCKER_HOST_ID" --start-host --normal-launch
unset ARMADA_TOKEN
```

Expected: launch/options enables Docker launch, and the dashboard's Docker dialog
can submit unchanged. The helper starts the same registered daemon, sends one
**normal** launch request (no private launch/bootstrap/prompt calls), confirms
normal list/status/logs show this sandbox, observes `DOCKER_OK`, a finished turn
and reported tokens, then normal stop/delete ACKs. It prints
`PASS: normal Docker launch route created, bootstrapped and admitted one prompt; list/status/logs/answer/stop/delete confirmed.`
The host remains registered/running. Compare container/volume inventories with
the baseline; no prune, registration replacement or worker host access.

## Installing through the CLI

On the Docker machine, `armada host install --server https://ARMADA_ORIGIN`
reads the five-minute, single-use registration token **only from stdin**. It needs
no Armada login or organization selection. Use the one-line command from
`armada host add` or the dashboard rather than putting a token in CLI arguments.

The bootstrap prefers `bun x --bun`, then `npx -y`, pinned to the server's
exact published Armada version (not `latest`), retains the standalone no-Node
fallback and offers an optional global CLI installation. The `--bun` flag lets
Bun-only machines run the npm launcher's Node shebang. The bare globally installed
`armada` launcher requires Node; Bun-only users can use `bun x --bun` instead.

The CLI fetches the public `/api/docker-host/install.json` manifest and the
selected Linux x64/arm64 artifact from the same HTTPS origin, rejects redirects,
checks SHA-256 **before execution**, then atomically installs
`~/.local/bin/armada-docker-host`. Installation paths must not contain symlinks.
The separate binary owns Docker checks, registration and systemd user-service
installation. The CLI waits up to 60 seconds for a connected status; timeout is
not permission to exchange another registration token blindly.

Re-running reports the existing host ID, version and connectivity. Registered
hosts keep their registration while a verified temporary host binary upgrades the
managed executable in place and updates its ownership digest. Upgrade never exchanges
or deletes machine credentials. An interrupted executable replacement leaves a pending
digest in the private marker so validation accepts either the old or new verified
bytes; retrying upgrades reconciles it. The existing user service is restarted and
gets the same bounded reconnect wait.

A fresh registration token can cancel its own unused ticket and resolve an existing
registered host's name through `POST /api/docker-host/reuse-registration`. It cannot
read or alter another owner's or organization's machine. The response contains only
host ID and name; no long-lived machine credential is read by the CLI. The canceled
ticket disappears from the list, allowing `host add` to stop waiting. Expired unused
registrations are hidden too; registered/offline and revoked host records remain.
If cancellation or name lookup is unavailable, local registration is preserved,
the ticket expires naturally, and the installer gives Ctrl-C/list guidance.
Unregistered binaries without retained installation files can be replaced;
unreadable or partially registered state is preserved for diagnosis.

`armada host status` prints public local status; `armada host uninstall` delegates
to the separate binary's drain/revoke/removal procedure. Both work without login.
Uninstall can wait for active sandbox cleanup and must be retried, not bypassed,
if drain is unresolved. Native diagnostic output is not relayed by the wrapper;
run `armada-docker-host status` or `armada-docker-host uninstall` directly when
repairing local service or ownership problems. Never delete registration state or
force-clear a daemon lock to make installation succeed.

## Host authority, ownership and failure recovery

An org admin obtains a five-minute single-use capability from
`POST /api/v1/docker/hosts/register-token` with `{org}`. The host exchanges it at
`/api/docker-host/register`, binding its installation; only hashes persist on the
server. The private host credential has no expiry but is revocable, and its issuer
must remain a member. Lost registration response needs inspection/new admin
issuance, not a blind exchange replay. `ARMADA_DOCKER_HOSTS=1` mounts registration,
poll/results and owner APIs; host authority never authenticates user/runtime APIs.

Run the compiled daemon under a dedicated owner-trusted account, using private
0700 state directories/0600 files and a service manager when unattended:

```sh
armada-docker-host register --server https://armada-mcp-staging.up.railway.app --state-dir /absolute/private/armada-host
# One-use registration capability on stdin, never argv.
armada-docker-host run --state-dir /absolute/private/armada-host
```

Jobs persist before side effects and redeliver the original request ID until
completion. Changed input under that ID refuses. After restart, pending work
requires current server redelivery; offline/revoked hosts may sweep TTL but cannot
start pending creates. A stale exclusive `daemon.lock` must be removed only after
verifying no daemon remains; never remove it to force concurrent startup. Receipts
are not pruned automatically. Upgrade the host binary before sending new job
formats; old strict binaries refuse unknown bootstrap/deadline envelopes safely.
Upgrade **all server replicas before creating bound work**. Do not roll back
while bound work remains queued: old readers deliberately refuse its envelope.

The daemon controls only exact-owned containers and named volumes. Identity binds
installation, host, sandbox and generation, not name or label alone. Images are
digest-pinned. No arbitrary Docker flags, host bind mounts, privileged guest,
inbound runtime port or sandbox Docker socket is admitted. Default runc/owner
trust is not hostile-tenant isolation; gVisor is not implemented here.

Machine create freezes absolute expiry once. Effective end is the minimum of
that persisted deadline and physical creation time plus relative TTL. Queue delay
must shorten remaining lifetime; retries and later phases retain the original
descriptor, never extend it. Expired creates/install/bootstrap refuse, but exact-owned
stop/delete remain possible. Host UTC clock and a running daemon are required for
local TTL enforcement; this is not a guaranteed scheduler during host/daemon loss.
An offline host means unknown/pending cleanup, not a fictional deletion receipt.

The fixed runtime archive initializes `/home/user` volume ownership as uid/gid
1000:1000, modes 0700, without privileged guest exec. Installation/start is only
for fresh quiescent machines. A bootstrap job contains only origin, artifact
metadata and one-use enrolment token, sealed by `ARMADA_ENCRYPTION_KEY`; its token
goes through memory/private stdin, never receipt, argv, environment or a file.
The runtime retrieves model configuration itself and dials out directly to Armada.
The host mailbox neither proxies model calls nor relays runtime feature commands.

A completed bootstrap duplicate repeats ACK only. Recovered pending bootstrap is
terminally uncertain and cannot replay with the same or a fresh ID for that machine
generation. Resolve authority/clean up rather than assuming no process started.
Host ACK is handoff, **not** health, prompt completion or journal commit.

## Persisted placement and admission

Reservation atomically stores a private Docker/Codex row and bound create job;
its stable request UUID is also sandbox/create identity. There is no fake golden,
Boat alias or movable host/installation/generation/image binding. Current owners
may create/bootstrap; owner or current org admin may stop/delete. Source member
locks precede credentials, host, sandbox and runtime. Issuer actor epoch, current
host registration, owner membership and pinned account version are rechecked.
Revoked/ineligible bound queue heads retire rather than block authorized cleanup.

Bootstrap composes the existing credential resolver/admission with encrypted
configuration issuance and bound-job enqueue in one transaction. Queue failure
rolls back the ticket. Same-ID reconciliation retains the original job/configuration,
even after ticket consumption or deployment changes; it does not rotate authority,
upgrade a runtime or re-resolve an account. Different IDs cannot replace the phase.

Enrolment reuses runtime epochs and checks registered host/org/installation plus
owner/issuer membership and persisted issuer fence. Issuer removal/rejoin or role
change cannot revive old grants. Default validators retain legitimate old grants
without enabling new issuance; Modal cannot enrol through this path. Cwd for
plain-image Docker is `/home/user`. Only the selected driver receives model
credentials through the existing encrypted bootstrap, never host jobs or public DTOs.

## Build/install, register on stdin, answer, stop/delete

Run these from a Linux coordinator checkout of the merged revision with Bun 1.4.2,
Python 3 and an existing SSH config entry for the test host. Do not use `set -x`.
The host account needs Docker CLI access (rootless where available); daemon access
is powerful even without root. No sudo or system-wide service install is required.
The commands install only under that account's `.local` directory.

```sh
set -euo pipefail
export DOCKER_SSH='YOUR_EXISTING_SSH_CONFIG_NAME'
export ARMADA_STAGING='https://armada-mcp-staging.up.railway.app'
export ARMADA_ORG='YOUR_STAGING_ORG_UUID'
export ARMADA_CREDENTIAL='YOUR_CODEX_ACCOUNT_UUID'
export ARMADA_CREDENTIAL_VERSION='1' # use its current version, not a guessed stale pin

bun build packages/docker-host/src/main.ts --compile --target=bun-linux-x64 --outfile dist/armada-docker-host
ssh -- "$DOCKER_SSH" 'docker version; docker info --format "{{json .Runtimes}}"; docker ps -a; docker image ls; docker volume ls'
ssh -- "$DOCKER_SSH" 'set -eu; umask 077; install -d -m 700 "$HOME/.local/bin"; test ! -e "$HOME/.local/state/armada-docker-smoke"; test ! -L "$HOME/.local/state/armada-docker-smoke"; test ! -e "$HOME/.local/bin/armada-docker-host"; test ! -L "$HOME/.local/bin/armada-docker-host"'
scp dist/armada-docker-host "$DOCKER_SSH:.local/bin/armada-docker-host"
ssh -- "$DOCKER_SSH" 'chmod 700 "$HOME/.local/bin/armada-docker-host"; docker pull buildpack-deps:bookworm-curl'
export DOCKER_IMAGE="$(ssh -- "$DOCKER_SSH" 'docker image inspect --format "{{index .RepoDigests 0}}" buildpack-deps:bookworm-curl')"
# This plain Debian-based image contains CA roots, but no Armada runtime or Codex.
read -r -s -p 'Staging org-admin Armada bearer: ' ARMADA_TOKEN; printf '\n'
export ARMADA_TOKEN
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_STAGING" --org "$ARMADA_ORG" \
  --credential "$ARMADA_CREDENTIAL" --credential-version "$ARMADA_CREDENTIAL_VERSION" \
  --ssh "$DOCKER_SSH" --image "$DOCKER_IMAGE"
unset ARMADA_TOKEN
```

Registration calls the existing org-admin token endpoint and pipes its one-use
capability directly into `armada-docker-host register --server <staging-origin>
--state-dir "$HOME/.local/state/armada-docker-smoke"` over SSH stdin. It never prints
the token, writes it locally or passes it in argv; the daemon's private state retains
only its exchanged host credential at 0600. The script removes `ARMADA_TOKEN` from
SSH's environment so SSH `SendEnv` cannot forward the user's API bearer to the host.
It starts the daemon detached with `nohup setsid`, saving a private PID/log beside
state. Do not register again if an exchange outcome is unknown: inspect that state
or use a fresh admin registration ticket after checking whether exchange committed. Never replay an uncertain exchange.

Expected script output: public `HOST_ID`, `SANDBOX_ID`, bootstrap/prompt/cleanup
request IDs, then `DOCKER_OK` with harness-reported input/output tokens and `PASS`.
The script waits for create ACK, issues one bootstrap, waits for epoch-bound Runner
health, enqueues one durable Codex prompt and reads the **acknowledged server journal**
until answer, finished status and token counters are present. Missing usage is
unknown, never estimated; it fails the smoke rather than inventing a count.
It then waits for stop and delete ACKs. Stages have a bounded ten-minute budget;
the daemon polls every 20 seconds and cold artifacts can take time. No CI polling.
After failure it attempts only this sandbox's stop/delete; offline/uncertain cleanup
stays unconfirmed, and printed IDs must be retained for reconciliation. Inspect the
private daemon log, not tokens or credential state. No readiness is inferred from
a host ACK or an HTTP enqueue response. Cost may remain unknown in this preview.

Run with `--host-id <printed-HOST_ID>` to reuse a host that is already registered
and running. Add `--start-host` if its daemon was stopped: the script starts it
detached but refuses a live/stale lock rather than deleting it. That skips
registration and allocates a new sandbox.
Do not do this to retry an unknown launch: first reconcile the original printed
sandbox/request IDs. A successful smoke removes its sandbox/container/workspace
volume, **not** the host registration, daemon or shared pulled image.

## HTTP contract / reconciliation

Bearer-only POST JSON under `/api/v1/docker/sandboxes/`; no browser Origin/cookie
authority. Every body has `org`; all except launch have `sandboxId`.

| Operation | Additional fields | Expected result |
| --- | --- | --- |
| `launch` | `requestId`, `hostId`, digest-pinned `image`, `credentialId`, `credentialVersion`; optional `ttlSeconds`, `model`, `reasoningEffort` | 201 private Docker record, initially starting; requestId is sandbox/create ID |
| `bootstrap` | `requestId` | 202 original bound bootstrap phase; call only after create job completes |
| `ready` | `requestId` | 202 pending, or 200 ready after real same-epoch health |
| `prompt` | `requestId`, `text`, optional `conversationId` for a follow-up | 202 pending, or 200 admitted with native receipt; same UUID/text/conversation reconciles |
| `journal` | optional numeric sequence `cursor`, `limit` 1..100 | 200 events with sequence, cursor, hasMore and saved usage |
| `get` | none | 200 safe retained metadata/status |
| `stop`, `delete` | `requestId` | 202 machine job; delete requires confirmed stopped/failed/deleted state |
| `job` | `requestId` | pending/completed/failed state, or null if absent |

Keep stable UUIDs for launch/bootstrap/health/prompt/cleanup retries. Never generate
replacement operations for an unknown result. Bootstrap retries cannot rotate a
consumed/live ticket; deployment changes are not upgrades to an admitted operation.
`ARMADA_DOCKER_PLACEMENT=0` disables new launch/bootstrap/readiness/prompt; keep
`ARMADA_DOCKER_HOSTS=1` for retained metadata/journal, cleanup and daemon polling.
Removing the host flag unmounts both Docker API families; other providers are unaffected.

## Host inspection and uninstall (coordinator only)

After ACKed deletion, compare inventories with the recorded baseline. The owned
container and volume for `SANDBOX_ID` must be absent; unrelated workloads/data
unchanged. All created Docker resources carry `dev.armada.machine.*` labels.
There is no global prune; shared official image removal follows the conservative policy below. The daemon now observes exact
ownership-verified stopped/failed/expired allocations and persists a local cleanup
deadline, default 24 hours after first observing physical exit. It removes only that
registration's labelled container and home volume (including sandbox files) after
the deadline, even when the server is unreachable. Shared runtime artifact caches
and user snapshot images are not sandbox files and remain untouched. Set
`ARMADA_DOCKER_RETENTION_SECONDS` in this host daemon's environment before starting
it to configure the period (`0` means the next local sweep); this setting persists
in its private state. Policy changes shift existing deadlines, preserving stopped age. A resume observed
before deletion cancels the deadline; cleanup refuses a running allocation. Missing
resources are safe to retry. Authenticated physical-cleanup reports reconcile the
server to `deleted` after reconnection. Deploy the server support before upgrading
hosts; old servers reject the additive report and the daemon retries it safely.

Retention controls and cleanup-deadline display are described below. Agent-declared
completion and disk floors remain separate follow-up work for #2154.
To uninstall, first confirm every retained sandbox for this host is deleted; then
revoke `POST /api/v1/docker/hosts/revoke` with `{"org":"<org>","hostId":"<HOST_ID>"}`
using normal private bearer delivery. Verify the saved PID belongs to the exact
installed `armada-docker-host run --state-dir ...armada-docker-smoke` process before
sending SIGTERM; wait for it to exit (up to a poll period). Only then remove that
private smoke state directory and `.local/bin/armada-docker-host`. Do not remove
a pre-existing binary/state or a shared pulled image. The managed installer below provides an ownership-checked uninstall CLI.

## Local checks

```sh
bun test packages/mcp-server/test/docker-runtime-lifecycle.test.ts packages/mcp-server/test/docker-sandbox-routes.test.ts packages/docker-host/test packages/core/test/docker-machine.test.ts
```

Migrated SQL plus fake host facts/Docker CLI protect dispatch, admission, durable
retries, real runtime command/enrolment/journal protocol, token projection and
stop/delete facts. No test network or wall-clock waits; no required CI job/budget
added. The real-host commands above are the coordinator's external acceptance.

## Follow-up acceptance on an existing host

Use this check only after reconciling the prior sandbox and confirming stop/delete
ACKs and unchanged inventories. It creates a **new** sandbox, not a retry of an
unknown launch. No resume or cost acceptance is implied.

After deploying this revision with the same explicit flags, run in Bash using
that host's existing SSH config and the staging org/account from the first check.
The host daemon must have exited cleanly; do not delete a lock to force startup.
The following intentionally updates only the binary retained from the previous
smoke, not an unrelated installation. Confirm no other daemon uses that binary.

```sh
set -euo pipefail
export DOCKER_SSH='YOUR_EXISTING_SSH_CONFIG_NAME'
export ARMADA_STAGING='https://armada-mcp-staging.up.railway.app'
export ARMADA_ORG='YOUR_STAGING_ORG_UUID'
export ARMADA_CREDENTIAL='YOUR_CODEX_ACCOUNT_UUID'
export ARMADA_CREDENTIAL_VERSION='1' # current pin from the passed check
export DOCKER_IMAGE='YOUR_PREVIOUSLY_VERIFIED_DIGEST_PINNED_IMAGE'
export DOCKER_HOST_ID='YOUR_EXISTING_REGISTERED_HOST_UUID'
bun build packages/docker-host/src/main.ts --compile --target=bun-linux-x64 --outfile dist/armada-docker-host
ssh -- "$DOCKER_SSH" 'set -eu; state="$HOME/.local/state/armada-docker-smoke"; test -f "$state/state.json"; test ! -e "$state/daemon.lock"; test ! -L "$state/daemon.lock"; test ! -e "$HOME/.local/bin/armada-docker-host-1165-next"; test ! -L "$HOME/.local/bin/armada-docker-host-1165-next"'
scp dist/armada-docker-host "$DOCKER_SSH:.local/bin/armada-docker-host-1165-next"
ssh -- "$DOCKER_SSH" 'set -eu; binary="$HOME/.local/bin/armada-docker-host"; state="$HOME/.local/state/armada-docker-smoke"; test ! -e "$state/daemon.lock"; test ! -L "$state/daemon.lock"; test -f "$binary"; test ! -L "$binary"; chmod 700 "$binary-1165-next"; mv "$binary-1165-next" "$binary"; "$binary" --help'
read -r -s -p 'Staging org-admin Armada bearer: ' ARMADA_TOKEN; printf '\n'
export ARMADA_TOKEN
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_STAGING" --org "$ARMADA_ORG" \
  --credential "$ARMADA_CREDENTIAL" --credential-version "$ARMADA_CREDENTIAL_VERSION" \
  --ssh "$DOCKER_SSH" --image "$DOCKER_IMAGE" \
  --host-id "$DOCKER_HOST_ID" --start-host --follow-up
unset ARMADA_TOKEN
```

Expected: binary --help prints usage and exits zero, not a failure message.
The helper **starts the stopped daemon**, reuses the registration, creates a fresh
sandbox and sends two prompts in one returned conversation. Only the first prompt
contains a random DOCKER_MEMORY marker; the second asks it to recall that marker
without resending it. Require two distinct native prompt IDs, the same conversation
ID, both answers and reported tokens in the acknowledged journal. It then confirms
stop/delete and prints `PASS: same-conversation follow-up recalled marker; both turns
reported tokens; stop/delete ACKed.` The host/daemon remain for inspection and may
be stopped by the coordinator again. Container/volume inventories must match the
baseline. No registration replacement, prune, migration or worker host access.

## Historical preview exclusions

The original preview excluded recipe builds, snapshot/fork, resume, automatic scheduling/failover,
public tunnels, gVisor and hostile multi-tenancy. Normal host-local snapshot
builds and retained stop/resume have since shipped; see
[host-local snapshots](docker-snapshots.md) and the normal follow-up contract
below. Automatic scheduling/failover, gVisor and hostile multi-tenancy are not
implied by those additions.
The existing Boat/Modal declared host capabilities do not authorize weakening
identity, ownership, source-retention or credential fences; provider names still
matter for immutable bindings. Modal tunnel removal and Boat native-runner
retirement are not Docker-host operations.

A host-local snapshot is a credential-free recipe built/scanned separately on
its host, never a snapshot of a live credential-bearing agent. Docker commit does
not include mounted volume contents; it cannot by itself promise workspace
preservation. Retained stop/resume must prove quiescence, retained disk/journal and
fresh enrolment/health, not assume a container start is conversation continuity.

Managed uninstall below drains through normal bound stop/delete jobs and never prunes. Any future implementation must drain,
revoke, reconcile exact labelled/receipt-owned resources, refuse shared/in-use or
uncertain data, preserve unrelated workloads and report offline remote revocation
pending. Current manual cleanup above is narrower; it does not delete shared
images or perform broad prune. Host credential rotation/expiry policy, disk quotas,
stronger resource admission remains an owner decision; local offline retention is described above.

## Terminal reconciliation

Upgrade the server and the retained host binary for expiry reporting; no migration
or re-registration is needed. A positive ownership-checked `stopIfExpired` result
is persisted before it is sent, then retried after reconnect/restart or lost ACK.
All physical sweeps run before network reporting. At most one confirmation is sent
per tick, with a durable fair cursor so an unacknowledged fact cannot starve others.
The existing machine results endpoint accepts either the original job outcome or
`{installationId,requestId,expired:true}` referring to a bound create/bootstrap.
The two packets are separate facts; expiry never rewrites the original job outcome.
Older servers reject the new packet safely and it remains pending until upgrade.

### Fetching the image (#1507)

Before it creates a container, the host checks whether it has the image. If it does
not, it runs `docker image pull` with its own 5-minute bound (half the launch
deadline), longer than the 30-second bound on other Docker commands. If the fetch fails or times out, the
failed create result carries `reason: "image_unavailable"`:
`{installationId,requestId,outcome:"failed",reason:"image_unavailable"}`.

- **What the person sees:** the server stores `DOCKER_IMAGE_UNAVAILABLE_MESSAGE`
  from `@armada/core` as the sandbox's status reason, in plain words. The launch
  answers with the same words instead of "did not become ready".
- **Where the reason counts:** only for a create, the only operation that fetches
  an image. Any other failure keeps the generic reason.
- **Older servers:** they refuse the extra field with a 400. The host then sends
  the plain failed outcome again, so the result is never left pending. Any other
  error keeps the reason for the next attempt.
- **Known limit:** the daemon is serial. While it pulls, it does not sweep expired
  sandboxes or take other jobs, and the host can show as offline (no poll for
  more than 60 seconds) until the pull ends.

The server validates the current host/installation and the original frozen machine
identity, then records a terminal stop and revokes runtime authority. Server time
alone never proves compute stopped. Duplicate/delayed facts cannot revive deleted
rows or advance the generation twice. An already failed sandbox retains its failure
while recording the physical stop. Failed bound create/bootstrap ACKs (and rejected
startup admissions) become logical failed state without fabricating stopped_at;
confirmed cleanup remains available. Authenticated polling also repairs historical
failed startup jobs left active by older servers, without replaying those jobs.
Delete ACK clears the old status reason, preserving the database lifecycle invariant.
Offline/unreachable/revoked hosts still cannot claim a remote successful stop until
a trusted confirmation arrives. Local TTL enforcement continues even while offline.

## Host-list/discovery acceptance on a retained host

After deploying this server revision on staging with the existing opt-ins, start
the stopped daemon on the same host. No new registration or sandbox is needed.
Use Bash and the same SSH configuration and staging org from the passed check.
A live or stale daemon lock must be inspected, never deleted automatically.

```sh
set -euo pipefail
export DOCKER_SSH='YOUR_EXISTING_SSH_CONFIG_NAME'
export ARMADA_STAGING='https://armada-mcp-staging.up.railway.app'
export ARMADA_ORG='YOUR_STAGING_ORG_UUID'
export DOCKER_HOST_ID='YOUR_EXISTING_REGISTERED_HOST_UUID'
env -u ARMADA_TOKEN ssh -- "$DOCKER_SSH" 'set -eu; umask 077; state="$HOME/.local/state/armada-docker-smoke"; test -f "$state/state.json"; test ! -e "$state/daemon.lock"; test ! -L "$state/daemon.lock"; nohup setsid "$HOME/.local/bin/armada-docker-host" run --state-dir "$state" >"$state/daemon.log" 2>&1 </dev/null & echo $! >"$state/smoke.pid"'
read -r -s -p 'Staging signed-in user bearer: ' ARMADA_TOKEN; printf '\n'
export ARMADA_TOKEN
python3 - <<'PY'
import json, os, time, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None
opener = urllib.request.build_opener(NoRedirect)
def post(path, body):
    req = urllib.request.Request(os.environ['ARMADA_STAGING']+'/api/v1/'+path,
        data=json.dumps(body).encode(), method='POST', headers={
          'authorization':'Bearer '+os.environ['ARMADA_TOKEN'], 'content-type':'application/json'})
    with opener.open(req, timeout=30) as response:
        assert response.headers['cache-control'] == 'no-store'
        return json.load(response)
options = post('launch/options', {})
docker = next(p for p in options['providers'] if p['id'] == 'docker')
assert docker['enabled'] and not docker['capabilities']['launch']
assert docker['unsupportedReasons']['resume']
for attempt in range(31):
    listing = post('docker/hosts/list', {'org':os.environ['ARMADA_ORG']})
    host = next(h for h in listing['hosts'] if h['id']==os.environ['DOCKER_HOST_ID'])
    assert set(host)=={'id','name','state','createdAt','lastSeenAt','revokedAt','sandboxes'}
    assert not listing['placement']  # until normal API/CLI integration lands
    if host['state']=='online': break
    if attempt==30: raise SystemExit('Host heartbeat not online within 60 seconds; inspect private daemon log')
    time.sleep(2)
print(json.dumps({'host':host,'docker':docker}))
PY
unset ARMADA_TOKEN
```

Expect the retained HOST_ID online with the existing inventory/count and no
credential fields. Admin register/revoke behavior is unchanged; members can list
but cannot mutate hosts. The daemon may be stopped by the coordinator afterward.
At this stage, placement=false and capabilities.launch=false are intentional.
Normal-launch acceptance requires its separately implemented backend; this
read/discovery check does not enable it.
No worker staging access, SSH, deployment, inference or remote migration was used.

### Normal follow-up and stop/resume (#1422)

With Docker placement and the runtime manifest enabled, `sandbox/send` (MCP `send`)
accepts `{id, request_id, prompt, conversation_id?}`. Reuse the UUID and identical
input after uncertain delivery. Omitted conversation selects the retained conversation;
model and effort stay pinned. Only the sandbox owner can send.

`sandbox/resume` (MCP `resume`) accepts `{id, request_id}` after a confirmed stop.
It starts the **same** labelled container on the original host, retains the workspace,
native conversation and journal, and issues fresh enrolment/epoch before confirming
runtime health. It does not extend the original TTL or replace an expired/missing
allocation. Unknown outcomes require the same request ID, not another allocation.
Status exposes per-turn tokens and service-computed session cost; unknown prices
remain unknown rather than zero.

Deployment prerequisites: apply `20261113130000_docker_resume_jobs.sql` through the
normal release process and update the Docker host daemon before using resume. Older
daemons do not accept the new `resume` job. No new application-secret or repository
capabilities are enabled.

Coordinator-only staging proof: use `scripts/smoke-docker-lifecycle.py` with
`--normal-lifecycle --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2` and the existing
server/org/credential/SSH/image arguments. This implies normal launch, follow-up,
stop/resume and a third same-conversation recall, then confirmed stop/delete. Keep
`ARMADA_TOKEN` private in the environment. This procedure is not evidence of a passed
real-host run.


## Managed owner installation (#1453)

The server image publishes Linux x64/arm64 host executables by SHA-256 alongside
runtime artifacts. `/install-host.sh` serves a script pinned to those
build digests and the configured public server URL. Deploy all replicas from this
revision and apply `20261113150000_docker_host_version.sql` through the normal
operator release process before using it. No deployment or remote migration was
performed here.

Use **Add a host** in the dashboard or `armada host add --org ORG_UUID`.
Paste its one command on the Linux Docker machine; the one-use token is included
under the owner-approved five-minute registration-token exception. Never share
or persist the command. Requires curl, sha256sum, util-linux flock/loginctl
and a working systemd user session. The binary is verified before execution,
registered over stdin and installed as a user service with linger. If the user
cannot enable linger or use Docker, an administrator must configure linger and
rootless Docker (or explicitly grant powerful Docker access). No sudo is run.
Use the current CLI installer below to safely upgrade an existing registration.
Failed or uncertain registration must be inspected, never blindly replayed.

`~/.local/bin/armada-docker-host status` reports registration, recent successful
poll (not inferred runtime health), daemon version and labelled running count.
The dashboard list displays the reported version; old hosts report unknown.
`systemctl --user restart armada-docker-host.service` restarts the daemon.
Kernel-held locks release on process death; legacy manual locks require inspection.

`~/.local/bin/armada-docker-host uninstall` fences new placements, drains through
normal bound stop/delete jobs and confirmed physical ACKs, revokes, stops/disables
the service and removes only the verified installation. The host registration's
issuer must retain cleanup authority (current admin for other owners' sandboxes).
Offline/uncertain cleanup, unknown labelled resources and changed managed files
refuse removal, preserving state for reconciliation. Shared images, other workloads
and account-wide linger are preserved. Drain is bounded; failure is not deletion.

Single coordinator check on the real machine previously registered as
`70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`: record container/volume baseline,
reconcile/delete its old sandboxes, revoke and remove the hand-made installation
using the manual runbook. Run the new Add-a-host command interactively there.
Retain the new registration's host ID, not the revoked ID. Run the existing smoke
with server/org/credential/SSH/image arguments plus
`--host-id NEW_HOST_ID --service-install`. It restarts only the user service,
proves a normal launch/answer/stop/delete and uninstalls; compare inventories with
the baseline. No reboot, prune, shared-image removal or worker host access.
This procedure has not been run here.


### One-click command contract (owner clarification)

`POST /api/v1/docker/hosts/register-token` accepts `{org,name?}` and returns
`{hostId,registrationToken,command,expiresAt}`. `command` is server-generated using
the configured public origin and includes the single-use token:
`curl -fsSL --proto '=https' --proto-redir '=https' '<origin>/install-host.sh' | sh -s -- --token <one-time>`.
Expiry is the actual database expiry in ISO UTC. Show/copy once, no persistence
or telemetry. This is the sole token-in-argv exception in AGENTS.md; the exchanged
host credential still travels only in private state and authenticated requests.
The POSIX script verifies the architecture's digest, installs the existing user
service and prints `connected` after the daemon has successfully polled. A timeout
reports pending, not failed registration or permission to replay a token.

On a machine already linked to the same server, the current installer keeps its
registration/name, safely upgrades the binary, and attempts to cancel the unused
new ticket; if reconciliation fails, the ticket expires naturally.
For a different server it creates a separate server-scoped installation and user
service; it does not replace the existing server connection. Use
`armada host status --server HTTPS_ORIGIN` and
`armada host uninstall --server HTTPS_ORIGIN` to select the intended installation.
With multiple installations, omitting the server returns an inventory and
selection guidance without changing either installation.
Unreadable existing identity/state refuses installation rather than guessing.

CLI: `armada host add [--name NAME] [--org UUID]` prints that command and waits
boundedly for the exact host. `armada host list [--json]` shows safe metadata;
`armada host revoke UUID` revokes through the admin API. Selected organization is
reused. `armada launch --provider docker --host UUID_OR_NAME`
resolves names exactly among nonrevoked hosts in the selected org and refuses
ambiguous names. Names are optional, nonempty trimmed display strings up to64
characters, never identity or authority.

Additional prerequisite: `20261113160000_docker_host_names.sql` after the prior
host-version migration, deployed by the authorized coordinator only. Same single
real-host smoke `--service-install` applies; use the one-click command instead of
manual binary installation or a second token prompt. Dashboard contract posted on
#1380; dialog redesign belongs to that agent.

### Harness and cost acceptance (#1454)

Coordinator only, on host `70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`:
run `scripts/smoke-docker-lifecycle.py` with the existing staging server/org,
SSH alias, registered host ID and digest-pinned image arguments. Supply the
Armada bearer privately through `ARMADA_TOKEN`, never argv.

- `--cost`: Codex per-turn pricing and exact session total, including retained
  immutable quotes after follow-up and stop/resume.
- `--claude --cost`: Claude Code using an Anthropic API-key account.
- `--opencode --cost`: OpenCode using the staging `deepseek-check` custom
  OpenAI-compatible connection (pass its credential ID and configured model).

Each flag uses normal launch/status/logs/send/stop/resume routes, and cleans up
with normal stop/delete. These are coordinator acceptance procedures, not claims
that the real-host runs passed. No worker needs staging or host access.


### Dashboard server contract (#1380 / #1481)

`POST /api/v1/docker/hosts/register-token` accepts `{org,name?}` and returns
`{hostId,registrationToken,command,expiresAt}`. The dashboard consumes
`{hostId,command,expiresAt}` and discards the extra bare registration token.
`command` uses the configured public origin and POSIX `/install-host.sh` with
`--token` containing only the five-minute single-use registration capability.
`expiresAt` is the database expiry, ISO UTC. Optional names are trimmed visible
strings up to64 characters. The host credential is never in command/argv/public
responses. Additional migration: `20261113160000_docker_host_names.sql`, applied
only by the authorized coordinator after the host-version migration. This server
contract is included here so the merged dashboard does not wait on the stacked
CLI follow-up. Existing `--service-install` real-host acceptance remains pending.

### Default model accounts on normal Docker launch (#1579)

`armada launch --provider docker` no longer requires an explicit
`--credential-id`. With an account omitted, the server uses the same compatible
personal-default policy as ordinary launches: a personal subscription marked as
default wins over a personal API key. Explicit account choices still win; an
invalid default or ambiguous personal choice fails rather than silently using a
different account. `--credential-version` requires an explicit account ID.

The server resolves and freezes the selected ID/revision before allocation. The
original caller request remains the retry identity; later default changes do not
repin an admitted sandbox or change a retry's billing account. The resolved pin
is stored separately from an omitted caller choice in the encrypted launch
manifest and the sandbox row. No template/delegated-access grant rules change.
Scoped children and Armada-access parents still require explicit account pins;
omission on those paths is refused, not silently billed to another account (#1579).

Coordinator verification after normal deployment: mark a personal Codex
subscription default while retaining a personal API-key account, launch on the
owned Docker host without `--credential-id`, and inspect the returned pin. Repeat
the same request ID after changing the default: it must return the same sandbox
without allocation/rebilling. An explicit API-key account must remain explicit.
This procedure is not evidence that live subscription auth has passed.

### Default machine limits (#1773, slice a)

Updated daemons report CPU count and physical memory in each poll. Every new
sandbox receives at most 2 CPUs, 4 GiB RAM (shrunk to the machine size) and
4096 processes. Memory swap equals memory, preventing an additional swap budget.
Snapshot builds use a request-scoped Buildx docker-container builder with the
same CPU/memory/swap budget; its process cap is applied before build work.
The builder is removed after each attempt; shared builders/images are untouched.
Buildx with the docker-container driver is required for snapshot builds.

This first slice does not persist resource reports, enforce host admission or
provide overrides/UI. Those are subsequent #1773 slices; do not treat this as
capacity protection. Existing retained containers keep their creation limits.
Older daemons still poll without reports; updated daemons retry without the
additive report when an older server refuses it. Host ACKs remain machine facts,
not runtime readiness.

Coordinator-only proof after normal deployment and daemon upgrade: launch a
sandbox and inspect HostConfig NanoCpus, Memory, MemorySwap and PidsLimit. Build
a snapshot and inspect its request-scoped BuildKit container during the build,
then confirm its removal. Verify small-machine limits fit the host. No real-host
verification was performed by this change.

### Automatic capacity admission (#1773, slice b)

Apply `20261114130000_docker_host_resources.sql` through the normal authorized
deployment path before deploying the server. Authenticated daemon polls persist
CPU/memory observations; old daemons without observations retain unknown capacity
and no admission limit. No new JWT access is granted.

New allocations and wakes from stopped/idle-paused state check capacity while
holding the host lock. The automatic limit is the smaller of the 2x CPU budget
and memory budget after a 2 GiB reserve, minimum one. Pending starts reserve a
slot to prevent concurrent launches exceeding capacity. A stop request alone
does not release it: confirmed physical stop/delete or daemon TTL-stop proof
does. A failed logical startup is conservatively retained until physical stop is
proven. Full hosts return an immediate actionable conflict, not a readiness wait.
Historical request retries retain their original allocation without another slot.

Coordinator-only acceptance: on an upgraded host, launch to the computed limit,
then verify one more launch returns HTTP 409 with the host name and running/limit.
Stop one sandbox, confirm its physical ACK, and retry the rejected request.
Repeat by attempting to wake an idle-paused sandbox while the host is full;
it must remain paused, then wake after another sandbox physically stops.
Older-daemon unknown-capacity behavior remains supported. Overrides and dashboard
capacity display belong to slice (c), not this deployment. No real-host checks
were performed here.

### Capacity visibility (#1773, slice c1)

The host list API now adds observed hardware, effective automatic per-sandbox
limits, admission capacity and running reservations. CLI `armada host list` and
`armada host show HOST` (exact name or UUID, optional `--json`) show these values;
the dashboard host row shows running/capacity and its Facts show hardware,
limits and automatic/manual mode. Retained sandbox count is separate from
running reservations. Pending starts reserve slots until physically stopped,
so running/capacity includes these reservations.

An old server or daemon without hardware observations shows
“Unknown — upgrade the host” rather than zero capacity or an invented limit.
No new migration is added in this display slice; it depends on slice b's
resource-observation migration. Overrides and their daemon enforcement remain
the next #1773 slice, not a capability claimed by this display.
Coordinator-only check: compare CLI text/JSON and dashboard Facts with the
host's observed hardware and Docker inspection, then stop a sandbox and confirm
the running/capacity display changes after the physical stop ACK.

### Owner overrides (#1773, final implementation slice)

Apply `20261114140000_docker_host_limit_overrides.sql` via the authorized release
path before deploying this server. Upgrade every participating host daemon and
wait for its policy-version heartbeat before enabling overrides. Old daemons
without that capability keep automatic operation; once a manual override exists,
they receive cleanup jobs but no new starts/builds until upgraded.

The current host owner (a current organization member, not another admin) uses:

```text
armada host limits HOST --cpus 1 --memory 2g --max-sandboxes 4
armada host limits HOST --auto
```

HOST is an exact name or UUID. Omitted options preserve existing overrides.
`--auto` resets all overrides and cannot be combined with other options.
The dashboard offers the same owner-scoped controls under host resource limits.
CPU and memory must fit observed hardware (minimum 0.01 CPU / 6 MiB).
Automatic capacity retains the 2 GiB reserve and 2x CPU budget. A manual max can
use that reserve but cannot exceed total RAM / per-sandbox RAM or the 2x CPU
budget; memory is never deliberately overcommitted.

Stop all sandboxes and finish pending work/builds before changing CPU or memory;
only future starts and resumes receive those changes. Capacity-only edits are
allowed while running, but never below existing reservations. Host-row locking
serializes edits with launch/wake admission. Retained containers receive the
current policy through Docker update before resume, and new containers and
request-scoped builders use the same limits. Hardware shrink invalidating a
manual policy refuses new work while preserving cleanup; drain and reset using
`--auto` or the dashboard's Use automatic action.

Coordinator-only acceptance: on the owner's real host, stop running work, set
small CPU/memory limits through CLI, launch and inspect NanoCpus/Memory/
MemorySwap/PidsLimit, then stop/resume and inspect again. Verify a snapshot
builder's caps during a build. Launch to manual capacity, verify one extra
launch and paused wake are refused, raise capacity within hardware budget and
retry. Use dashboard edits and automatic reset and compare displayed mode and
running/capacity. Confirm another org admin cannot edit this owner's limits.
No deployment, remote migration or real-host acceptance was performed here.

### Durable receipt retention and capacity

The daemon compacts terminal stop/delete/build receipts and TTL receipts whose
expiry confirmation was acknowledged once state reaches 1 MiB. Pending receipts,
uncertain machine outcomes without a terminal result, and active TTL obligations
remain in full. Each retired record retains the request identity, SHA-256 of the
exact operation/request/input fingerprint, and generation and machine fingerprint
digests. Retired request IDs replay their saved outcome on exact redelivery (including
snapshot image IDs); changed input is rejected. Neither path executes again. Retired create/bootstrap/build identities cannot be repeated for that generation
under a new request ID (resume remains available);
cleanup must still match its original machine fingerprint. Fences are never
evicted or aged out within an installation.

Admission stops at 16,384 total full receipts plus fences or 8 MiB of state for
non-cleanup jobs. Legacy installations receive a one-time cleanup ceiling of their existing
identity count plus 1,024 if higher; this ceiling is persisted, never renewed.
Another 1,024 identities and the remaining half of the 16 MiB
atomic state limit are reserved for stop/delete and local TTL confirmations.
This is a finite installation lifetime, not indefinite history eviction: at the
admission limit drain the host and replace its registration/installation. At
the cleanup limit use operator-controlled Docker cleanup, then retire the host.
Do not delete receipts, fences, or state to resume an existing registration:
doing so removes replay protection. Preserve the private state for investigation;
never copy it into a new installation or publish it (it contains the host token).
Disk-full or permission failures still require operator storage repair; reserved
logical capacity cannot repair unavailable storage.

### Available-machine automatic capacity (#1773 follow-up)

Apply `20261114160000_docker_available_resources.sql` through the authorized
release path before deploying the server, then upgrade the host daemon.
Each poll samples Linux MemAvailable and one-minute load, plus the current
registration's labelled running sandbox containers using
[Docker stats](https://docs.docker.com/reference/cli/docker/container/stats/).
The CLI's memory metric excludes inactive file cache. Armada's working-set
memory and CPU use are credited back, so its own running agents are not charged
twice. Unrelated containers and host processes consume the remaining headroom.
Snapshot builders are conservatively treated as other work during their build.

Headroom decreases immediately and recovers through a quarter-weight EWMA
on successful polls (normally every 20 seconds), snapping within 0.05 CPU /
16 MiB to avoid permanently losing an integer boundary slot. This deliberately
favors safety over instant recovery after a load spike. Sampling errors report
zero headroom, not invented free hardware; cleanup remains available.
These are estimates, not reservations against unrelated workloads; Docker's
per-container caps remain the enforcement boundary.

Automatic admission uses the smaller of total-hardware capacity and available
CPU/memory capacity, retaining the 2 GiB reserve and 2x CPU budget. It can be zero
on an entirely busy host, but never below already-admitted running/pending
reservations. Existing sandboxes are never killed or stopped by a lower sample.
The CLI and dashboard show e.g. `5/7 (2 held back: machine busy)`.
Explicit max-sandbox overrides remain an owner's deliberate capacity choice;
CPU/memory overrides without an explicit max still get automatic headroom-based
capacity. Automatic reset and its response use current observed headroom.

Old daemons with no availability report retain total-hardware behavior; their
next poll clears old availability values. New daemons fall back to the earlier
quota handshake if a preceding server rejects the new fields, preserving manual
limits during an upgrade. A full host returns HTTP 409 with `host_full` through
normal control and preview APIs; CLI JSON retains that code and both clients
provide stop/raise-limit guidance rather than claiming an unknown launch outcome.

Coordinator-only follow-up acceptance: on the verified owner host, compare idle
automatic capacity to capacity while an unrelated container consumes memory/CPU.
Confirm held-back slots and gradual recovery after freeing that workload, with
existing sandboxes untouched. Fill capacity and verify normal launch and idle
wake return `host_full`, including CLI JSON and dashboard refusal. Repeat with
an explicit manual max and with an old-daemon/preceding-server pairing.
No deployment, remote SQL, unrelated workload changes or real-host proof was
performed by this PR.

## Existing Docker snapshot parity probe (#2052)

The coordinator can verify an already-built snapshot with the existing staging
parity checker; this probe never builds a snapshot or an image. Add `snapshotId`
(the exact snapshot UUID) to the owned Docker entry in `ARMADA_SMOKE_CASES`, keeping
its existing `org`, `hostId`, harness, model and model-account ID. The snapshot
must be ready and available on that same host and organization, private and owned
by the caller. This deliberately narrow smoke-fixture prerequisite does not mean
org-visible snapshots are unsupported by the product. Discovery uses the caller's
server-filtered snapshot list and account identity; no owner ID is accepted from
the smoke configuration.

After normal deployment, with existing staging origin/token and consent:

```sh
ARMADA_SMOKE=create_real_compute bun scripts/post-deploy-smoke.ts --parity --only docker --feature launch-snapshot
```

The server must advertise its golden/snapshot launch source and capability. The
probe launches via normal `sandbox/launch` with only the selected `snapshotId`,
not an image or explicit repository recipe. Require exact snapshot/host/image/
organization/owner identity in its receipt, a real finished answer, and confirmed
stop/delete cleanup. Missing, unready or unavailable fixtures allocate nothing;
malformed or mismatched identity cannot pass. A rejected receipt with a known
sandbox ID is still journaled and cleaned up.

Unfiltered parity keeps its ordinary plain-image Docker launch unchanged and
reports the snapshot cell as not-run with a dedicated-probe-required reason when
configured (or fixture-not-configured otherwise). It never claims that a plain
image proved snapshot launch. Cloud golden probes remain unchanged. Boat is not
part of staging/release acceptance. No deployment or real provider check was
performed by this worker; these instructions are not acceptance evidence.

## Multiple Armada servers on one machine (#2169)

The CLI installer keeps an existing legacy installation untouched when installing
for a different HTTPS server origin. Additional instances use
`armada-docker-host@<sha256-of-origin>` for their binary and private state
directory, and the same name plus `.service` for their systemd user unit.
Each has independent registration credentials, durable receipts and runtime cache.
The daemon's existing installation-ID and host-ID ownership labels scope container,
volume and snapshot operations, including cleanup; shared images remain shared.

Use `armada host status --server https://armada.example` or
`armada host uninstall --server https://armada.example` to select one.
Without `--server`, multiple installations are listed, never implicitly removed.
An old legacy daemon's origin is read from its private state when status does not
yet expose it. Unreadable registration refuses installation before reading or
exchanging the new one-use token; repair the existing local installation first.
Managed daemon commands also accept `--instance SHA256_SERVER_ORIGIN`.

Capacity is computed independently per registration from the same machine.
Availability sampling treats other instances' workloads as unrelated machine
load; admission reservations are not coordinated across servers. Simultaneous
starts can therefore compete; use conservative per-host overrides as needed.

Coordinator acceptance (not performed here): run the production one-click
installer while staging remains connected; check both dashboards, launch one
sandbox from each and verify distinct ownership labels and state. Stop/delete
through each server, uninstall production with `--server`, and confirm staging
still runs. No production mutation or deployment was performed by this change.

### Diagnosing an immediate normal-launch refusal (#2239)

Normal CLI launch goes through `sandbox/launch` in `control.ts`, then
`docker-normal-launch.ts`: retained receipt lookup, official image, personal
account defaults, membership/actor epoch, credential resolution, skill/MCP
defaults, and finally the transaction that reserves the sandbox and queues
the host create job. Only after that commit can the daemon see work.
The former outer catch silently wrapped dependency exceptions and most
`LaunchError` credential refusals in a receipt-bearing `unavailable` error;
`api-failure.ts` projected that as `outcome_unknown`, even before allocation.
This explains the fast, silent symptom but does not identify which production
dependency threw without production evidence.

Look for `docker_launch_failed` with its stable `reason`, typed `code` and
`dispatchPossible` fields. Raw dependency diagnostics are deliberately omitted.
Pre-reservation errors now retain definite categories; an uncertain reservation
commit or an existing receipt still requires inspection with the same request ID.

Production prerequisites to compare with the passing staging environment:

- Both Docker flags and the same-build architecture-specific manifest above;
  placement advertised true implies bootstrap construction succeeded at startup.
- The release's generated `packages/core/src/official-sandbox-image.json` must
  match the server version and contain the published GHCR digest. A source build
  deliberately uses the immutable source fallback, not a per-org image setting.
- Same-build runtime artifacts under `ARMADA_RUNTIME_ARTIFACT_DIR` (default
  `/opt/armada/runtime-artifacts`), manifest digests and published harness bundles.
  Bootstrap/enrolment needs the normal encryption key and public HTTPS server
  origin, reachable from the container for artifact download, enrolment and
  runtime WebSocket dial-out. Docker does not use Modal's authenticated tunnel
  or require `ARMADA_MODAL_DIALOUT`.
- Applied existing schema and matching `members`/`mcp_actor_epochs` rows for the
  launching user/org; active host installation in that org; usable user/org
  model account and current revision; skill/MCP defaults and their referenced
  resources. No Docker-specific first-launch organization seed is required.
  Do not repair rows blindly: diagnose the logged phase first.
- Staging smoke supplies its own org, account and registered host and explicit
  image for historical preview probes. Those do not configure production.
  Normal launch uses the server's official image. An online fresh registration
  proves polling/authentication, not any of the above runtime prerequisites.

After release, the coordinator must retry the owner's normal CLI launch with
its original body/request ID, inspect any retained reservation first, then verify
host create, runtime enrolment/readiness and an actual harness reply. Neither
unit tests nor passing staging probes establish that production is configured.

### Official image retention

The daemon performs an offline, hourly best-effort image sweep, removing at most
one superseded official image per sweep. It keeps the two newest locally present
official image generations (by Docker creation time), every container's image,
and every image with a descendant (including user snapshots). Only images whose
registry digests belong exclusively to `ghcr.io/the-vibe-company/armada-sandbox`
are candidates; foreign tags and snapshot ownership labels exclude an image.
Registry provenance identifies these shared release images, which do not carry
per-registration container labels. Unproven dangling images are left alone.
There is no global prune, forced removal, snapshot deletion or foreign-image
cleanup. Docker's non-forced removal provides the final concurrent-use guard.

### Retention controls and visibility

`armada host show HOST` (also `--json`) and Machines → server panel show the
last reported retention delay and next local cleanup deadline, with the host's
last check-in. No reported deadline means none has been reported, not proof
that the disk is empty. Offline hosts continue enforcing their saved policy.

The member who added the server can run
`armada host retention HOST --retention 24h` (units: `s`, `m`, `h`, `d`; `0`
means next-sweep cleanup), or save retention in seconds in the server panel.
The maximum is 365 days. Other members, including other admins, cannot change
this machine policy. A saved request is applied and persisted at the daemon's
next check-in; the panel distinguishes requested from reported settings.
Changing the delay adjusts existing pending retention deadlines too; shortening
it can immediately make stopped sandboxes eligible. Until the daemon reports
its new deadlines, the server clears the old next-cleanup display rather than
inventing a deadline. Snapshots remain outside automatic sandbox retention.

Deploy the new retention-control schema and server before updating daemons.

Once a server-requested retention policy has been received, it takes precedence
over the installer/environment default even across daemon restarts. Before any
server override, changing the environment default shifts existing deadlines by
the policy delta, preserving their original stopped age.
