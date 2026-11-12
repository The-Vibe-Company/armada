# Routines (#1006)

A routine launches a normal sandbox from a template and a prompt at an interval.
It is not an orchestrator, workflow engine, or privileged service identity.

## Delivery slices

1. **Slice 1 (#1011):** configuration API, pinned template references, paused-only storage,
   read isolation and authorization. No timer, launch, or enabling endpoint is
   shipped. The API is a foundation, not completion of #1006.
2. **Slice 2 (#1014):** server scheduler, durable run history/claims, pause/resume and cost guards.
3. **CLI + coordinator checks (#1027):** API-only `armada routine …` commands and a bounded coordinator staging check.
4. **Dashboard (also #1027):** Run > Routines using CreateDialog; optional read-only iPhone last.

## Configuration and identity

A routine has an ID, immutable org/owner/scope (`personal` or `org`), name,
`templateId`, pinned positive `templateRevision`, prompt, integer `intervalHours` (1–720),
`ttlSeconds` (300–86400), and `maxRunsPerDay` (1–24). Creation defaults are 24 hours, 3600-second TTL and 24 daily runs. Prompt is nonblank, at most 32,000 characters;
never a place to store secrets. Configuration is initially paused. Deleted is
terminal. Follow-latest is deliberately not supported: editing a template must
not silently change an unattended job. Updating a routine's revision is explicit.

Personal routines are visible/writable only by their owner while still a member.
Org routines are member-readable and admin-writable; their execution owner never
changes, including when another admin edits them. Creation of org routines
requires admin role. Template and revision must belong to the same org and be
visible to the execution owner. Org routines cannot reference personal templates.

Each firing runs **as the owner**, with current membership and resource access,
current credential resolution (user over org), and current template admission.
No credentials are copied to the routine or cached for unattended execution.
Leaving the org, losing privileges required by an org routine, deleting the
owner, or losing referenced access prevents launches; it never falls back to
an admin or service account. Owner deletion must pause/refuse, not reassign.
Org admins see routine configuration, but not another actor's launch manifests
or private runtime contents. History exposes only authorized sandbox links and
closed, value-free diagnostic codes/messages, never raw provider errors.

## Scheduler contract

Persist `enabled/paused/deleted`, `next_due_at`, configuration generation,
consecutive failures and last outcome. Serialize admission per routine in SQL;
lock/check current routine state and configuration before committing an occurrence.
Owner authorization is checked before dispatch and again at provider admission;
refusals remain durable failed attempts rather than disappearing from history.
The occurrence identity is `(routine_id, scheduled_due_at)` with a unique durable
row. Store the owner, pinned revision, prompt/config snapshot and launch request
key in that row before any provider call. Submit that same key through the existing
template launch claim on every retry or replica. Never create another key for
an uncertain launch; reconcile the existing claim. This reuses template golden
fences and frozen manifests rather than inventing a second launch path.

Before launch, inspect the previous nonterminal run. A sandbox still running
(including a completed prompt in a live machine) or an uncertain launch means
**skip**, never queue or overlap. Record `previous_run_alive` or
`previous_run_uncertain` visibly. Schedule advancement is committed with the
occurrence decision. A final lease/state fence runs after the template claim is
durable and immediately before provider fork, so an expired preflight caller
cannot launch after a replacement worker settles its occurrence. After downtime, consider at most one due occurrence, then
advance to the first future interval; record missed intervals as an aggregate,
not a catch-up queue. Scheduler timestamps use database time, not replica clocks.

Count every admitted launch attempt, even failures/uncertain outcomes, against
`maxRunsPerDay` in a rolling 24-hour window using the locked durable history.
Skipped occurrences do not consume launch budget. A budget exhaustion skips with
`daily_limit_reached`; three consecutive terminal launch failures auto-pause with
a readable reason. Skips do not reset the failure count. Successful admission
resets it; later agent-task failure is a run outcome, not a launch retry.

Every run gets the configured TTL through the normal launch path. Do not rely
on prompt completion to stop the machine. Existing sandbox cleanup remains the
owner of retention/deletion; a stopped/deleted previous sandbox permits the next
run. Neither routine deletion nor pausing silently stops a running sandbox.
Deletion tombstones the routine, forbids new claims, and preserves run history
and idempotency keys. A launch already admitted before pause/delete can finish;
mutation responses and UI must make this boundary explicit. Restart recovery
must reconcile admitted claims before admitting another occurrence.

Run history contains due time, decision, timestamps, configuration generation,
launch request ID, authorized sandbox ID, terminal outcome and closed reason.
Do not persist secrets, readable manifests, raw errors or provider output here.
No cron expressions, timezone/calendar scheduling, triggers/webhooks, chaining,
automatic PR management, orchestration, or catch-up storms.

## Configuration and lifecycle API

Authenticated control API POST routes under `/api/v1/routines/`:
`create`, `list`, `get`, `update`, `delete`, `enable`, `pause`, `history`. The session determines owner; `org` is an explicit org UUID and must be in the
caller’s current memberships. Clients cannot supply owner. IDs are UUIDs. Create accepts name, scope,
templateId, templateRevision, prompt, intervalHours, ttlSeconds and maxRunsPerDay
plus org (creation may omit the three limits to use defaults). Get uses `{org, id}`; delete uses `{org, id, expectedVersion}`.
Update replaces all mutable configuration fields and requires org, id and
expectedVersion; list uses `{org}`. Mutations increment version and stale
versions are refused to prevent lost updates. Owner and scope cannot be changed. Unknown fields are rejected. Updates validate the complete resulting configuration.
User JWTs have SELECT-only RLS access; all writes pass server authorization.

## Coordinator staging checks

Workers hold no staging credentials and must not deploy or apply migrations.
After the coordinator applies the included migration to staging:

- Exercise create/list/get/update/delete as owner, another member, another-org
  user, and org admin. Confirm private rows stay private and JWT writes fail.
- Confirm cross-org/private template references, missing revisions, unknown
  fields fail. Paused routines never launch; enable explicitly to begin scheduling.

On **Modal×Codex and Boat×Codex**:

- Configure the one-hour minimum and observe two normal sandbox launches with
  the exact prompt and pinned template revision; stop the first before the second.
- Pause before due time: no launch. Keep a previous machine alive: visible skip.
- Restart between durable claim and provider completion, and run two replicas:
  exactly one sandbox per occurrence and recoverable history, no lost/double run.
- Simulate downtime: at most one immediate occurrence, no catch-up storm.
- Revoke owner access/credentials; verify refusal, sanitized reason and automatic
  pause after three failures. Exercise daily cap and TTL cleanup.

## Slice 2 operations and recovery

`enable` and `pause` accept `{org,id,expectedVersion}` and increment the version.
Enabling starts the first interval **one interval from database now**, not immediately,
and resets consecutive failures. Updating an enabled definition restarts its interval;
previous admitted occurrences retain their original configuration. Pausing/deleting
clears the next due time, but already admitted runs may finish. `history` accepts
`{org,id}` and returns the latest 100 decisions, newest first, including for a
soft-deleted routine. It includes the durable template request ID and a separate
initial-prompt task state; launch success is not agent-task success. History never returns the private launch input snapshot,
manifest or provider errors. Sandbox links are returned only to the actual sandbox
owner with current org access; other readers receive no sandbox link.

The server has a dedicated tracked scheduler loop, independent of golden builds
and sandbox cleanup. Every replica may run it: SQL row locks, durable occurrence
keys and template launch claims provide correctness, not singleton process state.
Transient SQL failures leave durable records for a later tick. A launch already
uncertain at the provider boundary is **not retried with a new claim**. It remains
visible as uncertain and blocks overlap until reconciled; operators must inspect
the existing sandbox/claim rather than force a replacement. Run history and
idempotency records are retained on routine deletion. No new environment variables
or external scheduler service are required.

A bounded observer polls only the original prompt ID recorded by the template claim,
not the latest conversation turn. It persists the closed states running, finished,
failed, interrupted or unknown, separately from launch admission status. Provider
messages are never stored or exposed as reasons. Unavailable access, a removed sandbox,
or failed observation yields unknown, not invented success/failure; terminal observations
are retained after cleanup. Agent-task failure does not affect launch-failure auto-pause.

## Deployment order

Apply `20261111150000_routine_scheduler.sql` after slice 1's
`20261111140500_routines.sql`, through the coordinator's approved migration process,
**before** starting this scheduler-enabled server version. The new columns and
history tables are required at startup; no new environment variables are needed.
Existing routines remain paused after migration and require explicit enabling.
For rollback, stop the scheduler-enabled server before removing any of its schema;
retain occurrence history and template claim keys so recovery cannot refire a run.


## CLI and bounded coordinator check

`armada routine --help` documents create/list/show/update/enable/pause/delete/runs.
Every command supports `--json`; all requests go through the authenticated Armada
API. Mutations require the current `--expected-version` (except initial create).
Update is a complete mutable-configuration JSON file, not a patch or an exported
show envelope. Prompt files preserve whitespace; use `--prompt-file -` for piped
stdin. Explicit `--org` creation also requires explicit `--scope`.

The coordinator can run the Python 3.9+ stdlib check on macOS or Linux:

```sh
# Securely set STAGING_URL, STAGING_ORG (UUID), and ARMADA_TOKEN in the environment.
# Do not put the token in arguments or paste it into logs.
python3 scripts/routines/staging-check.py --help
python3 scripts/routines/staging-check.py --provider boat --template BOAT_CODEX_TEMPLATE_UUID
python3 scripts/routines/staging-check.py --provider modal --template MODAL_CODEX_TEMPLATE_UUID
```

The minimum interval is **one hour**, so the script cannot truthfully finish in a
few minutes. Each invocation takes about **122 minutes plus setup/cleanup**, with
a 130-minute main deadline and a five-minute cleanup budget (about 135 minutes
maximum under normal bounded HTTP timeouts). The two provider invocations can run
in parallel. It refuses both documented production origins, requires HTTPS, does not
follow redirects, and never prints bearer values, raw errors or event contents.
Existing staging templates/goldens and usable current owner credentials are
prerequisites; when multiple templates are visible, select one explicitly.

The source template is read-only. The script creates a nonce-named private clone
with **only immutable revision 1**, then a one-hour routine pinned to that revision.
It checks the enabled definition, admitted configuration version, template request
ID and exact prompt event in the new sandbox. The sole-revision temporary template
makes the pinned revision unambiguous without database access or private manifests.
It pauses after the first firing, deletes that sandbox so a live-run skip cannot
masquerade as pause, and observes past the next due boundary plus two minutes.
History must retain the same sole occurrence; any skip/failure reason must be a
known closed code with a readable explanation.

A finally block attempts cleanup even after interruption: pause/delete the test
routine, drain its admitted history, stop/delete created compute, and soft-delete
the temporary template. Lost create acknowledgements are discovered by exact nonce
name, never retried as new creates. Definitions are tombstoned and immutable
history is retained by the server; those records cannot be hard-deleted through
the API. Unconfirmed creates, network/auth failures or uncertain late allocations
exit nonzero with the nonce/resource UUIDs for manual reconciliation, never a
false cleanup-success claim. SIGKILL or loss of the coordinator machine cannot
execute cleanup; rerun manual cleanup for the printed nonce in that situation.

**Not proved by this bounded check:** two consecutive firings, live-run skip,
restart/replica idempotency, downtime catch-up behavior, revocation, daily cap and
repeated-failure auto-pause. Use the longer/manual checklist above; do not infer
those checks from a passing script. This worker has not executed staging checks.


## Dashboard slice

Run > Routines lists the selected organization's visible schedules. New opens the
shared centered CreateDialog: choose a published template, enter a prompt and a
whole-hour interval, and optionally set lifetime/daily limits. The selected
immutable template revision is pinned; creation is paused, never an immediate
launch. Personal routines run as their owner, while only admins manage shared
organization routines. Readable prompts are not a place for secrets.

Enable/pause use the displayed optimistic version. A conflict asks for a refresh,
not an automatic retry. Pausing admits no new runs but already admitted work may
finish; it does not stop a sandbox. Selected details load history on demand (not
one request per list row), showing closed readable reasons and the original
prompt outcome independently of launch success. Only sandbox links authorized by
the API are rendered. Empty, unavailable, loading and permission states keep the
same quiet list/create patterns as the rest of the dashboard.

This UI uses the already-deployed routine API and existing tables. It introduces
no migrations or staging/production credential requirements. Screenshot/browser
verification uses the local mock API, not live scheduled launches.
