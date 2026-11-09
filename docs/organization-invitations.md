# Organization invitations (control contract v1)

The browser-safe DTO and request/response types are exported by `@armada/core`
from `packages/core/src/invitations.ts`. All five routes are POST under
`/api/v1/org/invitations/`: create, list, resend, revoke, accept. The dashboard
public-origin proxy forwards these authenticated routes. Existing `members/add`,
`members/role` and `members/remove` remain legacy direct-admin operations; they
are not invitation delivery and are not changed by this migration.

Management requires a live org admin and uses `{org: <org UUID>}` (not a name).
Create adds email and role; resend/revoke add invitation id. List returns
`{invitations}`; mutations return `{invitation}`. Acceptance uses `{token}` and
returns `{orgId,accepted:true}`. Acceptance requires a personal Supabase session
whose current primary email matches and has `email_confirmed_at`. Service/MCP
tokens cannot accept. No GET consumes an invitation. Membership insert uses
ON CONFLICT DO NOTHING, preserving any existing member role.

Errors use the control `{error:{code,message}}` envelope: invalid 400,
unauthorized 401, forbidden 403, not_found 404, conflict 409 (including rate
limit), unavailable 503. Create/resend are serialized per org, limited to one
per minute. Pending duplicates require resend or revoke. Expired invitations
remain pending in the DTO; clients compare expiresAt. Tokens expire in seven
days; resend rotates and invalidates the old token. Revoke and acceptance
invalidate it. DTOs never expose tokens, token hashes or encrypted outbox data.

## Mail configuration: explicitly opt in

No mail is sent merely by applying migration 20261110120500 or by starting an
unconfigured server. Configure all of:

- `ARMADA_INVITATION_MAIL=supabase`
- existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ARMADA_ENCRYPTION_KEY`
- `ARMADA_DASHBOARD_URL`: HTTPS origin only (no path, query, fragment, credentials)
- Supabase Auth's redirect allowlist must permit that origin's
  `/invitations/accept` invitation context, including the token query.
- Supabase Auth email signups and its existing custom SMTP must support OTP
  requests with `create_user:true`.

The adapter uses the official Supabase passwordless email API:
https://supabase.com/docs/reference/javascript/auth-signinwithotp
and https://supabase.com/docs/guides/auth/auth-email-passwordless . It supports
both new and existing accounts; it is not `admin.inviteUserByEmail`.
No SMTP password is needed or read. No global Auth templates are modified.
Messages use existing Auth signup/magic-link branding, not a custom organization
invitation template. This requires existing templates to use the redirect
context; OTP-only templates do not carry an invitation link. The integration
owner must validate template and allowlist compatibility before opting in.

The fixed auth return context is
`<ARMADA_DASHBOARD_URL>/invitations/accept?token=<opaque token>`.
The consumer must implement this page, preserve its context through Auth and
require an explicit acceptance click. It must not log tokens, must remove them
from browser history after capture, and should set Referrer-Policy: no-referrer.
A Supabase magic link can authenticate on GET; it never grants org membership.
Do not enable delivery until this dependent consumer page is deployed.

Delivery outcomes: not_configured means mail or encryption is unavailable;
pending means durable encrypted delivery queued; sent means Supabase accepted
the request, **not** evidence of inbox delivery; failed means rejected or
ambiguous transport outcome. No provider response/error body is persisted.
Encrypted outbox tokens are cleared on success, acceptance or revoke.
An opt-in server worker retries pending/failed entries every minute, maximum
five attempts, with one-minute crash-recoverable leases. Delivery is at-least-once:
a crash after provider acceptance can result in a duplicate message. Resend
creates a new generation; stale attempts cannot overwrite its delivery status.
Supabase's own per-recipient and project limits may reject requests.

## Migration and development evidence

205 is additive: a new service-role-only, RLS-enabled table/index; no existing
member table changes, triggers, backfill, SMTP or external effects. Older Armada
writers continue to work. No invitations or memberships are inferred from
existing accounts. No applied migration is edited. Existing direct membership
and last-admin guards remain unchanged. User JWTs/anon cannot read or mutate
outbox secrets (or this table); all management reads use the authenticated API.

`bun test packages/mcp-server/test/invitations.test.ts` applies the real schema
and exercises delivery failure/retry, resend, expiry/revoke/replay, verified
identity, unauthorized org, concurrent acceptance and existing-admin retention.
The mail boundary captures requests in memory using example.invalid addresses;
no actual email or OTP is sent. Production template/delivery evidence is owned
by the integration owner and is not claimed by these tests.
