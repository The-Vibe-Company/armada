# Opt-in Docker host daemon (#1165, slice 3c)

Registers a host and executes machine-only create/stop/delete jobs. It does
**not** launch Codex, install a runtime or initialize workspace ownership.
No completed one-prompt lifecycle is claimed. No goldens, resume, Hosts UI,
gVisor or disk quota. Boat and Modal stay unchanged.

## Enablement and defaults

After the coordinator's normal migration process installs
`20261113024000_docker_host_mailbox.sql`, set `ARMADA_DOCKER_HOSTS=1` on **staging**
to mount the new routes. Without that explicit setting they are absent.
The worker deploys nothing and applies no remote migration.

An org admin calls `POST /api/v1/docker/hosts/register-token` with `{"org":"<uuid>"}`
using normal Armada authentication. Deliver the returned capability privately
to host stdin, never argv, a shell transcript or logs. It exchanges once via
`/api/docker-host/register`; lost exchange needs a new admin-issued ticket.
State directory/file permissions are 0700/0600. Host credentials have no expiry
but are revocable. Admin revocation: `POST /api/v1/docker/hosts/revoke` with
`{"org":"<uuid>","hostId":"<uuid>"}`. Default launch TTL remains planned as
3,600 seconds; no disk quota yet. Owner may revise these defaults later.

## Build and run

On Linux x64, build the standalone executable (not the API-only armada CLI):

```sh
bun build packages/docker-host/src/main.ts --compile --target=bun-linux-x64 --outfile dist/armada-docker-host
```

Coordinator installs it under a dedicated account with Docker CLI access.
Docker access itself is powerful: owner-trusted machines only; no Docker socket
is mounted inside a sandbox. Registration syntax:

```sh
armada-docker-host register --server https://armada-mcp-staging.up.railway.app --state-dir /absolute/private/armada-host
# Supply the one-use token on stdin, not as an argument.
armada-docker-host run --state-dir /absolute/private/armada-host
```

Use a service manager for unattended operation. Local TTL enforcement requires
the daemon to stay running; requests persist before machine side effects.
After restart, pending work requires current server redelivery; offline/revoked
hosts sweep TTL but do not start pending creates. Uncertain machine failure is
terminal for that ID, never silently retried with a fresh identity.
Unclean termination leaves an exclusive lock: only after verifying no daemon is
running may the operator remove `daemon.lock`. Receipts are not pruned yet.

## Exact coordinator check

No deployment or real-host change needed for this component:

```sh
bun test packages/docker-host/test packages/mcp-server/test/docker-host-routes.test.ts
bun build packages/docker-host/src/main.ts --compile --target=bun-linux-x64 --outfile dist/armada-docker-host
```

Expected: injected API/fake-Docker tests pass without network or sleeps; native
binary compiles. SQL-backed HTTP tests prove bearer separation, private cache
policy and revocation. Tests add seconds, not a new long-running required CI job.
The final integration PR must give exact SSH install/register/Codex launch
commands and expectations; this component is not that proof.
