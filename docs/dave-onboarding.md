# Onboarding: launching agents on Armada (production)

This guide takes a new user from nothing to a coding agent running on Boat or Modal through the production Armada server, from the `armada` CLI or from an MCP client (Claude Code, Codex, Cursor, a coordinator).

**Using your own Linux machine?** Follow the [own-machine quickstart](own-machine-quickstart.md) instead of the Boat/Modal provider steps below. It covers prerequisites, registration, first launch and an optional two-repository snapshot. Self-hosted compute does not mean self-hosting Armada; availability depends on your server operator.

| What | Value |
| --- | --- |
| CLI default and dashboard | `https://armada.thevibecompany.co` |
| Direct server (control API, OAuth, health) | `https://armada-mcp-production.up.railway.app` |
| MCP endpoint (Streamable HTTP) | `https://armada-mcp-production.up.railway.app/mcp` |
| npm package | `@the-vibe-company/armada` (the `armada` command) |

`curl https://armada-mcp-production.up.railway.app/healthz` answers `{"ok":true,"version":"…"}` when the server is up.

## 1. Install the CLI

The package ships a prebuilt binary for linux and macOS (x64 and arm64), so it needs neither Bun nor a build. Version 2 replaces the legacy CLI under the `latest` dist-tag ([release guide](releasing.md)):

```sh
npx @the-vibe-company/armada --help        # run once, with Node 18 or later
bun x @the-vibe-company/armada --help      # or with Bun
npm install --global @the-vibe-company/armada
armada --version
```

Do not install with `--omit=optional`: the binary is the optional dependency `@the-vibe-company/armada-<os>-<arch>` that matches your machine. If `bun x` says that package is not installed, clear Bun's `bunx` cache (`rm -rf "${TMPDIR:-/tmp}"/bunx-*`) and run it again.

From a clone of this repository, `bun run armada <args>` runs the same CLI from source.

## 2. Point the CLI at production

The CLI talks only to the Armada API. It needs no Supabase, provider or database settings. Its default origin, `https://armada.thevibecompany.co`, is the dashboard, which forwards control API requests to the server. MCP clients use the direct server’s `/mcp` endpoint in the table above, not the dashboard origin. For another deployment pass its full URL to `armada login --url https://<your-armada>`, or set `ARMADA_URL`.

## 3. Sign in

```sh
armada login                                # opens the browser; GitHub by default
armada login --provider google              # or Google
armada login --email you@example.com        # no browser: type the code from the email
```

Browser login runs through Armada (PKCE, with a one-time callback on `127.0.0.1`). The CLI never talks to GitHub, Google or Supabase itself. With `--email`, Armada sends a sign-in email and the CLI asks for the code it contains. Without `--email`, the CLI never asks for an email address.

The session (the Armada URL, an access token and a refresh token) is saved in `~/.config/armada/session.json` (`$XDG_CONFIG_HOME/armada` when set), readable only by you. Later commands reuse it and refresh it automatically. `armada logout` deletes it. For scripts and CI, set `ARMADA_TOKEN` to a service token (step 7) instead: it takes precedence over the saved session.

This first sign-in creates your Armada account. An admin can invite you before you have one (step 4); adding you directly from the CLI needs it.

## 4. Create or select an org

For a new organization, choose a name (this guide uses `my-team`) and run:

```sh
armada org create my-team
armada org use my-team
armada org current
```

Creation makes you its first admin. Selection persists for this Armada server; the examples
below also pass `--org my-team` explicitly. Replace `my-team` consistently with your org's
name or UUID. If joining an existing org instead, follow the invitation path below, then
run `armada org use <org>`; an admin must complete its provider setup.

### Joining an existing org

An org admin invites you by email, from the dashboard or with `armada org invitations create <email> [--role admin|member] [--org <name|UUID>]`, or adds an existing account directly from the CLI:

- **Invitation (dashboard or CLI)**: an admin uses **Invite a teammate** on the org's dashboard page or the invitation command above. This creates a pending invitation, including for someone without an account; it does not grant membership. Email delivery is explicitly opt-in through Supabase Auth: see [mail configuration prerequisites](organization-invitations.md#mail-configuration-explicitly-opt-in). When configured, the Auth email can contain a sign-in link that opens the invitation and may authenticate you, but never joins the org. Sign in personally with the invited address as your verified primary email, review the organization, then click **Accept and join**. Opening the link, signing in or previewing it never grants membership.
- **Delivery state**: admins can inspect pending invitations and resend or revoke them. `not_configured` means mail or encryption is unavailable; `pending` means delivery is queued; `failed` means the request was rejected or its transport outcome is uncertain. None means email was sent. `sent` means Supabase accepted the request, not that it reached your inbox. If delivery is not configured, the integration owner must configure it before resending; creating an invitation does not provide a separate token-delivery path.
- **Direct add (CLI)**: an admin runs `armada org members add you@example.com --org <org> [--role member|admin]`. This adds an existing account at once, without an invitation or invitation email, so you must have signed in at least once (step 3); otherwise it says "No Armada account has that email. The person signs in with 'armada login' first."

See [CLI invitation management and acceptance](cli-invitations.md) for the command workflow. Acceptance requires your personal login, not a service token.

Once you are a member, check:

```sh
armada org list                          # your orgs: name, your role, id
armada org members list --org <org>
armada snapshot list --org <org>           # the snapshots you can launch
```

Admins also manage roles (`armada org members role <email> admin|member --org <org>`) and removal (`armada org members remove <email> --org <org>`). Anyone can create an org with `armada org create <name>` and becomes its first admin.

## 5. Prepare a first Modal snapshot

Complete these steps in order. A provider connection pays for machines; model credentials
pay for the agent. GitHub sign-in to Armada alone does not authorize repository checkout.

### Connect Modal (org admin)

In the [Modal dashboard](https://modal.com), select the workspace that should own your
sandboxes, open workspace settings and create an **API token** (not a web proxy token).
Copy both its token ID and token secret; see [Modal authentication](https://modal.com/docs/sdk/js/latest/intro).
Using a local text editor, save them outside any repository in `~/.config/armada/modal.json`
(create the directory if needed), with this JSON shape, replacing both placeholder values:

```json
{"token_id":"your_token_id","token_secret":"your_token_secret"}
```

Keep the file private and never commit it or put credential values in command arguments
or shell history. Disable shell tracing (`set +x`) before handling credentials.

```sh
chmod 600 ~/.config/armada/modal.json
armada org connect modal --org my-team --file ~/.config/armada/modal.json
armada org setup --org my-team
```

Alternatively, pipe the same JSON from your secret manager to
`armada org connect modal --org my-team` (no `--file`). Do not pass Modal's TOML
configuration file as JSON. Expect Modal to be configured in setup status; this checks
authentication and stores the pair encrypted, but does not build a sandbox. If connection
fails, fix the pair or workspace access before proceeding. See [provider recovery](#organization-provider-setup-and-recovery)
for replacement and Boat setup. Personal provider credentials do not complete org setup.

### Store a model credential

Start with one named model account. For API billing, create a key in the
[Anthropic Console](https://console.anthropic.com/) for Claude Code or the
[OpenAI API platform](https://platform.openai.com/api-keys) for Codex. Save the value alone
in a private file outside your repository (for example `~/.config/armada/model-key`, mode
`600`), then use the matching command:

```sh
armada creds set anthropic --name "Claude API" --file ~/.config/armada/model-key
# OR, for an OpenAI API key:
armada creds set openai --name "OpenAI API" --file ~/.config/armada/model-key
```

API keys use the key's provider billing account; subscription credentials use the
eligible subscription account's access and limits. A subscription is not free usage
or an API credit balance, and signing in to Armada does not provide a model subscription.
The Boat/Modal machine is billed separately through the connected sandbox provider.

#### Keep an API account and add a subscription

For Codex, keep the OpenAI API account above and add an eligible ChatGPT account:

```sh
armada creds login codex --name "Personal ChatGPT"
armada creds list
```

Approve the native Codex device login in your browser and **keep the terminal/session
open until Armada confirms import**. This creates another account; it does not replace
the API account or automatically switch its billing. If native login is unavailable,
import an existing private Codex login file instead (not in addition to a successful
import): `armada creds import codex --name "Personal ChatGPT" --file ~/.codex/auth.json`.
See [native subscription authentication](native-subscription-auth.md) for prerequisites,
file-based login and recovery.

The list shows account IDs, names, kinds and defaults, never secret values. Copy the
actual IDs for "OpenAI API" and "Personal ChatGPT". After building `first-modal` below,
choose deliberately on each launch (replace the UUID placeholders):

```sh
armada launch first-modal --org my-team --provider modal --agent codex \
  --credential-id <openai-api-account-uuid> "Summarize the repositories"
# OR use the subscription account:
armada launch first-modal --org my-team --provider modal --agent codex \
  --credential-id <chatgpt-account-uuid> "Summarize the repositories"
```

For Claude, keep "Claude API" and run `claude setup-token` locally. Save the
output token alone in a private file outside your repository, mode `600`, then:

```sh
armada creds import claude --name "Personal Claude" --file ~/.config/armada/claude-token
armada creds list
```

There is no `armada creds login claude` device flow. Launch with `--agent claude`
and `--credential-id <claude-api-account-uuid>` or `<claude-subscription-account-uuid>`
to choose the API or eligible Claude subscription account, respectively.

Optionally run `armada creds default <chosen-account-uuid>` to choose the default
for future launches of that agent. Without an explicit ID, your personal compatible
accounts take precedence over the org's; within that scope, a default wins, or a sole
compatible account is used. Multiple compatible accounts without one default require
selection rather than guessing. An explicitly selected refused/expired/revoked account
does not silently fall back to another billing account. Existing sandboxes remain bound
to their chosen account; a new default does not switch them.

These examples create personal accounts. Org admins can add `--org my-team` to account
creation/import, listing and default commands to manage org accounts instead; passing
`--org` to launch alone does not override personal-account precedence.

**Previously used unnamed commands?** Legacy `creds set openai`, `anthropic`,
`codex-auth` or `claude-oauth` without `--name` update the sole account of that
kind in that scope, or create one if absent; ambiguous multiple accounts are rejected.
Different kinds coexist rather than replace each other. In an all-legacy "Default"
setup, the compatibility defaults prefer OpenAI API over Codex auth and Claude OAuth
over Anthropic API. Do not rely on adding a subscription to change billing: list IDs
and select one explicitly. Named creation adds an account; intentional replacement
uses `--id UUID --expected-version N`.

Values are read from hidden input, stdin or a private file, stored encrypted and never
shown again. They do not belong in a snapshot, setup script, command argument or chat.

### Authorize GitHub

```sh
armada github connect
armada github status
```

Complete the browser authorization as the GitHub user who can access **both** repositories.
If installation access is missing, run `armada github install`, select the GitHub account or
organization and grant the Armada GitHub App access to both repositories (ask its owner to
approve if required), then check `armada github status` again. Continue only once connected
with the required repository access. This is separate from using GitHub to sign in to Armada.
See [GitHub App details](github-app.md).

### Build a two-repository snapshot on Modal

Choose two GitHub repositories you can read. In this example replace `your-owner` with
their owner and `frontend` and `backend` with their actual repository names. Replace `main`
with an existing branch in each repository if different. `first-modal` is the new snapshot
name you choose, not an existing snapshot you must obtain.

```sh
armada snapshot create first-modal --org my-team --provider modal \
  --repo https://github.com/your-owner/frontend.git@main \
  --repo https://github.com/your-owner/backend.git@main
```

Repeat `--repo` once per repository; do not use a comma-separated list. This minimal build
needs no project-specific commands. The server checks out both repos in a disposable
builder, scans for secrets, saves the snapshot and cleans up the builder. Only admins
create org snapshots; an ordinary member adds `--private` for a personal snapshot.

For dependencies needed in the snapshot, optionally add `--setup ./golden-setup.sh` to
that create command: this reads a **local** script and executes its contents once in the
builder after checkout, before scanning and snapshotting. By contrast, `--init` commands
are saved configuration executed at **every launch**, after repository pulls; they are not
build-time setup. Neither should contain credentials. See [snapshot configuration](golden-create.md)
for directory layout and project-specific initialization.

Creation prints `Build job: <job-id>`. It normally waits up to 60 seconds. A completed
build yields a snapshot; a queued/running build may instead print `Build is ...` with the
next command. Keep that job ID and read its status:

```sh
armada snapshot build-status <job-id>   # replace with the ID printed by create
armada snapshot list --org my-team --provider modal
```

If still queued/running, check the same job later; do not submit another create. If failed
or `recovery_required`, read its reported error and resolve it before launching. Proceed
to step 6 only when the job is `succeeded` and `first-modal` is listed for Modal.

## 6. Launch from the CLI

```sh
armada launch first-modal --org my-team --provider modal --agent claude \
  "Summarize the two repositories without changing files"
# OR, if you stored Codex credentials in step 5:
armada launch first-modal --org my-team --provider modal --agent codex \
  "Summarize the two repositories without changing files"
```

`armada launch` asks the server to resolve credentials and fork the snapshot. It prints the sandbox id
(`--json` prints the full record). Use that ID for `armada status <sandbox-id>`,
`armada logs <sandbox-id>` and, when finished, `armada stop <sandbox-id>` to stop charges.
Omit the prompt to leave the sandbox waiting for your first `armada send` instead. Optional `--repo` selects one repository already recorded in the
snapshot, by `owner/repo` or by its configured directory, and starts the native agent there: the
agent's real initial working directory, set after the pulls and init and before its first prompt,
also for an idle launch. It is a starting directory, not confinement: the agent can still reach the
other repositories. It is not a URL, and unlike `snapshot create --repo <url>[@branch]` it is given
only once. Unknown or ambiguous selectors are rejected before a machine is allocated. Without it,
launch keeps its previous behavior. MCP `launch` and `POST /api/v1/sandbox/launch` accept the same
optional `repo` string.

## 7. Connect an MCP client

The server accepts three kinds of bearer on `/mcp`:

- an **OAuth** access token, obtained by the client itself (the server is its own authorization server; metadata at `/.well-known/oauth-authorization-server`);
- an Armada **service token**, bound to one org, for automation and CI;
- the Supabase access token of a signed-in session (what the dashboard uses).

**Claude Code, with OAuth** (it opens the browser on first use; sign in as in step 3):

```sh
claude mcp add --transport http armada https://armada-mcp-production.up.railway.app/mcp
```

**A service token**, for a coordinator or a headless client:

```sh
armada token create --org <org> --label coordinator    # prints the token once; Armada keeps only its hash
armada token list
armada token revoke <id>                                # cuts it off at the next request
```

Load the token into the client's environment as `ARMADA_TOKEN` through your secret store or CI secret injection. Do not type a literal token into a shell command, enable shell tracing (`set -x`), or pass a bearer header as a command argument: shell expansion exposes the value in argv even when history contains only a variable name.

For **Claude Code**, edit the project's `.mcp.json` directly (merge this entry with any existing servers). Keep the variable reference literal in the file; Claude Code, not the shell, expands it:

```json
{
  "mcpServers": {
    "armada": {
      "type": "http",
      "url": "https://armada-mcp-production.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer ${ARMADA_TOKEN}" }
    }
  }
}
```

[Claude Code supports environment expansion in header values](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson). For **Cursor**, use its `mcp.json` with the same URL and headers, omit `type`, and change the header value to `Bearer ${env:ARMADA_TOKEN}` ([Cursor interpolation documentation](https://cursor.com/docs/mcp)). The client process must inherit the variable; a desktop app launched outside your shell may not.

These are client-specific configurations, not portable JSON for Claude Desktop or every MCP client. Prefer OAuth for interactive use (omit the token header). For another headless client, verify its documented environment lookup or protected-file support first; do not substitute a literal token or invent a file flag. Never commit a credential value.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.armada]
url = "https://armada-mcp-production.up.railway.app/mcp"
bearer_token_env_var = "ARMADA_TOKEN"
```

## 8. Drive an agent through MCP

The sandbox tools are `launch`, `list`, `status`, `wait`, `logs`, `send`, `steer`, `interrupt`, `exec` and `stop`. Snapshot tools (`golden_list`, `golden_capabilities`, `golden_create`, `golden_update`, `golden_build_status`, `golden_snapshot`, `golden_adopt`) list, build and maintain snapshots. You see your org's snapshots and sandboxes and your own private ones, never another member's private ones. Example arguments:

```jsonc
// golden_list: the snapshots you can launch, with their orgId
{}

// launch: fork a snapshot and start the agent (leave out prompt for an idle, ready sandbox)
{ "golden": "<snapshot>", "harness": "claude", "prompt": "Fix the flaky test in packages/core", "ttl_seconds": 14400 }
// → { "id": "<sandbox id>", "status": "running", "promptId": "…", "expiresAt": "…", … }
// add "org": "<orgId>" when the snapshot name exists in several of your orgs

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

A typical coordination loop is `launch` with a prompt, then `wait` until `settled`, then `logs` with `all: true` to collect final output, then `send` for a follow-up or `stop`. A turn that ends on a usage limit or an expired login marks the sandbox `failed`, and `statusReason` says why.

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
[Providers → Overview](/providers/cloud). Select the intended organization first; these Boat/Modal controls
are separate from Settings personal provider keys and model accounts. Members must ask an org admin to connect compute.
New snapshots, rebuilds and launches use only a provider the organization has connected; snapshots
and sandboxes already on a disconnected provider stay listed and manageable.

The shared authenticated control API exposes `POST org/provider/status` (`{org}`),
`POST org/provider/connect` (`{org, provider, value}`) and `POST org/provider/disconnect`
(`{org, provider}`, admin only, rechecked live). Each returns only
`{org:{id,name,role}, ready, providers:[{provider:"boat",configured},{provider:"modal",configured}]}`.
Readiness is derived from current organization credentials, so interrupted onboarding resumes
without cookies or query flags. Credential repair, account access and managed sandbox operations
remain available even when a provider key is removed.

### Skill installer help

Use `armada skill --help` or `armada skill install -h` for login-free help.
Both help spellings work only at those command boundaries; malformed install
arguments are validated rather than silently returning help. Installation still
requires an explicit project/global target and `--yes`; requesting help never
checks out or installs anything.

### Focused sign-in help

Use `armada login --help` or `armada login -h` before configuring a session.
Email and browser-provider flags are alternatives. Server selection follows
explicit URL, then ARMADA_URL, then Armada's default API origin.
Use a named profile and login URL to keep staging login/preferences separate:

```sh
armada --profile staging login --url https://staging.example.com --provider github
```

Replace the example origin with your actual staging server. Keep the terminal
open until sign-in finishes; use an interactive terminal for email code entry.
A saved personal login does not unset ARMADA_TOKEN: remove that variable from
a command's environment when you intend to use the saved personal session.
Never place tokens in command arguments. Help itself starts no sign-in flow.

Profile selection accepts `--profile NAME` or `--profile=NAME`, or the
`ARMADA_PROFILE` environment variable. The explicit flag wins; omit both to
use the existing default profile. Names are 1–64 ASCII letters, digits,
underscores or hyphens and must start with a letter or digit. The `--` option
terminator protects remote command/prompt arguments from global flag parsing.

Profiles isolate saved sessions and preferences, not environment variables.
`ARMADA_TOKEN` still overrides a saved login in every profile. For token-based
scripts, explicitly select the matching `ARMADA_URL`; do not assume changing
profile switches the token or makes a token belong to a different server.
A named profile without a token needs its own server/login configuration;
root help and focused command help are available before configuration.

```sh
armada --profile staging --help
armada --profile staging org list
```

After the staging login above, inspect organization membership and select the
organization in that profile with `armada --profile staging org use NAME`.
Do not paste session files or tokens into diagnostics or shared logs.


### Credential command discovery

`armada creds --help` (or `-h`) shows a focused index of native subscription
accounts, preset/custom API connections and account metadata operations.
Use leaf help for exact flags. Model/provider credentials are separate from
application vars/secrets. List returns metadata/IDs, not credential values;
remove takes an account ID while legacy rm takes a credential kind.
API keys use provider billing; native subscription accounts need eligible access.
Keep inputs in stdin/hidden input or private files, never command arguments.

### Organization command discovery

`armada org --help` provides the organization command index.
`armada org members -h` and `armada org invitations -h` show their existing
subcommands; use leaf help for flags and authorization requirements.
These explicit help requests do not read saved selections, start login or
perform membership/invitation operations. Bare no-argument invocations retain
their previous behavior.

### MCP command discovery

`armada mcp --help` (or `-h`) shows a focused index of registry,
authorization and sandbox-binding commands. Use leaf help for flags and
secure-input instructions. Connection IDs select registry entries;
sandbox-connections takes a sandbox UUID. Launch-default selection is separate
from authorization; reconnect revokes first. Family help makes no MCP/API
request and leaves bare no-argument invocation unchanged.

### Service-token command discovery

`armada token --help` (or `-h`) provides the focused service-token index.
Use leaf help for flags. Create prints the new secret even in JSON mode; keep
output out of public logs and store it securely. List shows metadata/IDs, and
revoke takes an ID, not a secret value. Armada service tokens authenticate
scripts via ARMADA_TOKEN; they are not model/provider API credentials.
Family help makes no API request or token mutation.

### GitHub command discovery

`armada github --help` (or `-h`) shows a focused integration index.
Manage uses an installation ID from status; refresh uses a sandbox ID.
Connect/reconnect concern account authorization, and install waits for a new
installation. Leaf help explains browser and no-browser output and bounded
waiting. A URL is not authorization proof. Family help does not open browsers
or call GitHub/Armada, and bare no-argument behavior is unchanged.

### Account command discovery

`armada account --help` (or `-h`) shows server status and remote sign-out
choices without making requests or signing out. Remote account logout requires
a personal session; local `armada logout` only clears saved login. Use leaf
help for details, including ARMADA_TOKEN precedence. Bare no-argument account
invocation retains its existing behavior.
