# Organization invitations

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

Open the invitation email link and sign in to the dashboard with the recipient's
verified email. Review the organization and select **Accept and join**. Opening
the link or previewing it leaves membership pending.

For scripts, use a personal `armada login`. Unset `ARMADA_TOKEN` if a service key
overrides that login. Supply the acceptance JSON through stdin as shown in
the [administration API reference](cli-admin.md#organization-invitations).

A wrong verified email, expired/revoked token, or replay is rejected by the server.
Resending invalidates the previous token; use the new email's token.

## Direct membership

An organization admin can use `armada api members/add -` for an existing account.
This grants membership immediately without email.
