# Secure, server-orchestrated golden creation

`armada golden create --name` builds a golden from one or more GitHub repositories without the
caller ever holding a boat.dev key: the server does the whole build in a disposable, no-env
sandbox and only keeps the result once it has been scanned for leaked tokens. This is a second,
newer way to create a golden; the original `armada golden create <name> --repo <url>` (direct to
boat.dev with `BOAT_API_KEY`, a long-lived master sandbox you `connect`/`snapshot` yourself) still
works unchanged. No database migration is needed: this reuses the `goldens` table and row level
security exactly as the original flow does.

## Security model

- **Checkout credential**: the caller's own cached GitHub user-to-server OAuth access token (the
  same one `armada launch` uses, `docs/github-app.md`, refreshed and rotated through
  `resolveGitHubAccess`). It is read into process memory only, passed to the builder over SSH
  stdin (never argv, a file or `git config`), and **never rotated or revoked** by this flow: it is
  the person's own shared token, good for other uses until it naturally expires.
- **Optional installation token**: when the server has `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`
  (a GitHub App's own signing credentials, separate from the OAuth client id/secret
  `docs/github-app.md` already describes), checkout instead uses a one-hour, repo-scoped
  installation token, minted just before the clone and **revoked right after**. Absent that
  configuration, the build is not blocked: it falls back to the caller's token above.
- **Authorization**: repository discovery and the "do you own this" check are made with the
  caller's own token, never the App's (an App installation can see more than the person who asked
  for a golden). Every requested `owner/repo` must belong to one GitHub App installation the
  caller can see; an org golden requires the caller to be an org admin.
- **Transport**: a transient Ed25519 keypair (written `0600`, removed after the build), the
  provider's own pinned host key (no TOFU), and one shell-quoted remote command that reads the
  token and the public key from stdin before running the build script, so neither is ever in `ps`,
  a log, or shell history (`history -c` runs before the SSH session closes).
- **Fail-closed scan**: before any snapshot, the builder is grepped for `gh[suo]_...`-shaped
  tokens, working tree and git history included (`git log --all -p`, so a token that only exists in
  a past commit still fails the build). Only filenames are ever reported, never a matched value. A
  hit, a timeout, or the scan itself failing to run all stop the build the same way: the sandbox is
  stopped, nothing is persisted.
- **No account secrets in the builder**: the sandbox is created with `noEnv`, the same as the
  original golden flow; nothing from the boat.dev account reaches it.
- Only a golden whose builder reached a **ready** snapshot is written to the database. A failure at
  any step (authorization, checkout, the setup script, the scan, or the snapshot itself) persists
  nothing and still stops and cleans up the builder.

## MCP tool: `golden_create`

Input:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | The golden's name. |
| `repos` | string[] (1–16) | `owner/repo`, repeated. All from one GitHub App installation. |
| `org` | string, optional | An orgId, as in `golden_list`. Needed only when you belong to more than one org. |
| `private` | boolean, optional | Default `false` (your whole org can see it). `true`: only you. |
| `setup` | string, optional | A shell script run in the builder after cloning, before the scan and snapshot. |

Output: `{ name, visibility, snapshot }`. Requires the caller to have connected GitHub
(`docs/github-app.md`); otherwise the call fails the same way `launch`'s `github.status` would
report `not_connected`, `revoked` or `unavailable`.

## Control API: `POST /api/v1/golden/create`

Same bearer and body/response shape as every other control route (`packages/cli/src/control.ts`):
a POST with `Authorization: Bearer <Supabase access token>`, a JSON body, and a JSON response. No
boat.dev key, App key or encryption key ever reaches the caller.

Request body:

```json
{ "name": "web", "repos": ["acme/web", "acme/infra"], "org": "<orgId or org name>", "private": false, "setup": "bun install\n" }
```

`org`, `private` and `setup` are optional with the same defaults as the MCP tool. Response:

```json
{ "name": "web", "visibility": "org", "snapshot": "golden-bx_1a2b3c" }
```

Errors are `{ "error": { "code", "message" } }` with a `GoldenError` code (`invalid_config` → 400,
`forbidden` → 403, `not_found` → 404, `conflict` → 409, `setup_failed`/`snapshot_failed` → 502) or
the usual control API codes (`unauthorized` → 401, `unavailable` → 503 when the server has no
`goldenCreate`/`providerFor` configured).

## CLI: `armada golden create --name`

```
armada golden create --name <name> --repo <owner>/<repo> [--repo <owner>/<repo> ...] \
  [--setup <local-file>] [--private] [--org <org>]
```

- `--name` is what selects this path over the original `golden create <name> --repo <url>`
  positional form; the two cannot be mixed (no positional name, and no `--config`/`--init`, with
  `--name`).
- `--setup` here is a **local file path**: the CLI reads it and sends its contents to the server,
  which runs it as a shell script in the builder. (In the original flow `--setup` instead appends a
  literal command string to `--init`; the two flags share a name but not a meaning, by which path
  you take.)
- Needs `ARMADA_URL` and a signed-in session (`armada login`); does **not** need `BOAT_API_KEY`.

## Server environment

| Variable | Required | Effect |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | yes (already required for `armada launch`'s GitHub identity) | Resolves the caller's cached access token. Without it, `golden_create`/`golden/create` fails the same way `launch` reports GitHub as `unavailable`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | no | Enables the optional scoped installation token. Absent: checkout always uses the caller's own token (still fully functional). |

The server's container needs `ssh` and `ssh-keygen` on `PATH` (the `openssh-client` Debian
package); `Dockerfile` installs it.

## What this does not do (yet)

Launching a sandbox from a golden created this way re-pulls each repo with
`git pull --ff-only` at launch time, exactly like any other golden (`packages/core/src/launch.ts`);
that part needed no changes. A dedicated "open this repo in a running sandbox" CLI/frontend
experience is a separate, later piece of work.
