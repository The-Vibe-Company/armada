# Private Docker reservation service (#1165)

This internal service reserves a private Codex Docker sandbox and its bound
compute-create job atomically. It does not expose a public launch/provider API,
start a runtime, answer a prompt or claim readiness. Boat/Modal are unchanged.

## Admission and identity

New reservation requires literal enabled:true on the trusted service factory.
The caller supplies a stable request UUID, host/image, selected account pin,
model/effort and optional TTL. That UUID is also logical sandbox/create-job ID.
Do not use a fresh ID to retry an unknown admission.

The service checks current owner/issuer membership in deterministic order before
credential/host/sandbox work, revalidates the active registered host and current
Codex-compatible credential metadata, then inserts the row and bound create job
in one transaction. No key, credential value, model environment or enrolment
token is an input or read into the reservation. A failed queue insert cannot
leave a committed row. Lost commit responses reconcile the same saved identity,
physical generation and deadline rather than provisioning again.

The record is Docker/Codex/private with neutral physical identity and account
references, no fake golden or Boat aliases. It stays starting after compute ACK:
a host machine fact is not an Armada runtime readiness proof.
Existing reservations cannot be adopted by another actor or redirected to a
different host/image/account/model/TTL. Unmanaged rows are not silently adopted.

Current owner/admin metadata and job-outcome reads remain available separately
from new admission. Stop/delete delegate to the bound-job service for its
runtime fence, authorization, frozen descriptor and fact/ACK state transitions.
Disabling new reservation does not turn those retained operations into launches.

## Scope and defaults

The higher-level launcher must resolve model credentials through existing server
policy and compose configuration/one-use issuance/readiness under proper admission.
The service rechecks metadata but is not an account resolver or model endpoint.
No public routes/provider choices/Hosts UI are enabled here.

Existing DEFAULT_LAUNCH_TTL_SECONDS remains four hours. Host credentials remain
revocable without expiry; no disk quota, goldens, resume or gVisor. Runtime
configuration/prompts/events still belong to its dial-out channel.

## Exact coordinator check

No worker deploy, migration, real-host access, sockets or inference needed:

```sh
bun test packages/mcp-server/test/docker-sandbox-service.test.ts packages/mcp-server/test/docker-host-store.test.ts
```

Expect default-off and SQL current-scope/pin denials, atomic row/job commit and
rollback, lost-response reconciliation with one generation/job, and owner/admin
metadata/compute-stop/delete ACK proofs. New tests use disposable migrated
PGlite and simulated host facts, no sleeps/network. No real compute or readiness
is asserted. Public orchestration, runtime readiness/prompt/journal and the final
coordinator SSH install/register/one-prompt smoke remain next.
