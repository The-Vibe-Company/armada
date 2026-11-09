# Onboarding: launching agents on Armada (production)

This guide takes a new user from nothing to a coding agent running on Boat or Modal through the production Armada server, from the `armada` CLI or from an MCP client (Claude Code, Codex, Cursor, an orchestrator).

| What | Value |
| --- | --- |
| Armada server (control API, OAuth, health) | `https://armada-mcp-production.up.railway.app` |
| MCP endpoint (Streamable HTTP) | `https://armada-mcp-production.up.railway.app/mcp` |
| npm package | `@the-vibe-company/armada` (the `armada` command) |

`curl https://armada-mcp-production.up.railway.app/healthz` answers `{"ok":true,"version":"…"}` when the server is up.

## 1. Install the CLI

The package ships a prebuilt binary for linux and macOS (x64 and arm64), so it needs neither Bun nor a build. Version 2 replaces the legacy CLI under the `latest` dist-tag (docs/releasing.md):

```sh
npx @the-vibe-company/armada --help        # run once, with Node 18 or later
bun x @the-vibe-company/armada --help      # or with Bun
npm install --global @the-vibe-company/armada
armada --version
```

Do not install with `--omit=optional`: the binary is the optional dependency `@the-vibe-company/armada-<os>-<arch>` that matches your machine. If `bun x` says that package is not installed, clear Bun's `bunx` cache (`rm -rf "${TMPDIR:-/tmp}"/bunx-*`) and run it again.

From a clone of this repository, `bun run armada <args>` runs the same CLI from source.

## 2. Point the CLI at production

The CLI talks only to the Armada API. It needs no Supabase, provider or database settings, and the production server, `https://armada.thevibecompany.co`, is its default. For another deployment pass its full URL to `armada login --url https://<your-armada>`, or set `ARMADA_URL`.

## 3. Sign in

```sh
armada login                                # opens the browser; GitHub by default
armada login --provider google              # or Google
armada login --email you@example.com        # no browser: type the code from the email
```

Browser login runs through Armada (PKCE, with a one-time callback on `127.0.0.1`). The CLI never talks to GitHub, Google or Supabase itself. With `--email`, Armada sends a sign-in email and the CLI asks for the code it contains. Without `--email`, the CLI never asks for an email address.

The session (the Armada URL, an access token and a refresh token) is saved in `~/.config/armada/session.json` (`$XDG_CONFIG_HOME/armada` when set), readable only by you. Later commands reuse it and refresh it automatically. `armada logout` deletes it. For scripts and CI, set `ARMADA_TOKEN` to a service token (step 7) instead: it takes precedence over the saved session.

This first sign-in creates your Armada account. An admin can invite you before you have one (step 4); adding you directly from the CLI needs it.

## 4. Join an org

An org admin invites you by email from the dashboard, or adds an existing account directly from the CLI:

- **Dashboard**: an admin opens the org's page and fills in **Invite a teammate** (email and role). Armada emails you a link; you sign in or create your account with that address, then click **Accept and join**. Opening the link joins nothing: only the button does. The admin sees each pending invitation with its email state (*Sent* means the mail service accepted it, not that it reached your inbox) and can resend or revoke it.
- **CLI**: an admin runs `armada org members add you@example.com --org <org> [--role member|admin]`. This adds an existing account at once, without an invitation, so you must have signed in at least once (step 3); otherwise it says "No Armada account has that email. The person signs in with 'armada login' first."

Once you are a member, check:

```sh
armada org list                          # your orgs: name, your role, id
armada org members list --org <org>
armada golden list --org <org>           # the goldens you can launch
```

Admins also manage roles (`armada org members role <email> admin|member --org <org>`) and removal (`armada org members remove <email> --org <org>`). Anyone can create an org with `armada org create <name>` and becomes its first admin.

## 5. Credentials

A launch injects only the credentials of the chosen agent: yours first, else the org's. Values are read from stdin or a file, never from an argument, and are stored encrypted. They are never shown again.

```sh
printenv CLAUDE_CODE_OAUTH_TOKEN | armada creds set claude-oauth   # yours, for Claude Code (the token `claude setup-token` prints)
armada creds set codex-auth --file ~/.codex/auth.json              # yours, for Codex
armada creds list --org <org>                                       # kinds and dates, never values
```

Agent kinds: `claude-oauth` or `anthropic` for Claude Code, `openai` or `codex-auth` for Codex. Sandboxes are paid for by the org's Boat or Modal connection: an admin sets it up with `armada org connect boat|modal` (see [Organization provider setup and recovery](#organization-provider-setup-and-recovery)). A member may also store a personal `boat` or `modal` credential for private goldens.

## 6. Launch from the CLI

```sh
armada launch <golden> --agent claude "Fix the flaky test in packages/core" --org <org>
armada launch <golden> --agent codex --repo owner/repo --ttl 2h --json       # no prompt: the sandbox waits, ready
```

`armada launch` asks the server to resolve credentials and fork the golden. It prints the sandbox id
(`--json` prints the full record). Optional `--repo` selects one repository already recorded in the
golden, by `owner/repo` or by its configured directory, and starts the native agent there: the
agent's real initial working directory, set after the pulls and init and before its first prompt,
also for an idle launch. It is a starting directory, not confinement: the agent can still reach the
other repositories. It is not a URL, and unlike `golden create --repo <url>[@branch]` it is given
only once. Unknown or ambiguous selectors are rejected before a machine is allocated. Without it,
launch keeps its previous behavior. MCP `launch` and `POST /api/v1/sandbox/launch` accept the same
optional `repo` string.

## 7. Connect an MCP client

The server accepts three kinds of bearer on `/mcp`:

- an **OAuth** access token, obtained by the client itself (the server is its own authorization server; metadata at `/.well-known/oauth-authorization-server`);
- an Armada **service token**, bound to one org, for orchestrators and CI;
- the Supabase access token of a signed-in session (what the dashboard uses).

**Claude Code, with OAuth** (it opens the browser on first use; sign in as in step 3):

```sh
claude mcp add --transport http armada https://armada-mcp-production.up.railway.app/mcp
```

**A service token**, for an orchestrator or a headless client:

```sh
armada token create --org <org> --label orchestrator    # prints the token once; Armada keeps only its hash
armada token list
armada token revoke <id>                                # cuts it off at the next request
```

Keep the token in a secret store or an environment variable (`ARMADA_TOKEN` below), never in a file you commit. Then pass it as a bearer:

```sh
claude mcp add --transport http armada https://armada-mcp-production.up.railway.app/mcp \
  --header "Authorization: Bearer $ARMADA_TOKEN"
```

A JSON MCP configuration (Cursor's `mcp.json`, Claude Desktop, most orchestrators), with OAuth (leave out `headers`) or a token:

```json
{
  "mcpServers": {
    "armada": {
      "url": "https://armada-mcp-production.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer ${env:ARMADA_TOKEN}" }
    }
  }
}
```

How environment variables are interpolated differs between clients (`${env:NAME}` in Cursor, `${NAME}` in Claude Code's `.mcp.json`). Check your client's documentation.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.armada]
url = "https://armada-mcp-production.up.railway.app/mcp"
bearer_token_env_var = "ARMADA_TOKEN"
```

## 8. Drive an agent through MCP

The sandbox tools are `launch`, `list`, `status`, `wait`, `logs`, `send`, `steer`, `interrupt`, `exec` and `stop`. Golden tools (`golden_list`, `golden_capabilities`, `golden_create`, `golden_update`, `golden_build_status`, `golden_snapshot`, `golden_adopt`) list, build and maintain goldens. You see your org's goldens and sandboxes and your own private ones, never another member's private ones. Example arguments:

```jsonc
// golden_list: the goldens you can launch, with their orgId
{}

// launch: fork a golden and start the agent (leave out prompt for an idle, ready sandbox)
{ "golden": "<golden>", "harness": "claude", "prompt": "Fix the flaky test in packages/core", "ttl_seconds": 14400 }
// → { "id": "<sandbox id>", "status": "running", "promptId": "…", "expiresAt": "…", … }
// add "org": "<orgId>" when the golden name exists in several of your orgs

// list: your sandboxes, newest first
{ "status": ["running", "ready"], "limit": 20 }

// status: a fresh read of one sandbox and its latest turn
{ "id": "<sandbox id>" }

// wait: block until the latest turn settles, for at most 600 seconds; call again while timedOut is true
{ "id": "<sandbox id>", "timeout_seconds": 600 }

// logs: one bounded page by cursor; pass the returned cursor back to read the next page
// pass all: true to collect available pages (bounded at 100 pages)
{ "id": "<sandbox id>", "limit": 200 }
{ "id": "<sandbox id>", "since_cursor": "<cursor>" }

// send: a new prompt (the first one, for a sandbox launched without one)
{ "id": "<sandbox id>", "prompt": "Now open a pull request" }

// stop: stop the machine when the agent is done, so it stops costing
{ "id": "<sandbox id>" }
```

A typical orchestrator loop is `launch` with a prompt, then `wait` until `settled`, then `logs` with `all: true` to collect final output, then `send` for a follow-up or `stop`. A turn that ends on a usage limit or an expired login marks the sandbox `failed`, and `statusReason` says why.

## Troubleshooting

- `Armada could not reach the server.`: check `--url` / `ARMADA_URL` (step 2) and the network.
- `Run armada login again.`: there is no saved session, or it can no longer be refreshed. Sign in again (step 3), or set `ARMADA_TOKEN`.
- `No Armada account has that email`: the person has not signed in yet (step 3).
- A 401 on `/mcp`: the token is revoked, expired or mistyped. OAuth clients re-authorize by themselves.

### Organization provider setup and recovery

After `armada org create`, connect at least one organization provider before creating new work:

```sh
armada org setup --org <org-id>
# Read a Boat API key or Modal JSON token pair from stdin, or use --file:
armada org connect boat --org <org-id> --file <private-key-file>
armada org connect modal --org <org-id> --file <private-token-file>
```

Modal input is JSON with `token_id` and `token_secret`. Never put secrets in command arguments.
Only a current organization admin may connect; members may inspect setup status.
Personal keys do not complete organization setup. Existing organization Boat keys (including
legacy credential rows) and Modal token pairs count as configured, not perpetually verified.
Connections perform a bounded, read-only authentication check before encrypted storage. A rejected
credential or unavailable provider leaves the stored credential unchanged. No sandbox or App is created.

In the dashboard, an admin connects, replaces and disconnects the active organization's providers in
Settings. New goldens, rebuilds and launches use only a provider the organization has connected; goldens
and sandboxes already on a disconnected provider stay listed and manageable.

The shared authenticated control API exposes `POST org/provider/status` (`{org}`),
`POST org/provider/connect` (`{org, provider, value}`) and `POST org/provider/disconnect`
(`{org, provider}`, admin only, rechecked live). Each returns only
`{org:{id,name,role}, ready, providers:[{provider:"boat",configured},{provider:"modal",configured}]}`.
Readiness is derived from current organization credentials, so interrupted onboarding resumes
without cookies or query flags. Credential repair, account access and managed sandbox operations
remain available even when a provider key is removed.
