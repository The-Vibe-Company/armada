# Production readiness and database budget

## Incident #922: evidence and limits

The incident reported two starts four seconds apart, session pooler admission
failure (EMAXCONNSESSION, pool_size 15), and recovery on redeploy with identical
code. This is consistent with connection exhaustion, not proof of which
container held each connection. No production logs/settings were accessed in
this change; confirm live settings and connection counts with the operator.

Code audit: startServer constructs one bunSql shared by auth, control, MCP,
golden jobs and orchestrator/invitation/lifecycle workers. Previously the main
Bun.SQL used its default maximum (10), plus a separate autonomous pool of 2:
up to 12 per process, 24 for two overlapping deployments, already over 15.
Construction is lazy; first boot SQL is MCP invalidation draining. Concurrent
worker/request traffic can expand the main pool at steady state. Workers do
not create their own database clients.

Now each server process is capped at **3 main + 1 autonomous = 4 connections**.
The autonomous connection is deliberately separate: credential refresh claims
must not queue behind transactions waiting on them. Two overlapping processes
use at most 8, three use 12. Budget one migration connection separately: 13 of
15, leaving two for administration. This is a single-replica budget, not a
guarantee for arbitrary overlap or other clients. Audit all clients sharing the
pooler user before increasing replicas. Idle connections close after 30s;
connection establishment times out after 5s. Graceful server stop drains workers
before closing both pools.

Stay on session pooling for this fix. Switching to transaction pooling would
need a separate audit of prepared statements and session/transaction semantics;
it is not required to fit this budget.

Boot retries only transient connection admission/unavailability errors, including
Bun's errno-wrapped EMAXCONNSESSION, for approximately 120s (plus the final
in-flight connection attempt). Backoff starts at 250ms and caps at 5s. Only boot
invalidation draining is replayed; API writes/transactions are never retried.
Permanent SQL/auth/config errors fail immediately. Diagnostics never log driver
messages. Exhaustion closes the pools and exits for platform restart.

## Railway rollout prerequisites (operator, no changes applied here)

railway.json already had /healthz, but only a 30s readiness window and ten
failure restarts. It now allows 180s for boot and uses ALWAYS restart (paid
Railway plan required). /healthz is not served until initial SQL draining
succeeds. Verify the effective service config uses this file, PORT matches the
listening port, no attached volume forces serialized teardown, and no UI/env
override shortens readiness. Do not delete the last healthy deployment manually.

Railway only switches traffic after a successful health check; it does not
continuously monitor that endpoint. No overlap/draining override is added: the
existing default removes the old instance after promotion, avoiding prolonged
connection overlap. Audit RAILWAY_DEPLOYMENT_OVERLAP_SECONDS and
RAILWAY_DEPLOYMENT_DRAINING_SECONDS in the live service. Config alone cannot
prove the historical teardown cause; sanitized deployment logs are needed.

References: [Railway readiness](https://docs.railway.com/deployments/healthchecks),
[restart policy](https://docs.railway.com/deployments/restart-policy),
[teardown](https://docs.railway.com/deployments/deployment-teardown),
[Bun SQL pooling](https://bun.sh/docs/runtime/sql).

## Independent production smoke and alert

The old Post-deploy smoke is explicitly staging-only. It filters success events
for staging, and missing staging credentials produce a successful no-op. Thus
a green workflow never established production availability. Keep this compute
smoke separate; it is not an uptime signal.

Production health now probes the public production API /healthz on all matching
production deployment statuses, manual dispatch, and every five minutes. It
requires a successful status and Armada JSON readiness, rejects redirects, has
a 10s timeout, and requires no token or billable compute. It defaults to the
production API origin documented in dave-onboarding.md. Repository variables
ARMADA_PRODUCTION_ORIGIN and ARMADA_PRODUCTION_DEPLOYMENT_ENVIRONMENT may
override the origin and Railway event environment (default armada / production).
Verify that event name against actual Railway payloads; the schedule is
independent of event routing and staging feature flags.

Failures fail the workflow and open one deduplicated GitHub incident issue.
Operators must enable Actions failure notifications and subscribe to repository
issues; an issue is durable evidence, not a guaranteed paging integration.
Close the incident after recovery; a later outage opens another. GitHub schedule
delivery can be delayed, so this is not a strict five-minute SLA. Configure an
external uptime pager for a guaranteed escalation SLA. No live probe, deploy,
migration or alert creation was performed while developing this PR.
