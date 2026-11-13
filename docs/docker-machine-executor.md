# Docker machine executor (#1165, slice 3a)

This is an internal machine boundary, not a registered host or an enabled Docker
placement. No server route, CLI switch, provider registry or Boat/Modal behavior
changes. Registration, outbound job delivery and runtime bootstrap follow in
stacked PRs; this PR does not claim a real Codex lifecycle.

The executor receives a trusted Docker CLI port. It manages only its exact owned
container and named volume; ownership includes installation, host, sandbox and
generation. It never mounts the Docker socket, exposes a port or accepts arbitrary
Docker flags from a public caller. Docker access itself remains owner-trusted.
Images must be pinned by digest. Fresh volumes are root-owned: the later host
bootstrap must initialize ownership before uid 1000 can write. The caller must
also serialize operations and persist requests for offline TTL sweeps. This
executor is not an autonomous TTL scheduler. Failures are fixed diagnostics, not raw CLI output.
See Docker's [create](https://docs.docker.com/reference/cli/docker/container/create/),
[exec](https://docs.docker.com/reference/cli/docker/container/exec/) and
[volume inspect](https://docs.docker.com/reference/cli/docker/volume/inspect/)
contracts.

Deferred defaults for the registration/launch slices: host credential has no
expiry but is revocable; launch TTL uses the existing default of other providers;
no disk quota yet. These are simple defaults, not final owner policy decisions.
No goldens, resume, Hosts dashboard or gVisor in this milestone.

## Exact coordinator check

No deployment, migration, Docker daemon or real-host SSH is needed for this
internal slice. From the PR checkout:

```sh
bun test packages/core/test/docker-machine.test.ts
```

Expected: fake-Docker lifecycle and ownership/refusal tests pass without network,
model calls, wall-clock sleeps or touching the coordinator's Docker resources.
The final integration PR will supply installation, stdin registration and
one-Codex-prompt commands for the real host; they are not available in this PR.
