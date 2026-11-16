# Docker reservation failure investigation (#2253)

## Scope and conclusion

Code/migrations only; no production access or database mutation. The observed
phase does not identify a failing statement. There is no demonstrated missing
forward migration in the checked-in history, so this change does not guess at a
schema repair. A successful release does not establish that the live schema,
grants and trigger definitions match that history.

The concrete suspect boundary is the reservation's INSERT into
`public.sandboxes` and its triggers, or a read of the recent `account_turn_queue` table. Account admission reads it
when max_agents is set, but the sandbox INSERT trigger reads it unconditionally
even for uncapped accounts.
Both are now distinguishable from host mailbox and receipt failures.

## Transaction inventory

`docker-normal-launch.ts` takes a request advisory lock, checks sandboxes for
replay, and calls `docker-sandbox-service.ts:reserve` on the same connection:

- Reads docker_hosts (owner, org, installation identity), locks sorted members,
  takes a second request advisory lock, reads sandboxes and locks the selected
  active credential (version, kind, scope, expiry). Optional admission callback
  runs on that connection.
- Optional snapshot reads docker_snapshots and checks host/image/installation.
  Locks docker_hosts, requiring exchanged registration, non-revoked,
  non-draining state and the same installation identity.
- Account admission locks credentials. With max_agents set, it reads sandboxes,
  account_agent_reservations and account_turn_queue, counts working allocations,
  and inserts account_agent_reservations. The reservation table deliberately has
  no sandbox FK: the sandbox is inserted afterwards.
- Host admission reads hardware/overrides/availability and counts physical
  docker_host_jobs joined to sandboxes, excluding acknowledged stops/deletes.
- Inserts sandboxes with docker provider, starting status, private visibility,
  actor ownership, credential/version, model/effort, TTL/expiry and immutable
  host/installation/generation/image/snapshot binding. Golden/source visibility
  remain null. Machine size is not required.
- Enqueue reads/locks sandboxes, docker_hosts and members; joins mcp_actor_epochs;
  checks expiry/state; reads prior docker_host_jobs and optional snapshot;
  encrypts and inserts a bound create docker_host_jobs row, then rereads it.
  Mailbox position uses the table's sequence default.
- Optional pricing writes sandbox_account_usage_pricing. Optional variables and
  secrets read their vault/reference tables; MCP validation reads registry,
  grants and membership, and binding writes mcp_bindings.
- Rechecks members/mcp_actor_epochs, inserts docker_launch_requests (encrypted
  manifest, request hash, actor epoch, async flag), then reloads sandbox and
  receipt. All writes commit together; commit acknowledgement can be ambiguous.

## Historical schema and second-instance audit

Docker enum extension is committed separately in 20261113033000; the following
migration replaces provider/golden guards and adds Docker host FK/binding checks.
20261113140054 broadens harnesses; 20261113170001 permits local image IDs.
The provider identity limit is 200 characters; four UUIDs plus separators and
the armada prefix fit. Docker identity checks require the exact generated name.
The AFTER INSERT release_account_agent_reservation trigger unconditionally
reads account_turn_queue, conditionally reads runtime_commands when ready, and
conditionally deletes account_agent_reservations on settled lifecycle states
(20261115123000). Thus a missing queue relation can break both capped and
uncapped accounts at the sandbox INSERT, not just the admission SELECT.
Other insert triggers include sandbox_visibility_default (golden visibility),
golden_sandbox_admission (golden deletion/admission), sandbox_runtime (runtime
timestamps), and sandboxes_repository_context_guard (golden repository context).
Docker has no golden and these guards must preserve the plain-image lane.
Sandbox insert guards also check lifecycle timestamps, source/owner membership
and private access. Existing model/harness and TTL checks still apply.
There is no required sandbox title column in this history.

Account limits and turn queue migrations are 20261115110000 and
20261115123000; both explicitly grant service_role access. Credentials FK,
reservation PK and bound-job request uniqueness can reject incompatible rows.
Receipt FK/hash/ciphertext checks can reject its INSERT. A stale trigger,
missing relation/column, stale check/enum, sequence permission or missing grant
on a long-lived database cannot be established from release success alone.

A second instance has a distinct host/installation binding. Reservation does
not require a preexisting host placement row, cached runtime artifact, image
presence or enrolment. Hardware absent on a new registration is explicitly
allowed by admitDockerCapacity; reported hardware can instead reject changed
limits or a full host with a specific ProviderError. Runtime preparation and
image pull happen after reservation. The installation identity must match the
exchanged host row, not another instance on the same physical machine.
Missing/revoked membership or incomplete registration is rejected rather than
silently borrowing another instance's authority.

## Coordinator verification after release

On staging, launch on a newly registered second instance and confirm reservation
and startup succeed. No production test was run here.

If production still fails, reproduce once on the owner's selected host and read
the single `docker_reservation_statement_failed` log line for that request:
`statement`, `sqlstate`, `constraint`, `relation`. For example,
`insert:public.sandboxes / 23514 / <constraint> / sandboxes` identifies the exact
constraint to compare with migration history. Do not collect detail, hint,
parameters or message. If no statement line appears, read
`docker_launch_failed` with statement=reservation_transaction: a BEGIN/COMMIT
or non-SQL precondition failed rather than an individual query.
Known account/host capacity errors retain their specific client messages.
