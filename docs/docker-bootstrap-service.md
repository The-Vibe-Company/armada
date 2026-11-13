# Private Docker bootstrap composition (#1165)

`createDockerBootstrapService` is an unmounted, literal-opt-in internal service.
It composes an existing private Docker reservation, acknowledged bound create job,
existing launch credential resolver/admission and Docker runtime projection with
atomic encrypted enrolment issuance and bound bootstrap enqueue. Server origin,
architecture and artifact manifest are trusted factory inputs, never caller inputs.
The sole call is `bootstrap(actor, sandboxId, stableRequestId)`; the response contains
only request ID, operation and pending/completed/failed job state. No response includes
configuration, model secrets or the one-use ticket.

Owner-only authorization precedes credential resolution, including for org admins.
Resolution, native admission and projection run outside the SQL transaction. Inside
it, source members are locked in sorted order before credential SHARE locks, then
host/sandbox/runtime locks. Current scope/status/version, owner/model/pin snapshot,
issuer membership/host authority and the original create actor epoch are rechecked.
Enrolment and enqueue share the same transaction; queue failure rolls back the ticket.
An existing enrolment without this service's bootstrap phase is not replaced.
The host receives only the encrypted bound job's ticket, server origin and artifact
metadata. Runtime configuration stays in the existing encrypted enrolment store.

## Lost responses are reconciliation, not upgrades

A committed bootstrap phase owns its original stable request ID. The same ID loads
the original encrypted canonical job only after current owner authorization and
passes it through bound enqueue to enforce current host and actor-epoch authority.
It never re-resolves the account or reissues the ticket, even after enrolment consumed
it; retries cannot revoke the enrolled runtime. Different IDs fail closed rather than
rotating capability. Changed server origin or runtime artifact digest/size also fail.
Retries do not update harness configuration: a changed harness manifest under the same
runtime digest/size keeps the original configuration, including after enrolment has
erased its pending ciphertext. Runtime upgrades require a future explicit lifecycle,
not a retry. Expired or failed tickets are not automatically replaced.

No public routes, provider registration, golden support, resume, readiness integration
or account-policy fork are introduced. Create/bootstrap ACKs are machine facts, not
runtime readiness; the logical sandbox remains starting. This is not end-to-end Docker
or inference proof.

## Exact coordinator check

```sh
bun test packages/mcp-server/test/docker-bootstrap-service.test.ts packages/mcp-server/test/docker-sandbox-service.test.ts packages/mcp-server/test/runtime-docker-authority.test.ts
```

These use real migrated PGlite, generated offline encrypted account values and the
existing concrete launch credential resolver. They cover admission ordering, sealed
configuration/ticket-only host delivery, lost-commit retry after enrolment, queue
rollback and current pin/host/lifecycle/actor-epoch fences. No network, sockets,
Docker daemon or wall-clock waits. A real coordinator install/register/one-prompt
smoke and later public lifecycle wiring remain separate work.
