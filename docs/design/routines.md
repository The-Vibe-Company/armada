# Routines (#1006)

A routine launches a normal sandbox from a template and a prompt at an interval.
It is not an orchestrator, workflow engine, or privileged service identity.

## Delivery slices

1. **This PR:** configuration API, pinned template references, paused-only storage,
   read isolation and authorization. No timer, launch, or enabling endpoint is
   shipped. The API is a foundation, not completion of #1006.
2. Server scheduler, durable run history/claims, pause/resume and cost guards.
3. API-only `armada routine …` commands.
4. Dashboard Run > Routines using CreateDialog; optional read-only iPhone last.

## Configuration and identity

A routine has an ID, immutable org/owner/scope (`personal` or `org`), name,
`templateId`, pinned positive `revision`, prompt, integer `intervalHours` (1–720),
`ttlSeconds` (300–86400), and `maxRunsPerDay` (1–24). Defaults: 24 hours,
3600-second TTL, 24 daily runs. Prompt is nonblank, at most 32,000 characters;
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

## Scheduler contract (next PR, not implemented here)

Persist `enabled/paused/deleted`, `next_due_at`, configuration generation,
consecutive failures and last outcome. Serialize admission per routine in SQL;
lock/check current membership, state and configuration before committing a firing.
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
occurrence decision. After downtime, consider at most one due occurrence, then
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

## Configuration API (this PR)

Authenticated control API POST routes under `/api/v1/routines/`:
`create`, `list`, `get`, `update`, `delete`. The session determines owner and org;
clients cannot supply either. IDs are UUIDs. Create accepts name, scope,
templateId, revision, prompt, intervalHours, ttlSeconds and maxRunsPerDay.
Get/delete use `{id}`; update uses `{id, ...configuration changes}`; list uses
an empty body. Owner and scope cannot be changed. Enable/resume and unknown
fields are rejected. Updates validate the complete resulting configuration.
User JWTs have SELECT-only RLS access; all writes pass server authorization.

## Coordinator staging checks

Workers hold no staging credentials and must not deploy or apply migrations.
After the coordinator applies the included migration to staging:

- Exercise create/list/get/update/delete as owner, another member, another-org
  user, and org admin. Confirm private rows stay private and JWT writes fail.
- Confirm cross-org/private template references, missing revisions, unknown
  fields and enabling requests fail; no configured routine launches anything.

After scheduler slice 2, on **Modal×Codex and Boat×Codex**:

- Configure the one-hour minimum and observe two normal sandbox launches with
  the exact prompt and pinned template revision; stop the first before the second.
- Pause before due time: no launch. Keep a previous machine alive: visible skip.
- Restart between durable claim and provider completion, and run two replicas:
  exactly one sandbox per occurrence and recoverable history, no lost/double run.
- Simulate downtime: at most one immediate occurrence, no catch-up storm.
- Revoke owner access/credentials; verify refusal, sanitized reason and automatic
  pause after three failures. Exercise daily cap and TTL cleanup.
