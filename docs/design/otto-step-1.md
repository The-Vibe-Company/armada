# Otto step 1: observed control tower

Scope: #1277, following #1273. Read-only means no launch, message, wake-up,
refusal, completion mutation, or provider operation. Dashboard delivery is slice 4.

## Storage and boundaries

New server module: `packages/mcp-server/src/otto/`; browser-safe DTOs:
`packages/core/src/otto/`. New additive migrations only; existing columns untouched.
All observations are scoped to an organization and an explicitly configured repository.
No GitHub identity is inferred from an Armada organization name.

- `otto_facts`: append-only journal, UUID, org, repository, subject, kind,
  value (`true`, `false`, `unknown`), observed_at, source, source_id, JSON evidence,
  completeness (`complete`, `partial`, `unknown`). Delivery IDs deduplicate retries.
  No raw webhook bodies, prompts, credentials, or arbitrary provider events retained.
- `otto_tasks`: read-model rows keyed by org/repository/issue number, title,
  inferred state and observation reference; no writable task-management API.
- `otto_resources`: read-model rows keyed by org/repository/kind/external ID,
  task reference, owner evidence and observation reference. Ownership can be unknown.

Journal writes belong to the server only; no UPDATE/DELETE, including service role.
RLS plus explicit revocations deny direct user writes. Read APIs recheck membership;
private sandbox metadata remains visible only to its access owner, never to all org members.
Projection is replaceable; journal evidence is not. Facts never assert task completion.

## Facts and sources

| Kind | Evidence / source |
| --- | --- |
| pr.open / pr.head | GitHub pull_request webhook or REST pulls listing |
| repository.open_prs | Completed paginated REST listing, with observation identity |
| check / check_suite | GitHub check_run/check_suite webhook, exact head SHA |
| merge_group | GitHub merge_group webhook, exact head SHA |
| main.push | GitHub push webhook, configured default branch only |
| issue | GitHub issues webhook or reconciliation |
| sandbox.live | Existing sandbox lifecycle status and last observation time |
| owner.link | Exact repository/branch or explicit existing metadata linkage |

Verify SHA-256 webhook HMAC over bounded raw bytes before parsing; reject wrong
repository and unsupported event shapes. Delivery replay is idempotent.
Webhook events are point observations, never proof of a complete repository listing.
Reconcile with authenticated conditional REST requests; validators are per URL/page.
A 304 reuses only a durably stored successful page. Follow pagination to its end;
errors, rate limits, truncation and missing cached pages produce unknown completeness.
A completed traversal is an observation window, not an atomic GitHub snapshot.
Partial observations may add positive evidence but never retire missing PRs.
Failed or stale observations remain visibly unknown; absence never means false unless
the relevant universe was completely observed. Webhook-only operation cannot enumerate it.

## Current fleet ownership, without worker cooperation

1. A PR identifies repository, number and exact head repository/ref/SHA.
2. `codex/<issue>-…` in that ref is an issue candidate in the same repository,
   not a human owner or proof of a live worker. Fork refs must not collide.
3. Existing Armada sandbox rows identify org, user owner, visibility, provider ID,
   repository directory/project, lifecycle and golden configuration. Golden repo
   branches are launch defaults, **not** proof of a sandbox's current checkout.
4. Existing managed-child/task or persisted prompt metadata may supply explicit
   issue/branch evidence. Match only exact, structurally validated metadata;
   do not parse free-text prompts as authoritative ownership or run sandbox exec.
5. One exact live sandbox match gives a worker owner; conflicting matches yield
   unknown with candidate IDs filtered to the caller's visibility. A user owner
   alone does not establish responsibility for a PR.

Not derivable for every current worker: actual checkout branch, reliable issue ID,
receipt of a delegation, parent outside managed-child records, authoritative last
activity, or whether an idle worker should act. Unregistered Boat sandboxes are not
in the Armada database; Armada cannot claim its inventory covers those machines.
Without complete ownership evidence, report unknown, not a fabricated orphan.
A confirmed orphan requires complete relevant inventory and no live match.
An idle-owner-needs-work orphan additionally requires exact-head failure evidence
and an observed idle turn; stale lifecycle data cannot prove it.

## API contract (slice 3)

Authenticated GET `/api/v1/otto/{summary,tasks,resources,orphans,facts}` with
`org_id`, repository scope and bounded cursor pagination. Every response includes
`observedAt`, `completeness`, `items`, `nextCursor`; summary includes counts whose
unknown values are null, never zero. No unbounded dumps or cross-org fallback.
Tasks expose issue origin, deduced state, evidence IDs; resources expose PR head,
owner (`owned`, `orphan`, `unknown`), task link, reason and observation time.
Orphans include reason, first/last observation and UTC day; distinguish current
orphans from today's historical detections. No secret payloads or private candidates.
Facts are ordered by stable observation/ID cursor, not client-provided SQL.

## Operator setup and next step

Slice 2 documents the exact webhook URL, secret environment name, GitHub App
repository read permissions and event subscriptions. With no webhook configured,
conditional reconciliation must still run without a model or worker cooperation.
No credentials are embedded in this note or golden snapshots.
Slice 3 does not complete staging acceptance until coordinator comparison against
`gh pr list`; inventory coverage gaps must be shown explicitly in that comparison.

Spec **step 2** later adds intentions/receipts, obligations, refusals, rules and
server wake-ups. It is not implementation slice 2 of this read-only step.
No decisions on token identities, privileged verification, rule approval, pressure
limits, fresh conversations or Otto's provider are made here. No new agent powers.
