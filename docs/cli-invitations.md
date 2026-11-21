# Organization invitations

All commands use the authenticated Armada control API. No provider credentials,
Supabase configuration, or database access is needed on the terminal.

## Admin management

Use **Invite a teammate** on the organization dashboard to create an invitation.
Admins can list, resend and revoke invitations there. For scripting, see the
[administration API routes](cli-admin.md#organization-invitations). Public
invitation records contain IDs and delivery metadata.

The server owns recipient validation, authorization, expiration, duplicate and
already-member handling, rate limits, resend invalidation, and revocation.
Creating an invitation does **not** grant membership. Inspect `delivery` separately
from invitation `status`: `not_configured`, `pending`, and `failed` do not mean
email was sent. `sent` means the email provider accepted the request, **not** proof
of inbox delivery. After an uncertain request, list invitations before retrying.

## Accept an invitation

First use `armada login` to sign in personally with the invitation recipient's
verified email. A service token is not a substitute for that personal login;
unset `ARMADA_TOKEN` if it overrides your saved login. The server checks identity.

The email link opens `/invitations/accept?token=...` on the dashboard; opening it
or a link preview never joins an organization. Only explicit acceptance joins.
A wrong verified email, expired/revoked token, or replay is rejected by the server.
Resending invalidates the previous token; use the new email's token.

## Direct membership

An organization admin can use `armada api members/add -` for an existing account.
This grants membership immediately without email.
