# Otto read-only observation setup

Do not apply migrations or deploy from a worker. Coordinator staging actions:

1. Apply the new Otto migration through the normal authorized migration process.
2. Bind `ARMADA_OTTO_ORG_ID` to the organization UUID and
   `ARMADA_OTTO_REPOSITORY` to the exact `owner/repo` full name. No default org.
3. Set server-only `ARMADA_OTTO_GITHUB_TOKEN` to a repository-scoped read token
   (GitHub App installation token supplied/rotated by the owner, or fine-grained
   token). Required read permissions: Metadata, Pull requests, Issues, Checks,
   Contents. No write permission. Rotation is operator-owned in this slice.
4. Reconciliation runs every five minutes without a webhook or model. Conditional
   requests cache ETags independently per page; a failed traversal records partial
   completeness. Token expiry/rate limits never produce an empty complete list.
5. Optional GitHub App webhook: URL `https://<armada-origin>/api/v1/otto/github/webhook`,
   active, content type `application/json`, SSL verification enabled. Generate a
   webhook secret in the owner's secret manager and set that identical value in
   the App webhook secret and server `ARMADA_OTTO_WEBHOOK_SECRET`. Never commit it.
   Subscribe to Pull request, Check run, Check suite, Merge group, Push, Issues.
   Install only on the configured repository. Set `ARMADA_OTTO_MAIN_BRANCH` when
   its default branch is not `main`. The server checks HMAC before parsing.
6. With no secret the receiver returns 503; reconciliation remains operational.
   With no token GitHub listing coverage stays unknown; webhooks alone do not prove
   a complete inventory. Unsupported events are acknowledged without journal data.

No sandbox tokens, provider operations, effects, task completion, or launch policy
changes are introduced. Journal stores selected metadata only, not webhook bodies.

## Read model API and current-fleet limits

Slice 3 adds authenticated GET `summary`, `tasks`, `resources`, `orphans`, `facts`
under `/api/v1/otto/`. Pass `org_id=<bound UUID>` and optionally the exact bound
`repository`. Use `limit=1..100` and the opaque `nextCursor` returned by each view.
Every page carries `items`, `observedAt`, `completeness`, `nextCursor`; responses
are not cached. Resource/task projections are server-owned and disposable.
The facts cursor is an observation-time/UUID pair. No write API is exposed.

## Owners and daily orphans (coordinator decisions on #1277)

Armada DB rows are the complete fleet source in the caller's authorized view.
There are no legacy external-provider workers to import. Human workstations are
not observable. Private sandbox rows and journals are never expanded for admins.
A hidden or unknown active binding prevents absence-based orphan assertions.

Exact repository/ref matching from recorded project or prompt branch tokens gives
`owner.state=candidate`, never confirmed ownership. Multiple matches are UNKNOWN.
A report of this PR and exact head, or an observed head transition between two
observations inside that sandbox's running turn, gives `owned` with
`confirmation=confirmed`. A repeated listing of an unchanged head is not a move.
Candidate IDs are restricted to visible sandboxes; prompts and sealed events are
never returned or copied to Otto facts. Existing Modal scope bindings and Boat's
server encryption key are used only to read existing journals, not provider I/O.
A bounded journal read without a prompt state yields UNKNOWN.

`activity` distinguishes live, idle, not_live and unknown. `observedAt` is the
sandbox observation time and `since` is the last turn transition time. Observations
at least ten minutes old or in the future are UNKNOWN. Durable stopped/failed/deleted DB lifecycle rows are
not_live at the DB read time (not an assertion of external machine state). An old finished turn can
still prove idle when its sandbox observation is fresh. Missing turn state is not
inferred from usage counters. The three orphan reasons are `pr_without_live_owner`,
`live_sandbox_without_task_or_pr`, and `idle_owner_needs_work`.

Needs-work evidence must match the exact current head: a failed REQUIRED check,
a conflict, or observed queue removal after entry. Pending/missing evidence is
UNKNOWN, never a failure. Reconciliation reads PR details (conflicts), classic
required-status-check protection (context + GitHub App ID), latest check runs and
combined commit statuses. All URLs cache selected metadata + ETags independently;
304 reuses stored selected metadata, revalidated before truth is derived. Policy lookup is shared by base branch
within a traversal. A head change during detail lookup yields UNKNOWN work evidence.
Only an observed required failure is positive; another App's same-named failed check
is not. A partial check listing can supply a positive witness but never prove that
no failures exist. Pending checks do not themselves create an orphan.

The existing GitHub observer token needs Administration **read** permission for
classic required-check policy lookup, in addition to Checks/Contents/PR/Issues read.
See [GitHub's branch protection API](https://docs.github.com/en/rest/branches/branch-protection)
and [check-run reference](https://docs.github.com/en/rest/checks/runs).
Do not grant write permission. Policy 403/404 or ruleset-only requirements that
cannot be identified by that endpoint stay UNKNOWN when a failure might be required.
No failures in a proven complete check universe can establish a negative even when
policy is unavailable. Metadata caches exclude PR bodies and check outputs.
Signed `pull_request` enqueued/dequeued events retain exact-head entry/removal
witnesses; removal without an observed entry is UNKNOWN. Stale, reversed or
equal-time conflicting queue notifications are UNKNOWN, not a guessed order. Reconciliation without
webhooks still runs, but cannot invent historical queue entries/removals.

`/orphans?day=YYYY-MM-DD` returns retained UTC detections in this viewer's scope;
default is today. `firstSeenAt` and `lastSeenAt` record actual read-model detections,
not invented start times. `current` is true, false (known recovered/closed), or null
(current truth unknown). Today's unknown candidates are separately marked UNKNOWN.
Detections are recorded when the API evaluates observations; no unobserved interval
or continuously monitored history is claimed. History rechecks current sandbox
visibility and is partitioned by viewer. No raw prompt/report payload is stored.

Summary distinguishes complete GitHub listing, complete visible DB inventory,
ownership completeness and orphan completeness; an unproven total stays null.
`confirmedDailyOrphanCount` counts observed detections, including recovered ones.
Compare every paginated PR with a complete `gh pr list` in staging. Provisioning,
webhook configuration, migration application and deployment remain coordinator-only.
The dashboard slice is reserved for its assigned frontend agent.

PR webhook state uses GitHub's `updated_at`, not receipt time, so delayed events
cannot replace a newer observed head. Missing/future PR timestamps are rejected.
Reconciliation points retain page-observation times, not transaction admission
or later per-PR work-query time. Work evidence IDs/times are returned in resource
`evidence.workFacts` for inspection.
