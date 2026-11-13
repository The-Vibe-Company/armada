# Docker hosts and placement

Explicit API preview for a **private, plain-image Codex sandbox**. Machine lifecycle
is the dial-out host daemon; enrolment, health, prompt and journal are the existing
Armada runtime channel. No inbound host port, Docker socket in the sandbox, agent
host API, fake golden or Boat compatibility ID. Boat and Modal are unchanged.
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
owner-trusted Docker only. Goldens, resume, gVisor and multi-tenancy are not part of this preview. It admits **one native conversation per sandbox**, with explicit follow-up prompts
using the returned conversationId. Retries reuse the same request UUID and input;
a new request without that conversation or for another conversation is refused.
Wait for the previous turn's acknowledged finished event before sending a follow-up.
Unresolved RPC admission blocks new requests; the runtime owns busy-turn refusal.

## Dashboard availability

The dashboard contains a Hosts page, admin add/revoke dialogs and a Codex launch
form for an online host: digest-pinned image, usable account, model/effort and
optional task. It acts as the signed-in viewer through server-side control calls;
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
placement. A request field cannot enable placement. Docker is an image/Codex
source with null goldenId/golden and no fabricated Boat alias; golden providers
remain Boat/Modal. The explicit preview API below is unchanged.

### Normal dashboard/API/CLI launch

`POST /api/v1/sandbox/launch` accepts the existing dashboard body:

```json
{
  "org": "ORG_UUID",
  "provider": "docker",
  "hostId": "HOST_UUID",
  "image": "IMAGE@sha256:DIGEST",
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
(default TTL four hours, maximum one day). Only private Codex/plain digest-pinned
images are supported: no golden, repo/size policy, skills, connections or GitHub
setup is silently applied. The server composes durable create, existing enrolment
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

The API-only CLI uses the same normal route, not the private preview. `image` is
optional everywhere (API, CLI, dashboard): without it the launch uses
`DOCKER_DEFAULT_IMAGE` from `@armada/core`, a digest-pinned Debian
`buildpack-deps` image (#1507). The resolved image is part of the request's
identity: the CLI and dashboard send it explicitly, so a retry with the same
`requestId` stays identical even if a later release changes the default. A raw API
caller that omits `image` should do the same when it retries across an upgrade.
`--image` overrides the default:

```sh
bun run armada launch --provider docker --org "$ARMADA_ORG" \
  --host "$DOCKER_HOST_ID" --image "$DOCKER_IMAGE" \
  --credential-id "$ARMADA_CREDENTIAL" --request-id "$REQUEST_ID" \
  --agent codex --json 'Reply with exactly DOCKER_OK.'
```

Normal follow-up send remains unavailable in this slice; the private preview's
explicit same-conversation follow-up is unchanged.

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
There is no global prune, shared image removal or automatic purge of host files.
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

## Deferred capabilities, not current guarantees

Docker goldens/recipe builds, snapshot/fork, resume, automatic scheduling/failover,
public tunnels, gVisor and hostile multi-tenancy remain outside this preview.
The existing Boat/Modal declared host capabilities do not authorize weakening
identity, ownership, source-retention or credential fences; provider names still
matter for immutable bindings. Modal tunnel removal and Boat native-runner
retirement are not Docker-host operations.

A future golden would be a credential-free recipe built/scanned separately on
its host, never a snapshot of a live credential-bearing agent. Docker commit does
not include mounted volume contents; it cannot by itself promise workspace
preservation. Future stop/resume must prove quiescence, retained disk/journal and
fresh enrolment/health, not assume a container start is conversation continuity.

Managed uninstall below drains through normal bound stop/delete jobs and never prunes. Any future implementation must drain,
revoke, reconcile exact labelled/receipt-owned resources, refuse shared/in-use or
uncertain data, preserve unrelated workloads and report offline remote revocation
pending. Current manual cleanup above is narrower; it does not delete shared
images or perform broad prune. Host credential rotation/expiry policy, disk quotas,
offline retention and stronger resource admission remain owner decisions.

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
Existing binaries/registration are refused rather than overwritten. Failed or
uncertain registration must be inspected, never blindly replayed.

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

CLI: `armada host add [--name NAME] [--org UUID]` prints that command and waits
boundedly for the exact host. `armada host list [--json]` shows safe metadata;
`armada host revoke UUID` revokes through the admin API. Selected organization is
reused. `armada launch --provider docker --host UUID_OR_NAME [--image DIGEST_REF]`
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
