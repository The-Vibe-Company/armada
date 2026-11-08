# Onboarding: launching agents on Armada (production)

This guide takes a new user from nothing to a coding agent running on boat.dev through the production Armada server, from the `armada` CLI or from an MCP client (Claude Code, Codex, Cursor, an orchestrator).

| What | Value |
| --- | --- |
| Armada server (control API, OAuth, health) | `https://armada-mcp-production.up.railway.app` |
| MCP endpoint (Streamable HTTP) | `https://armada-mcp-production.up.railway.app/mcp` |
| npm package | `@thevibecompany/armada` (the `armada` command) |

`curl https://armada-mcp-production.up.railway.app/healthz` answers `{"ok":true,"version":"…"}` when the server is up.

## 1. Install the CLI

The package ships a prebuilt binary for linux and macOS (x64 and arm64), so it needs neither Bun nor a build. Version 2 is a prerelease, published under the `next` dist-tag (docs/releasing.md):

```sh
npx @thevibecompany/armada@next --help        # run once, with Node 18 or later
bun x @thevibecompany/armada@next --help      # or with Bun
npm install --global @thevibecompany/armada@next
armada --version
```

Do not install with `--omit=optional`: the binary is the optional dependency `@thevibecompany/armada-<os>-<arch>` that matches your machine. If `bun x` says that package is not installed, clear Bun's `bunx` cache (`rm -rf "${TMPDIR:-/tmp}"/bunx-*`) and run it again.

From a clone of this repository, `bun run armada <args>` runs the same CLI from source.

## 2. Point the CLI at production

Every signed-in command reads these from the environment. Put them in your shell profile:

```sh
export ARMADA_URL=https://armada-mcp-production.up.railway.app
export SUPABASE_URL=<the production Supabase project URL>
export SUPABASE_ANON_KEY=<the production Supabase anon key>
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are the production project's URL and public anon key (Supabase dashboard, Project Settings, API). Ask an Armada admin for them. Do not commit them to a repository. The CLI never takes a service role key or the encryption key, and it doesn't need them.

## 3. Sign in

```sh
armada login --email you@example.com
```

Supabase sends a sign-in email. Either click the link (it signs in through a local page on `127.0.0.1`), or type the code from the email at the prompt. The session is saved in `~/.config/armada/session.json` (`$XDG_CONFIG_HOME/armada` when set) and is refreshed automatically. `armada login` with no flag signs in with GitHub or Google in the browser instead (`--provider github|google`). `armada logout` deletes the session.

This first sign-in creates your Armada account. You must do it before anyone can add you to an org.

## 4. Join an org

There are no invitations. An org admin adds an existing account by email, once that person has signed in at least once (step 3). Either way of adding a member works:

- **CLI**: an admin runs `armada org members add you@example.com --org <org> [--role member|admin]`.
- **Dashboard**: an admin opens the org's page, fills in **Add a member** (email and role) and submits it. This calls the `add_org_member` database function, which checks that the caller is an admin of the org.

If the email has no account yet, both refuse: the CLI says "No Armada account has that email. The person signs in with 'armada login' first.", the dashboard "no account for that email: the person signs in to Armada once first". Once added, check:

```sh
armada org list                          # your orgs: name, your role, id
armada org members list --org <org>
armada golden list --org <org>           # the goldens you can launch
```

Admins also manage roles (`armada org members role <email> admin|member --org <org>`) and removal (`armada org members remove <email> --org <org>`). Anyone can create an org with `armada org create <name>` and becomes its first admin.

## 5. Credentials

A launch injects only the credentials of the chosen agent: yours first, else the org's. Values are read from stdin or a file, never from an argument, and are stored encrypted. They are never shown again.

```sh
claude setup-token | armada creds set claude-oauth          # yours, for Claude Code
armada creds set codex-auth --file ~/.codex/auth.json       # yours, for Codex
armada creds list --org <org>                                # kinds and dates, never values
```

The org's boat.dev key (`armada creds set boat --org <org>`, admin only) pays for org goldens. Kinds: `claude-oauth`, `anthropic`, `openai`, `codex-auth`, `boat`.

## 6. Launch from the CLI

```sh
armada launch <golden> --agent claude "Fix the flaky test in packages/core" --org <org>
armada launch <golden> --agent codex --ttl 2h --json       # no prompt: the sandbox waits, ready
```

`armada launch` asks the server for your credentials and the boat.dev key, then forks the golden from your machine. It prints the sandbox id (`--json` prints the full record). Status, wait, logs, send and stop are MCP tools, so drive the sandbox from an MCP client (below) or the dashboard.

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

The tools are `golden_list`, `launch`, `list`, `status`, `wait`, `logs`, `send`, `steer`, `interrupt`, `exec` and `stop`. You see your org's goldens and sandboxes and your own private ones, never another member's private ones. Example arguments:

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

- `Set ARMADA_URL to the Armada server.` / `Set SUPABASE_URL.`: step 2 is missing from this shell.
- `Run armada login.`: there is no saved session, or it can no longer be refreshed. Sign in again.
- `No Armada account has that email`: the person has not signed in yet (step 3).
- A 401 on `/mcp`: the token is revoked, expired or mistyped. OAuth clients re-authorize by themselves.
