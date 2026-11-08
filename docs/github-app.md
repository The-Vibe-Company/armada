# GitHub identity in sandboxes

Inside every sandbox Armada launches, `git commit`, `git push` and the `gh` CLI act as the person who launched it. Commits and pull requests are authored by that person, not by a bot. This uses a GitHub App with user-to-server OAuth (expiring user tokens and refresh tokens). There are no personal access tokens.

## How it works

1. **Connect GitHub** (dashboard, Settings). The person authorizes the Armada GitHub App. GitHub calls back `<origin>/github/callback` with a one-time code. The dashboard trades it for a user access token (8 hours) and a refresh token (6 months), asks GitHub who the person is, and stores the refresh token sealed with `ARMADA_ENCRYPTION_KEY` in `github_connections`, with the GitHub id and login. The access token is dropped. A user JWT cannot read the ciphertext column; row level security keeps each row to its owner.
2. **Launch** (`armada launch`, the MCP `launch` tool). The server reads the caller's row, refreshes to get a fresh access token, stores the rotated refresh token (compare-and-swap, so two launches racing cannot lose the new token) and:
   - puts `GH_TOKEN` and `GITHUB_TOKEN` in the fork's environment (never in a golden; forks stay `noEnv` apart from the credentials Armada injects);
   - sets the global git identity to `<name or login>` and `<id>+<login>@users.noreply.github.com`;
   - installs a git credential helper for `https://github.com` that reads `$GH_TOKEN` at run time (no token is written to disk) and rewrites `git@github.com:` and `ssh://git@github.com/` remotes to HTTPS. `gh` reads `GH_TOKEN` by itself.
3. **No connection, a revoked grant or an outage**: the launch still succeeds. The result says `GitHub: not set up.` with the reason (CLI text, `--json` and the MCP `launch` output carry `github: {status, login, message}`; status is `connected`, `not_connected`, `revoked` or `unavailable`). If the git setup itself fails inside the sandbox, the launch fails loudly.
4. **Revocation**: when GitHub answers `bad_refresh_token` the row is marked revoked (once, no retry storm). Reconnecting in Settings clears it.

## Limits to know

- The token in a sandbox lasts 8 hours. A sandbox that outlives it keeps its git identity but pushes start failing: launch a new sandbox for a fresh token.
- `gh` must exist in the golden. Add an init command that installs the GitHub CLI. Without it git works as the user and `gh` does not (the launch says so).
- The App acts only on repositories where it is installed and the person has access. Install it on each org or account whose repositories sandboxes push to.
- Disconnect in Settings deletes Armada's row. To invalidate tokens already issued, also revoke the authorization in GitHub (Settings, Applications, Authorized GitHub Apps).
- No org-level fallback (an installation-token bot) is implemented. Someone who has not connected GitHub gets no GitHub identity.

## Create the GitHub App (owner, once)

GitHub: Settings (of the account or org that owns the app), Developer settings, GitHub Apps, New GitHub App.

| Setting | Value |
| --- | --- |
| GitHub App name | for example `Armada` (the slug is the last part of `https://github.com/apps/<slug>`) |
| Homepage URL | `https://armada.thevibecompany.co` |
| Callback URL | `https://armada.thevibecompany.co/github/callback` |
| Callback URL (local dev) | `http://localhost:3000/github/callback` (GitHub allows several callback URLs; add a Vercel preview origin the same way if you test connecting there) |
| Expire user authorization tokens | **On**. Required: without it GitHub returns no refresh token and Connect GitHub reports the app as set up wrong. |
| Request user authorization (OAuth) during installation | optional |
| Enable Device Flow | off |
| Setup URL | leave empty |
| Webhook, Active | **off** (Armada receives no webhooks) |
| Repository permission: Contents | Read and write |
| Repository permission: Pull requests | Read and write |
| Repository permission: Metadata | Read-only (always on) |
| Repository permission: Workflows | optional; Read and write if agents change `.github/workflows` |
| Repository permission: Issues | optional; Read and write if agents use `gh issue` |
| Where can this app be installed | Any account if people outside your org use Armada, otherwise Only on this account |

Then, on the app's page:

1. Copy the **Client ID** (`Iv1...` or `Iv23...`).
2. **Generate a new client secret** and copy it once.
3. Install the app (Install App) on every account or org whose repositories sandboxes push to, selecting those repositories.

The App ID and a private key are **not** needed: nothing uses installation tokens.

## Environment variables

| Variable | Vercel (dashboard) | Railway (server) |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | yes, build and runtime | yes |
| `GITHUB_APP_CLIENT_SECRET` | yes, runtime | yes |
| `GITHUB_APP_SLUG` | optional: adds an "Install the app on your repositories" link in Settings | no |
| `ARMADA_ENCRYPTION_KEY` | already set (seals the refresh token) | already set (opens it) |

The two services must hold the same client id and secret and the same `ARMADA_ENCRYPTION_KEY`. Apply the migration `supabase/migrations/20261108180000_github_connections.sql` to the Supabase project. If either variable is missing, Settings says GitHub is not configured and launches report GitHub as `unavailable`.

Nothing is printed or logged: tokens are masked in command output (`gh[pousr]_...`), kept out of goldens, and the refresh token only ever exists as ciphertext.
