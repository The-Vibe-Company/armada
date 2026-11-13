# Docker workspace/runtime installation (#1165, slice 3d)

Stacked on the machine-only daemon. This internal start-time installation
primitive is **not** a new mailbox operation or an enabled Docker launch path.
No remote caller can select an arbitrary archive, path, UID or Docker flag.
Boat and Modal and the API-only armada CLI remain unchanged.

The host reuses the existing runtime artifact installer: HTTPS
`/api/runtime/artifacts/<sha256>`, bounded bytes, digest verification and private
content-addressed cache. A warm cache needs no network. Only the runtime executable
is copied; the selected harness and configuration remain runtime-enrolment work.
No model credential or enrolment token belongs in the installation archive.

A fixed USTAR stream contains only `user/` and `user/armada-runtime`, uid/gid
1000:1000, modes0700. Copying that stream with Docker's
[archive-mode cp](https://docs.docker.com/reference/cli/docker/container/cp/)
to the owned container's /home initializes its named-volume workspace ownership
without privileged guest execution, additional capabilities or host bind mounts.
The machine port rechecks exact ownership, running state and TTL before copying.
All archive paths and permissions are host-defined, not server job input.

Trusted launch integration must call this only on a fresh, quiescent machine,
before enrolment/readiness. This is not a live-runtime update API.
Nothing in this PR starts a harness or claims a real Docker/Codex smoke.

## Defaults and remaining work

Revocable host credential without expiry; planned launch TTL3600 seconds; no
disk quota yet. No goldens, resume, Hosts dashboard or gVisor.

Still needed for the authorized one-prompt milestone: durable one-use bootstrap
job admission/recovery, current runtime enrolment/configuration, opt-in persisted
Docker placement and launch/read/stop/delete wiring. Runtime feature control must
continue over its own dial-out transport, not the host mailbox.

## Exact coordinator check

No deploy, remote migration, model call or real-host change needed here:

```sh
bun test packages/core/test/docker-machine.test.ts packages/docker-host/test/runtime-install.test.ts
```

Expected: fake Docker proves exact owned/active copy and refusal paths; local tar
parsing proves the generated archive's paths, bytes, ownership and permissions.
In-memory HTTP proves existing artifact verification and private cache composition;
no socket or wall-clock waits. Real Docker29 volume UID behavior is still an
integration check for the coordinator, not evidence supplied by these tests.
The final launch PR must supply complete SSH install/register/Codex smoke commands.
