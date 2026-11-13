# Frozen Docker machine expiry (#1165)

Internal machine jobs may carry expiresAt: a frozen absolute UTC epoch in
milliseconds. The future launch service must copy the persisted sandbox expiry
once at admission and reuse the same value for create/bootstrap/stop/delete.
Never compute a fresh deadline when retrying or delivering queued work.

## Behavior and compatibility

The host refuses an expired queued create before allocating a volume/container.
For accepted work it freezes the effective end as:

    min(request.expiresAt, physical creation time + request.ttlSeconds)

The creation label remains physical creation time; a separate immutable label
binds the original requested absolute bound. Retries keep that original end,
including recovery from an owned orphan volume. Changing or omitting the bound
cannot operate the same generation, even when the relative cap would produce
the same effective end. Expired resources remain eligible for exact-owned stop
and delete; installation/bootstrap still refuse after effective expiry.

The mailbox strictly validates and preserves the bound; host receipts include
it in immutable generation identity. Requests omitting it retain their prior
serialized bytes, labels, input hashes and relative-TTL behavior. Do not retrofit
existing relative generations: later operations must keep the original shape.
Upgrade the host binary before sending deadline-bearing jobs; old strict parsers
refuse them safely rather than interpreting them as a new lease.

This uses the host's UTC clock, not a synchronization service or real-time
scheduler. No grace window is added. The relative cap prevents a longer
host-clock TTL; badly misaligned clocks are not corrected by this component.
Existing periodic/bounded-operation sweep granularity is unchanged.

No launch defaults, Boat/Modal behavior or public provider choices change.
Host credentials remain no-expiry/revocable; no disk quota, goldens, resume,
Hosts UI or gVisor. Host routes still require ARMADA_DOCKER_HOSTS=1.
There is no migration or newly enabled public launch path.

## Exact coordinator check

No staging deployment, real host, sockets or model calls needed for this component:

```sh
bun test packages/core/test/docker-machine.test.ts packages/docker-host/test/daemon.test.ts packages/mcp-server/test/docker-host-store.test.ts
bun build packages/docker-host/src/main.ts --compile --target=bun-linux-x64 --outfile dist/armada-docker-host
```

Expect injected-clock/fake-Docker tests to show delayed allocation shortening
remaining lifetime, immutable retries, already-expired refusal, cap enforcement
and post-expiry cleanup. Mailbox/receipt tests must reject changed bounds and
preserve legacy job bytes. Tests use no sleeps or network.

Persisted placement/DTOs, runtime authority/configuration, one-prompt journal and
stop/delete integration, and the final coordinator SSH smoke remain subsequent
authorized slice-3 work; this PR does not claim that lifecycle is complete.
