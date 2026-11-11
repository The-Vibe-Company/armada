# GitHub identity in sandboxes

Inside every sandbox Armada launches, `git commit`, `git push` and the `gh` CLI act as the person who launched it. Commits and pull requests are authored by that person, not by a bot. This uses a GitHub App with user-to-server OAuth (expiring user tokens and refresh tokens). There are no personal access tokens.

## How it works

1. **Connect GitHub** (dashboard, Settings). The person authorizes the Armada GitHub App. GitHub calls back `<origin>/github/callback` with a one-time code. The dashboard trades it for a user access token (8 hours) and a refresh token (6 months), asks GitHub who the person is, then lists the App installations that token can see (`GET /user/installations`, kept only when the installation's app slug or app id is this App).
   - Already installed: the refresh token is sealed with `ARMADA_ENCRYPTION_KEY` and stored in `github_connections` through `save_github_connection`, with the GitHub id, login and those installations (which account or org, and whether the App sees all repositories or a selected set). The access token is dropped.
   - Not installed, and `GITHUB_APP_SLUG` is set: nothing is stored yet. The browser is sent to `https://github.com/apps/<slug>/installations/new` with the same state cookie and `state` parameter. With **Request user authorization (OAuth) during installation** on, GitHub installs the App and authorizes in one step, then calls the callback with `code`, `installation_id` and `setup_action` (`install` or `update`).
   - That install return is accepted even when the state cookie is missing (the install started on GitHub, or in another browser). A signed-in Armada session is required; the code is exchanged and the `installation_id` must be an installation of this App, and only then is the connection saved. With no session the login page says so, and nothing is saved. A plain OAuth callback, with no `setup_action`, still requires the state cookie.
   - A user JWT cannot read the ciphertext column or write the table directly (it only selects the other columns, including `installations`, and deletes its row); row level security keeps each row to its owner. Settings shows the recorded installations, a Manage installation link for each, and a warning when none are recorded.
2. **Launch** (`armada launch`, the MCP `launch` tool). The server reads the caller's row, refreshes to get a fresh access token, stores the rotated refresh token (compare-and-swap, so two launches racing cannot lose the new token) and:
   - puts `GH_TOKEN` and `GITHUB_TOKEN` in the fork's environment (never in a golden; forks stay `noEnv` apart from the credentials Armada injects);
   - sets the global git identity to `<name or login>` and `<id>+<login>@users.noreply.github.com`;
   - installs a git credential helper for `https://github.com` that reads `$GH_TOKEN` at run time (no token is written to disk) and rewrites `git@github.com:` and `ssh://git@github.com/` remotes to HTTPS. `gh` reads `GH_TOKEN` by itself.
3. **No connection, a revoked grant or an outage**: the launch still succeeds. The result says `GitHub: not set up.` with the reason (CLI text, `--json` and the MCP `launch` output carry `github: {status, login, message}`; status is `connected`, `not_connected`, `revoked` or `unavailable`). If the git setup itself fails inside the sandbox, the launch fails loudly.
4. **Revocation**: when GitHub answers `bad_refresh_token` the row is marked revoked (once, no retry storm). Reconnecting in Settings clears it.

## Limits to know

- Static sandbox tokens share the owner connection: GitHub advertises eight hours from issuance, but rotation or revocation can invalidate them earlier. Launch does not reset that clock. See [Early rotation investigation](#early-rotation-investigation-952) for repair and automatic-refresh guidance.
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
| Request user authorization (OAuth) during installation | **On**. Connect then sends a person who has not installed the App through installation and authorization together, and GitHub returns to the callback with `code`, `installation_id` and `setup_action`. |
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
| `GITHUB_APP_SLUG` | the slug of the App (`https://github.com/apps/<slug>`). Connect redirects there when the person has no installation, and Settings links to it | no |
| `GITHUB_APP_ID` | optional numeric App ID (not the client id). When set together with the slug, an installation must match both | no |
| `ARMADA_ENCRYPTION_KEY` | already set (seals the refresh token) | already set (opens it) |

The two services must hold the same client id and secret and the same `ARMADA_ENCRYPTION_KEY`. Apply the migrations `supabase/migrations/20261108180000_github_connections.sql`, `20261108190000_revoke_default_grants.sql`, `20261108200000_token_hash_column_grants.sql` and `20261108210000_github_installations.sql` to the Supabase project. `20261108190000` removes Supabase's default table grants, without which a user JWT can read `refresh_token_enc`. `20261108210000` adds the `installations` column and the `installation_list` argument of `save_github_connection`; without it Connect cannot store which accounts have the App. If either variable is missing, Settings says GitHub is not configured and launches report GitHub as `unavailable`.

Nothing secret is printed or logged. Tokens are masked in command output (`gh[pousr]_...`), kept out of goldens, and the refresh token only ever exists as ciphertext. When GitHub refuses the callback or the token request, the dashboard logs only the OAuth `error` and `error_description` (for example `redirect_uri_mismatch`), so a misconfigured App can be diagnosed without a code, a state or a token in the log.

## Reconnect cache deployment (#585)

Apply `20261110110100_github_reconnect_cache.sql` after the existing migrations,
then deploy the current server. Drain older server replicas before relying on
the current concurrency safeguards. No dashboard or CLI rollout is required.
The RPC signature and encrypted-only column grants are unchanged.

Reconnect atomically clears both cached access-token columns while replacing
the identity and refresh token. Although the reconnect RPC still takes its
advisory lock, server refresh no longer holds that lock or a pooled transaction
during GitHub HTTP. A per-process owner queue orders local refresh callers;
across replicas, a durable consumed-token fence prevents replay, and token
compare-and-swap guards rotation and profile publication. Validation re-reads
the connection before returning a token.

Reconnect can therefore finish while an older refresh is in flight. If that
refresh observes the changed grant during publication or validation, it returns
retryable `unavailable` rather than overwriting the new identity or handing out
the old account's token. A caller that loses the consume fence re-reads once
and returns retryable `unavailable`. If the token changed, it asks for a retry
without asking the person to reconnect: another replica has published a rotation.
If the token is unchanged, a rotation may still be pending, so retry shortly;
if this persists, reconnect GitHub in the dashboard under Settings. An outage,
timeout or crash after the durable fence was written can leave the token
permanently unchanged, and reconnect is then the recovery path. No automatic
retry reuses consumed refresh material. See the connection-residence and
overlap budget in [Production readiness](production-readiness.md#connection-residence-during-github-operations).

## Early rotation investigation (#952)

GitHub [documents eight-hour expiry and invalidation of the old access token on refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
The resolver does **not** assume eight hours: it stores GitHub's returned
`expires_in` as an absolute access expiry. Eight hours (28,800 seconds) is the
normal configured lifetime, not a guarantee that an injected token will remain
usable for eight hours after launch. Launch admission and Modal restore require **more than one
hour remaining**, not a newly minted token. Golden creation, account-status
reads and managed-runtime brokering use the five-minute refresh margin;
legacy explicit repair/next-prompt hydration uses zero.

All resolver callers share one owner connection: launch, golden creation,
account-status reads (dashboard/mobile/CLI through the account API), managed
runtime brokering, Modal restore, and legacy repair/prompt preparation. Any can
refresh a missing cache, an explicitly rejected access token, or a cache below
its caller's lifetime threshold. Dashboard OAuth reconnect drops the cached
access token; the next resolver then rotates. The account API callback instead
persists its returned access token. Refresh fencing prevents replay, not
rotation by a later authorized caller.

For the Nov 11 09:02–09:24Z incident, the coordinator confirmed historical
GitHub evidence is unavailable: deployment `f1077743` served 08:57–09:27Z
and its 52 log lines contain only preservation/lifecycle events, no GitHub
events; `88d7445a` followed at 09:27Z. The reported token copies obtained at
08:01, 08:51, 09:01 and 09:02 failed by 09:25; the 09:24:27 launch and
09:26 repairs worked. This bounds a possible rotation to 09:02:19–09:24:27,
potentially the last launch itself, but does not identify its caller or reason.
The actual production-issued lifetime is unknown, not twenty minutes inferred
from sandbox age. This PR is diagnostics only and does not close #952.

Code trace of the repair/launch expiry hypothesis:
- `refreshLegacyGitHub` uses a zero minimum lifetime. A healthy cached token is
  hydrated with its existing `accessExpiresAt`; repair does not mint a separate
  short-lived token or reset its age.
- If refresh is necessary, `requestTokens` computes expiry as response-time
  `now + expires_in * 1000`; `rotateGitHubToken` stores that exact ISO timestamp
  in `github_connections.access_expires_at` alongside the encrypted token.
- SSH hydration sends the same timestamp as epoch milliseconds to the guest's
  private token file. It does not rewrite the database expiry. A later launch
  reads the database timestamp and requires more than one hour remaining.
- The durable consume fence is reached only after cache reuse fails admission
  or explicit access validation rejects the token. It does not change expiry
  or force rotation; a lost fence returns retryable unavailability without
  replaying a refresh.

Thus no expiry-conversion or fence-induced early-rotation defect was found in
this code trace. A genuinely fresh eight-hour token from 08:40 would pass
09:24 launch admission. However, a repair at 08:40 can also merely hydrate an
older cached token: repair time alone does not prove issuance time or remaining
lifetime. Missing/replaced cache, rejection, and threshold-driven refresh remain
possible explanations, not established incident causes.

New structured events (no credentials, codes, state or upstream error bodies):
- `github_token_refresh_started`: owner, server-owned caller, reason
  (`cache_missing`, `insufficient_lifetime`, `access_rejected`), old remaining
  lifetime and required minimum. Emitted only after the durable fence is won.
- `github_token_rotated`: same context plus returned expiry and observed
  remaining lifetime, after GitHub succeeds, **before** local publication;
  a reconnect can still win publication. This captures even a too-short token.
- `github_connection_replaced`: successful dashboard/account OAuth save,
  caller, account/owner identity, observed remaining lifetime and whether the
  access token was cached.

On the next incident, read `github_token_rotated` by `ownerId`: its
`caller`, `reason`, `previousRemainingLifetimeMs`, `minimumLifetimeMs`,
`accessExpiresAt` and `observedRemainingLifetimeMs` identify the remote
rotation decision and returned lifetime. Also inspect
`github_token_refresh_started` for uncertain attempts and
`github_connection_replaced` for reconnects (dashboard uses GitHub account id).
These events only become available after this diagnostics change is deployed;
they cannot reconstruct the historical window.

Interim rule: static token injection has no guaranteed usable lifetime in a
shared connection. Save and push work frequently; on a legacy Boat sandbox use
`armada github refresh <sandbox>` to hydrate the current owner token (it does
not force rotation of a healthy cache). Reconnect only for a revoked/uncertain
grant, not as routine repair. Automatic credential-helper refresh (#908)
is the durable path for workers that must survive expiry or another client's
rotation; do not weaken the refresh fence or promise static tokens survive it.
