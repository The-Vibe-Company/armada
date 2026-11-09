# Organization invitations in the CLI

All commands use the authenticated Armada control API. No provider credentials,
Supabase configuration, or database access is needed on the terminal.

## Admin management

```sh
armada org invitations create recipient@example.invalid --role member --org Team
armada org invitations list --org Team --json
armada org invitations resend <invitation-id> --org Team
armada org invitations revoke <invitation-id> --org Team
```

`--role` defaults to `member`; `admin` is also supported. `--org` accepts a name
or UUID and overrides the selection saved with `armada org use`. Without either,
select an organization explicitly. Management requires an organization admin.
All five commands support `--json`; public invitation records never include tokens.

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

Save the token from the invitation link into a private file without putting it in
shell history, then run:

```sh
armada org invitations accept --file /path/to/private-token-file --json
# Or supply the token through a secure stdin source:
armada org invitations accept < /path/to/private-token-file
```

The file contains only the token, not the full URL. Remove the file when finished.
Never pass a token as a positional argument, flag value, or environment variable.
The email link opens `/invitations/accept?token=...` on the dashboard; opening it
or a link preview never joins an organization. Only explicit acceptance joins.
A wrong verified email, expired/revoked token, or replay is rejected by the server.
Resending invalidates the previous token; use the new email's token.

## Existing direct membership commands

`armada org members list|add|remove|role` remain direct administration commands.
`members add` requires an existing account, grants membership immediately, and
sends no invitation email. Use `org invitations create` for an invitation instead.
