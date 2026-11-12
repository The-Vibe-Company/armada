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

**Acceptance limitation requiring owner decision:** existing metadata identifies
sandbox *user* owners and launch-time repository branches, not current worker
responsibility for a PR. Otto deliberately does not turn launch defaults,
agent-declared outcomes, or free-text prompts into facts. Consequently current
PR ownership and orphan classification are unknown; `/orphans` exposes unknown
candidates, not confirmed detections. `orphanCount` is null. Historical daily
orphan detection is not claimed. The `day` field is the UTC evaluation day, not
an invented first-seen timestamp. Unknown cannot satisfy staging acceptance for
confirmed ownership or orphans.

To complete that acceptance, identify an authoritative already-observed structured
sandbox↔PR/branch/task source (including legacy non-Armada Boat workers), or approve
a separate observation contract. Do not change protected runtime/provider files
in this ticket to manufacture the missing source. A launch branch is returned as
context with `branchIsCurrent:false`. Private workers are filtered before any
projection/response; no hidden candidates or absence-based orphan assertions.

Coordinator validation: compare all pages of resources with a complete `gh pr list`
for the configured repository. Then validate known and missing-owner examples
against the agreed authoritative source. Reconciliation stale by ten minutes,
missing token, expired credentials, or incomplete pagination must show unknown,
never zero PRs or completed tasks. The dashboard slice remains unimplemented.
