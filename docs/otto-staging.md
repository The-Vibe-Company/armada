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
