# Personal agent defaults

`POST /api/v1/creds/defaults/set` stores one personal selection for each `harness`
(`claude`, `codex`, `opencode`). Send `credentialId` (UUID or `null`) and `model`
(model ID or `null`); both fields are required. `null` clears that selection.
An optional `org` reference restricts organization-account selection. This changes
only the caller's defaults, never the account's organization-wide defaults.
A visible account must support the selected agent. One Morph account can be
selected independently for all three agents.

`POST /api/v1/creds/list` includes a top-level `defaults` array containing
`{ harness, credentialId, model }` alongside the existing user/org accounts.
Selections are personal, not per organization. Launches recheck account visibility
and compatibility: a revoked or deleted selected account refuses launch rather
than silently switching billing. Without a personal account selection, legacy
account defaults still apply. An explicit account overrides the personal account;
a different explicit account also avoids inheriting its model. An explicit model
always wins. Clear a broken selection with the endpoint above.

Account metadata includes `rateLimited: true` while a live turn on that account
has structured runtime rate-limit retry evidence whose deadline has not elapsed.
Runtime event ingestion publishes this metadata without requiring a status read.
Progress/terminal events clear it; replayed events cannot restore a completed wait.
Generic provider retries and account concurrency limits are not rate limits.
Absence means no current observed rate-limit wait, not a provider quota estimate.

Deploy both new migrations before this server:
`20261115220000_agent_defaults.sql` and `20261115221500_account_rate_limit.sql`.
The tables/column are server-only; no new user-JWT grants are required.
