# Armada

Armada launches coding agents (Claude Code, Codex) on [boat.dev](https://boat.dev) sandboxes, from a golden snapshot, with or without a prompt. Orchestrators drive the agents through a remote MCP server; people use the `armada` CLI, which ships in the same binary.

Armada is a launcher, not an orchestrator: it does not split work, merge pull requests or read a tracker.

- **Specification (v0):** [#455](https://github.com/The-Vibe-Company/armada/issues/455)
- **This scaffold:** [#456](https://github.com/The-Vibe-Company/armada/issues/456)

> **Status:** goldens can be created, connected, snapshotted and listed (`armada golden`), and a golden can be launched into a sandbox (`armada launch`). `armada login` and `armada token` sign a person in and mint service tokens. `armada org` and `armada creds` manage orgs, members and encrypted credentials (#461). `armada serve` runs the remote MCP server (#464): orchestrators list goldens, launch, and then drive the agent (status, wait, logs, send, steer, interrupt, exec, stop).

## Layout

A Bun and TypeScript monorepo (Bun workspaces, strict `tsconfig.json` shared by every package).

| Package | Name | Role |
| --- | --- | --- |
| `packages/core` | `@armada/core` | The contract every other package shares: types, the golden config and workflow, AES-256-GCM for `*_enc` columns (`ARMADA_ENCRYPTION_KEY`), the generated database types, the version. |
| `packages/provider-boat` | `@armada/provider-boat` | The boat.dev placement: the provider adapter over the boat.dev API. |
| `packages/cli` | `@armada/cli` | The `armada` command; `src/main.ts` is the entry of the compiled binary. |
| `packages/auth` | `@armada/auth` | Supabase login (GitHub, Google), the MCP OAuth server, service tokens and bearer checks. |
| `packages/mcp-server` | `@armada/mcp-server` | The remote MCP server (hosted on Railway) that orchestrators call. |
| `apps/dashboard` | `@armada/dashboard` | The web dashboard (Next.js, Tailwind, shadcn/ui) over Supabase: orgs, goldens, credentials, sandboxes. |

`scripts/build.ts` compiles the binary. Every package carries the same version, the one `armada --version` prints (`packages/core/package.json`); a test fails if they drift apart.

## Database

`supabase/migrations` is the schema, applied by the [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase db reset` on a local project, or `supabase migration up`). It assumes a fresh Supabase database: Auth's `auth.users` and `auth.uid()`, and the `authenticated` and `service_role` roles.

`packages/core/src/database.types.ts` is generated from those migrations. After changing them, run `bun run db:types` and commit the result. A test fails if the file drifts. The migrations themselves are checked on a fresh in-memory Postgres, including the row level security rules.

## Install

```sh
npx @thevibecompany/armada@next --help     # or: bun x @thevibecompany/armada@next --help
npm install --global @thevibecompany/armada@next
```

The npm package ships the compiled binary for linux and macOS, x64 and arm64 (one optional dependency per platform), so it needs neither Bun nor a build. Getting started against production: [docs/dave-onboarding.md](docs/dave-onboarding.md). Publishing: [docs/releasing.md](docs/releasing.md).

## Commands

Requires [Bun](https://bun.sh) 1.4.2 (`packageManager` in `package.json`).

```sh
bun install
bun test                 # every package's tests, including one that compiles the binary and runs it
bun run lint             # Biome
bun run format           # Biome, with safe fixes applied
bun run typecheck        # tsc --noEmit, strict
bun run verify           # lint, typecheck and tests: what CI runs
bun run armada --help    # the CLI from source
bun run armada golden create <name> --repo <url>[@branch] --init "<cmd>" [--private]
bun run armada golden connect <name>
bun run armada golden snapshot <name>
bun run armada golden list
bun run armada launch <golden> --agent claude|codex ["prompt"] [--ttl 4h] [--json]
bun run armada login                 # GitHub or Google in the browser (--provider github|google)
bun run armada login --email you@example.com   # a sign-in email: click its link, or type its code
bun run armada token create --org <name> --label <label>
bun run armada org create <name>
bun run armada org members add <email> [--role admin|member]
pbpaste | bun run armada creds set claude-oauth [--org <name>]   # also anthropic, openai, codex-auth (--file), boat
bun run armada creds list
bun run armada serve     # the remote MCP server and the control API, configured by the environment below

bun run build                        # dist/armada for this machine
bun run build --target linux-arm64   # dist/armada-linux-arm64
bun run build:all                    # dist/armada-<target> for linux and macOS, x64 and arm64
./dist/armada --version
```

## Launching

`armada launch` forks a golden's saved snapshot, pulls each repo, runs the init commands and, with a prompt, starts the agent. Without a prompt the sandbox waits, ready, for its first prompt. The fork gets `noEnv`, an explicit TTL (default 4 hours) and Armada's labels, and an environment with only the credentials of the chosen agent. Nothing is written to the golden. A Codex `auth.json` is carried in the environment and written to `~/.codex/auth.json` in the sandbox.

The credentials and the boat.dev key come from the encrypted store: the caller's own, else the org's (`resolveCredentials`, `resolveBoatKey`). A private golden uses its owner's personal boat key when there is one. `armada launch` asks the server for them (`ARMADA_URL`); it holds no encryption key and no service role key.

Inside the sandbox, git and `gh` act as the person who launched it when they connected GitHub in the dashboard (Settings): the launch refreshes their GitHub App user token, injects `GH_TOKEN` and `GITHUB_TOKEN` (never into a golden), sets the git identity to `<id>+<login>@users.noreply.github.com` and configures git to use the token. Without a connection the launch still works and says `GitHub: not set up.` How it works, its limits and how to create the GitHub App: [docs/github-app.md](docs/github-app.md).

## Identity, orgs and credentials

After `armada login` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`), every command acts as that Supabase session: `armada golden` and `armada launch` read it, and take `--org <name>` when you belong to more than one org. The old `ARMADA_SUPABASE_URL`, `ARMADA_SUPABASE_ANON_KEY`, `ARMADA_ACCESS_TOKEN` and `ARMADA_ORG` are gone, as are `ARMADA_CLAUDE_OAUTH_TOKEN` and `ARMADA_OPENAI_API_KEY`. `armada login --email <address>` sends Supabase's sign-in email: clicking the link signs in through a local page (add `http://127.0.0.1:**` to the project's redirect URLs, as for GitHub and Google), and a code typed at the prompt signs in too when the email template carries `{{ .Token }}`. The CLI never holds a service role key or the encryption key.

`armada org`, `armada creds` and `armada launch` call the server's control API (`handleControlRequest` in `@armada/mcp-server`, mounted by #464; the CLI finds it at `ARMADA_URL`). The server checks the Supabase access token, then uses the service role for what a user JWT cannot do (create an org with its first admin, find a person by email, read and write ciphertext).

- Server env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ARMADA_DATABASE_URL` (a privileged Postgres connection, the Supabase `postgres` role), `ARMADA_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`), and `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` for the user's GitHub identity in sandboxes ([docs/github-app.md](docs/github-app.md)).
- Credentials are AES-256-GCM ciphertext in `credentials.value_enc` (org boat.dev key: `orgs.boat_api_key_enc`). Values are read from stdin or `--file`, never from an argument, and never shown again. Kinds: `claude-oauth` (the token from `claude setup-token`, injected as `CLAUDE_CODE_OAUTH_TOKEN`), `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `codex-auth` (`~/.codex/auth.json`, written into the sandbox), `boat`. OpenCode is deferred.
- Members are people who already signed in once. There are no pending invitations.

## The MCP server

`armada serve` listens on `PORT` (default 8080) and answers:

- `/healthz`: `{"ok": true, "version": …}`, without a token.
- The OAuth routes of `@armada/auth` (`/.well-known/*`, `/authorize`, `/token`, `/register`, …), mounted first.
- The control API (`/api/v1/`, see above), which the CLI reaches at `ARMADA_URL`.
- `/mcp`: MCP over Streamable HTTP (stateless, JSON responses). Every request is authenticated again, with no cache; a failure answers 401 with the OAuth challenge. The bearer is one of:
  - an Armada service token or an OAuth access token, bound to one org;
  - a Supabase access token of the project (the dashboard's session), checked by Supabase (`/auth/v1/user`) on each request: the person acts in every org they belong to, and `launch` takes `org` when a golden name is in several.

The tools are `golden_list`, `launch` (the same rules as `armada launch`: `noEnv`, Armada credentials only, `claude` or `codex`), `list`, `status`, `wait`, `logs`, `send`, `steer`, `interrupt`, `exec` and `stop`. A caller sees the org's goldens and sandboxes and its own private ones, never another member's.

- A turn's state comes from `getPrompt`. A turn that ended on a usage limit or an expired login marks the sandbox `failed`, and the reason is recorded in `sandboxes.status_reason` (a failed launch records its error there too).
- `logs` pages events by cursor and keeps one event per id.
- `steer` reports `restart` for Codex (the turn is interrupted and the text sent as a new one) and `native` for Claude Code.
- The boat key for tools stays on the server: an org golden uses the org's key, a private golden its owner's personal key. `launch/resolve` on the control API returns the boat key to the signed-in CLI, which launches locally (#479's design).

Environment: `PORT`, `ARMADA_DATABASE_URL` (the Postgres connection string, server-side only; token, membership and credential lookups all use it, so the server holds no service role key), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ARMADA_AUTH_SECRET`, `ARMADA_PUBLIC_URL` (the origin clients reach), `ARMADA_ENCRYPTION_KEY` (32 bytes in base64, the key of the encrypted credentials) and `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` (the GitHub App, to refresh a launching user's token; see [docs/github-app.md](docs/github-app.md)).

`Dockerfile` builds the binary and runs `armada serve`; `railway.json` deploys it on Railway from this repository, with `/healthz` as the health check.

## Dashboard

`apps/dashboard` is a Next.js App Router app (Tailwind v4, shadcn/ui, dark mode). It talks to Supabase as the signed-in user (their JWT from the session cookie, so row level security decides what they see) and never holds a service key.

| Variable | Where | Role |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build and runtime | The Supabase project. Required. |
| `NEXT_PUBLIC_AUTH_PROVIDERS` | build and runtime | Social buttons to show, `github,google`. Empty: email sign-in only. |
| `ARMADA_MCP_URL` | runtime | The Armada MCP server. Without it the dashboard lists sandboxes but cannot read live logs or stop and message them. |
| `ARMADA_ENCRYPTION_KEY` | build and runtime | 32 random bytes, base64 (`openssl rand -base64 32`). `@armada/core` seals credentials with AES-256-GCM before they are stored. The same name and helper are what credential resolution (#461) uses. Without the key the dashboard refuses to save one. Next.js inlines this name, so set it for the build as well as runtime. |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | runtime | The Armada GitHub App, for Connect GitHub in Settings. Without them Settings says GitHub is not configured. |
| `GITHUB_APP_SLUG` | runtime | The App's slug. Connect sends the person to install it when they have no installation, and Settings links to it. |
| `GITHUB_APP_ID` | runtime | Optional numeric GitHub App ID. When set with the slug, an installation must match both. |

- **Sign-in.** Email: Supabase sends a link and a one-time code (the dashboard accepts either; the template decides what the email carries). GitHub and Google: enable the provider in Supabase Auth, then list it in `NEXT_PUBLIC_AUTH_PROVIDERS`. Add `<origin>/auth/callback` (production and previews) to the redirect URLs of the Supabase project.
- **Credentials.** `encryptSecret` / `decryptSecret` in `@armada/core` seal a value under `ARMADA_ENCRYPTION_KEY`. `value_enc` holds `iv (12 bytes) || ciphertext || tag` (`toBytea` is the PostgREST form). Values are write-only: a user JWT cannot read the column and the dashboard never shows one. Resolution order (the caller's own, then the org's) is `resolveCredentials` in the launcher.
- **GitHub.** Settings has Connect GitHub: the dashboard sends the person to the GitHub App's authorization page (`/github/connect`, with a state cookie). `/github/callback` stores the sealed refresh token as them, and if they have not installed the App it sends them to install it first. An install that starts on GitHub itself is saved when this browser is signed in. Create the App with [docs/github-app.md](docs/github-app.md).
- **Logs, stop, send.** boat.dev keys stay on the server, so the dashboard asks the Armada MCP server (`logs`, `stop`, `send` tools, over Streamable HTTP, with the user's session token). The logs panel polls every two seconds from the last cursor while the sandbox is active.
- **Writes row level security cannot express** (creating an org, adding a member by email, changing a golden's visibility) go through the functions of `supabase/migrations/20261108150000_dashboard_functions.sql`, which check `auth.uid()` themselves. That migration follows the OAuth and golden-sandbox migrations: it does not grant the OAuth tables, and replacing `goldens_guard` still allows `boat_sandbox_id` to change.

```sh
cp apps/dashboard/.env.example apps/dashboard/.env.local   # then fill it in
bun run dashboard          # next dev
bun run dashboard:build    # next build
bun run e2e                # Playwright against a mock of Supabase and the Armada server
```

Vercel: project root directory `apps/dashboard` (`vercel.json` there sets the Next.js framework and the Bun install and build). `bunx playwright install chromium` once before the first `bun run e2e`.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`:

- **Lint, typecheck and test**: `bun run lint`, `bun run typecheck`, `bun run test`.
- **Dashboard e2e**: `bun run e2e` (Playwright, Chromium) on a production build of the dashboard.
- **Binary (linux-x64, linux-arm64, darwin-x64, darwin-arm64)**: each binary is compiled with `bun build --compile` on a runner of its own platform, checked with `armada --version` there, staged as npm packages (`scripts/npm.ts`), packed with `npm pack`, installed with npm and Bun and run (`scripts/npm-smoke.sh`), and uploaded as the `armada-<target>` artifact of the run.

`.github/workflows/release.yml` publishes `@thevibecompany/armada` and its platform packages to npm, with provenance, when a `v<version>` tag of `main` is pushed ([docs/releasing.md](docs/releasing.md)).

## Armada v1

This repository used to hold Armada v1, a fleet orchestrator (Linear, merge queue, dashboard, desktop app, the `@the-vibe-company/armada` npm package up to 0.2.73). It is archived:

- Its last commit is tagged [`armada-v1-final`](https://github.com/The-Vibe-Company/armada/tree/armada-v1-final); its release tags (`v0.1.0` to `v0.2.73`) and the whole history stay in this repository.
- Its code is not on `main` anymore. Pieces worth keeping (for example the Claude Code and Codex adapters) are brought over by hand, as v2 needs them: `git show armada-v1-final:<path>`.
- Its npm package, `@the-vibe-company/armada`, is not published anymore; its released versions stay on npm. v2 is published as `@thevibecompany/armada`.

## License

[MIT](LICENSE)
