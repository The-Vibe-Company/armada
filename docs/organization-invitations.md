# Organization invitations (control contract v1)

The browser-safe DTO and request/response types are exported by `@armada/core`
from `packages/core/src/invitations.ts`. All six routes are POST under
`/api/v1/org/invitations/`: create, list, resend, revoke, accept, preview. The dashboard
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

## Additive v1 recipient consent and safe reasons

`POST /api/v1/org/invitations/preview` accepts `{token}` in the authenticated
request body, never in the API URL. Personal Supabase login is required; service
and MCP tokens receive 403 with `error.reason=personal_login_required`.
The exported `InvitationPreview` is the exact response contract:

- `state: not_found | wrong_email | unverified_email`, `context: null`.
- `state: ready | expired | revoked | used | already_member`, with context
  `{orgId,orgName,role,expiresAt}` only for a matching, verified current primary
  email. No invited email, member list, current membership role, delivery state,
  hash, ciphertext or token is returned.

Unknown or resend-invalidated tokens return `not_found`. Email mismatch takes
precedence over verification/state; matching but unverified email returns
`unverified_email`. Only after that identity gate, precedence is revoked, used
(accepted), expired, already_member, ready. A client can offer sign-in with the
invited account for wrong_email without revealing which address, verification
for unverified_email, explicit consent for ready, and contact-admin/resend advice
for expired/revoked/not_found. Used means the invitation was already accepted;
check normal org membership access separately. Already_member means membership
exists, not that any role change will occur. Accepting preserves that role.

Preview performs SELECTs only. It never consumes/rotates tokens, creates or
changes membership, changes outbox state, sends mail or retries delivery. It is
an advisory snapshot, not authorization for later acceptance. Acceptance repeats
all identity/state checks transactionally; it is still a single explicit POST.
GET (including link preview) never accepts and the API returns 405 for GET.

`InvitationApiError` adds structured `error.reason` to the existing control
error envelope on invitation-specific failures. Acceptance reasons:
invalid (400), personal_login_required/wrong_email/unverified_email (403),
not_found (404), expired/revoked/used (409). Duplicate management uses
already_member or pending_exists (409); missing pending records use not_found
(404). Invite/resend cooldown uses rate_limited (409) and retryAfterSeconds=60,
a conservative delay from response time. Generic authentication/admin/storage
errors retain the existing code envelope (401/403/503/500); clients must handle
these without parsing messages. The existing acceptance success DTO is unchanged.

Mail failure is not an acceptance failure: create/resend return the invitation
with the existing typed delivery state failed, pending, not_configured or sent.
Recipients' consent preview does not disclose transport details; if they possess
a valid link, delivery failure does not invalidate their invitation. Admin UIs
can offer resend after cooldown on failed/not_configured (after configuration),
show pending honestly, and describe sent as provider-accepted only.

Keep the fixed email-link query out of analytics and logs. On the consumer
acceptance page, capture it in ephemeral state, remove it from history, set
Referrer-Policy: no-referrer, and preserve only the fixed local return path
through authentication (never accept arbitrary redirect targets). Render consent
only from authenticated preview; do not trigger acceptance on page load, Auth
callback, GET or preview. No global Auth template/config change is required by
this API delta. Schema 205 and its hash remain unchanged.
