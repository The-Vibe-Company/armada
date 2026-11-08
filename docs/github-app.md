# GitHub identity in sandboxes

Inside every sandbox Armada launches, `git commit`, `git push` and the `gh` CLI act as the person who launched it. Commits and pull requests are authored by that person, not by a bot. This uses a GitHub App with user-to-server OAuth (expiring user tokens and refresh tokens). There are no personal access tokens.

## How it works

1. **Connect GitHub** (dashboard, Settings). The person authorizes the Armada GitHub App. GitHub calls back `<origin>/github/callback` with a one-time code. The dashboard trades it for a user access token (8 hours) and a refresh token (6 months), asks GitHub who the person is, and stores the refresh token sealed with `ARMADA_ENCRYPTION_KEY` in `github_connections` through `save_github_connection`, with the GitHub id and login. The access token is dropped. A user JWT cannot read the ciphertext column or write the table directly (it only selects the other columns and deletes its row); row level security keeps each row to its owner.
2. **Auto-install** (same callback, only when `GITHUB_APP_SLUG` is set). Right after the code exchange, while the access token is still in hand, the dashboard calls `GET /user/installations` as the person and looks for an installation whose `app_slug` matches `GITHUB_APP_SLUG`. If none exists, Connect GitHub still saves the connection (the person is identified either way) and then continues the browser on to `https://github.com/apps/<slug>/installations/new` instead of landing on Settings, carrying a freshly minted `state` the same way the OAuth step did. Once the person installs the App there, GitHub redirects back to `/github/callback` with `setup_action`, `installation_id` and (when "Request user authorization during installation" is on) a fresh `code`; the matching installation found this way is recorded on `github_connections.installation_id`, a plain column a user JWT can read, so Settings can show installation status and a "Manage installation" link without ever touching the sealed refresh token. See "Install returns and the trust boundary" below for how that second leg is kept safe without the usual CSRF cookie.
3. **Launch** (`armada launch`, the MCP `launch` tool). The server reads the caller's row, refreshes to get a fresh access token, stores the rotated refresh token (compare-and-swap, so two launches racing cannot lose the new token) and:
   - puts `GH_TOKEN` and `GITHUB_TOKEN` in the fork's environment (never in a golden; forks stay `noEnv` apart from the credentials Armada injects);
   - sets the global git identity to `<name or login>` and `<id>+<login>@users.noreply.github.com`;
   - installs a git credential helper for `https://github.com` that reads `$GH_TOKEN` at run time (no token is written to disk) and rewrites `git@github.com:` and `ssh://git@github.com/` remotes to HTTPS. `gh` reads `GH_TOKEN` by itself.
4. **No connection, a revoked grant or an outage**: the launch still succeeds. The result says `GitHub: not set up.` with the reason (CLI text, `--json` and the MCP `launch` output carry `github: {status, login, message}`; status is `connected`, `not_connected`, `revoked` or `unavailable`). If the git setup itself fails inside the sandbox, the launch fails loudly.
5. **Revocation**: when GitHub answers `bad_refresh_token` the row is marked revoked (once, no retry storm). Reconnecting in Settings clears it.

## Install returns and the trust boundary

A plain OAuth callback (`code`, `state`) always requires the `armada_github_state` cookie set by `/github/connect` to match `state`: that CSRF protection is never relaxed, for auto-install or anything else.

An installation return (`setup_action`, `installation_id`, and `code` when "Request user authorization during installation" is on) can legitimately arrive **without that cookie**: installing an App can mean picking repositories, waiting on an org owner, or passing through 2FA, all of which can outlive the cookie's ten minutes, and a person can also reach `https://github.com/apps/<slug>/installations/new` straight from GitHub's own UI, never touching `/github/connect` at all. Refusing every cookie-less return outright would make "auto-install" only as reliable as the cookie's ten-minute lifetime, which defeats the point. So the callback trusts a cookie-less installation return a narrower way instead:

- A `code` is still required. It is exchanged for a token exactly like plain OAuth, which is itself a strong authenticity signal: GitHub issues it once, it expires in minutes, and forging one would require the App's client secret.
- `installation_id` is never read from the query string on faith. The resulting access token calls `GET /user/installations`, and the id is accepted only once it appears there as an installation of the configured `GITHUB_APP_SLUG`. A mismatch is reported as `install_mismatch` and nothing is saved.
- Without a matched `state`, the connection may be **created** (first time connecting) or **refreshed** (same GitHub account reconnecting), but never **switched** to a different GitHub account than the one already on file. That case is reported as `mismatch` and nothing changes.

**The tradeoff.** This is deliberately not full CSRF immunity: within the few minutes a `code` stays valid, someone who captures their own freshly generated install-return URL (by starting their own install and copying the link before using it) and gets a signed-in Armada user to open it could still link that *first* connection to the wrong, but attacker-owned, GitHub account — the ownership check above is satisfied because the attacker genuinely owns that installation. Treat this the same as the well-known login-CSRF class of a social-login "connect" button: the blast radius is narrow (no access to the victim's Armada account or data, and the wrong login is shown in Settings immediately, including on the very next page the person sees) and limited to first-time connections (`mismatch` already blocks it once a real connection exists). Turning on "Request user authorization during installation" and keeping Setup URL empty, as recommended below, is what lets this leg complete in one step instead of leaving `install_pending` for the person to resolve by clicking Connect GitHub again (which is unaffected by any of this: it is a plain OAuth round trip with the usual cookie check).

A GitHub-initiated `setup_action=request` (an org member asking an owner to approve the install) carries no `code`: the callback reports `install_requested` and changes nothing.

## Limits to know

- The token in a sandbox lasts 8 hours. A sandbox that outlives it keeps its git identity but pushes start failing: launch a new sandbox for a fresh token.
- `gh` must exist in the golden. Add an init command that installs the GitHub CLI. Without it git works as the user and `gh` does not (the launch says so).
- The App acts only on repositories where it is installed and the person has access. Install it on each org or account whose repositories sandboxes push to, or let Connect GitHub route there automatically (`GITHUB_APP_SLUG`).
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
| Request user authorization (OAuth) during installation | **On**. Recommended: lets an installation return carry a fresh `code`, so Connect GitHub can record the installation and finish in one step. Without it, installing still works, but the person sees `install_pending` and clicks Connect GitHub once more to finish. |
| Enable Device Flow | off |
| Setup URL | leave empty. The callback URL doubles as the installation return target when the option above is on. |
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
| `GITHUB_APP_SLUG` | optional: without it, Connect GitHub never checks installations and Settings shows none of the status below. With it, Connect GitHub routes a person with no installation of this App straight to `https://github.com/apps/<slug>/installations/new`, and Settings shows installation status and a "Manage installation" link. | no |
| `ARMADA_ENCRYPTION_KEY` | already set (seals the refresh token) | already set (opens it) |

The two services must hold the same client id and secret and the same `ARMADA_ENCRYPTION_KEY`. Apply the migrations `supabase/migrations/20261108180000_github_connections.sql`, `20261108190000_revoke_default_grants.sql` and `20261108210000_github_connections_installation_id.sql` to the Supabase project; the second removes Supabase's default table grants, without which a user JWT can read `refresh_token_enc`, and the third adds the `installation_id` column `save_github_connection` now takes a sixth argument for. If either client variable is missing, Settings says GitHub is not configured and launches report GitHub as `unavailable`.

Nothing is printed or logged beyond a known-safe outcome code (`connected`, `state`, `install_mismatch`, and so on, optionally tagged "install return"): tokens, secrets, authorization codes, cookies, callback querystrings, request bodies and raw GitHub responses never reach a log line. Tokens are also masked in command output (`gh[pousr]_...`), kept out of goldens, and the refresh token only ever exists as ciphertext.
