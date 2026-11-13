# Fenced Docker runtime bootstrap jobs (#1165, slice 3e)

Stacked on runtime/workspace installation. This adds the internal bootstrap job
and daemon delivery path; it does **not** issue runtime enrolment tickets or
enable a persisted Docker launch/prompt API. Boat/Modal behavior is unchanged.

## Authority and transport

Only trusted server code may enqueue a bootstrap descriptor: pinned artifact
digest/size, same server HTTPS origin, and a single-use runtime enrolment token.
No model credential, harness configuration, prompt or arbitrary command belongs
in this job. Runtime fetches configuration and controls its own dial-out channel.

The existing mailbox seals the full job using ARMADA_ENCRYPTION_KEY. Host delivery
still requires its current installation-bound token and issuer membership.
A shared strict validator preserves existing create/stop/delete payload bytes
while rejecting extra bootstrap fields, credentials in URLs and malformed tickets.
The host refuses bootstrap origins different from its registered server.

Before installation/start, the host persists only machine identity, request ID
and a SHA256 input fingerprint: no enrolment token or descriptor in the receipt.
The private token is passed in memory to the native starter and ultimately via
stdin as {serverUrl,enrolmentToken}. The fixed shell command never interpolates
it into command arguments, environment variables or a file. Runtime output is
disconnected before docker exec returns; runtime communication is outbound.
The fixed /bin/sh launcher refuses shells without builtin printf, rather than
falling back to an external printf process whose arguments could contain input.

## Recovery and limits

Completed duplicate jobs repeat ACK only. A recovered pending bootstrap is
terminally uncertain and reports failed without replay, even if interruption
happened before actual invocation. A fresh request ID cannot retry bootstrap for
the same machine generation; neither changed input nor another ticket silently
reissues side effects. A future launcher must reconcile authority or clean up
that machine rather than treating failed/unknown delivery as proof of no runtime.

A completed host ACK means launch handoff, **not runtime readiness**. The trusted
launcher still needs enrolment/epoch and health verification before prompting.
The server must authorize the logical sandbox/ticket binding at issuance; this
mailbox is not a public ticket-issuance or arbitrary-runtime API.

Default host credential remains revocable without expiry; planned launch TTL14400
seconds; no disk quota yet. No goldens, resume, Hosts UI or gVisor. Existing host
registration requires ARMADA_DOCKER_HOSTS=1. Upgrade the host binary before sending
new bootstrap jobs; older binaries reject the new operation safely.

## Exact coordinator check

No deploy, remote migration, Docker daemon or real-host mutation needed here:

```sh
bun test packages/mcp-server/test/docker-host-store.test.ts packages/docker-host/test/daemon.test.ts packages/docker-host/test/runtime-install.test.ts
bun build packages/docker-host/src/main.ts --compile --target=bun-linux-x64 --outfile dist/armada-docker-host
```

Expect encrypted bootstrap roundtrip/idempotency, token-free durable receipts,
crash recovery without replay and off-origin rejection. A local executable fixture
checks the real shell handoff and hashes private stdin; no sockets or sleeps.
No real Docker/Codex lifecycle is claimed. Persisted opt-in Docker placement,
ticket/configuration issuance, runtime readiness/prompt/journal, stop/delete and
the final coordinator SSH smoke commands remain the next integration work.
