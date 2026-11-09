# Run, deploy and develop Armada

The [README](../README.md) is for people who want to launch agents. This page is for people who run an Armada server, deploy the dashboard or change the code.

Armada has three deployable parts:

| Part | What it is | Built from |
| --- | --- | --- |
| `armada` | The API-only CLI. It holds only an Armada session or `ARMADA_TOKEN`, never Supabase, provider or database credentials. | `packages/cli`, published to npm as `@the-vibe-company/armada` |
| `armada-server` | The control API (`/api/v1/`), the OAuth authorization server and the remote MCP server (`/mcp`). It holds the database connection, the encryption key and talks to Boat and Modal. | `packages/mcp-server`, compiled by `scripts/build.ts`, shipped by `Dockerfile` |
| Dashboard | The web app (Next.js App Router). It acts as the signed-in user over Supabase, so row level security decides what each person sees. | `apps/dashboard` |

The specification is issue [#455](https://github.com/The-Vibe-Company/armada/issues/455); `AGENTS.md` maps every package.

## Database

`supabase/migrations` is the schema, applied by the [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase db reset` on a local project, or `supabase migration up`). It assumes a fresh Supabase database: Auth's `auth.users` and `auth.uid()`, and the `authenticated` and `service_role` roles. Schema changes are always new migrations.

`packages/core/src/database.types.ts` is generated from those migrations. After changing them, run `bun run db:types` and commit the result; a test fails if the file drifts. The migrations are tested on a fresh in-memory Postgres, row level security included.

## The server: `armada-server`

`Dockerfile` compiles the standalone `armada-server` binary and runs it; `railway.json` deploys it on Railway with `/healthz` as the health check. It listens on `PORT` (default 8080) and answers:

- `/healthz`: `{"ok": true, "version": …}`, without a token.
- The OAuth routes (`/.well-known/*`, `/authorize`, `/token`, `/register`, …).
- The control API under `/api/v1/`, which the CLI and the dashboard call.
- `/mcp`: MCP over Streamable HTTP. Every request is authenticated again, without a cache; the bearer is an OAuth access token, an Armada service token or a Supabase session token.

Required environment (the server refuses to start without it):

| Variable | Role |
| --- | --- |
| `ARMADA_DATABASE_URL` | Privileged Postgres connection (the Supabase `postgres` role). The server's own queries carry the visibility rules. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | The Supabase project used for sign-in. |
| `ARMADA_AUTH_SECRET` | At least 16 characters; seals the OAuth server's sign-in cookie. |
| `ARMADA_PUBLIC_URL` | The origin clients reach. |
| `ARMADA_ENCRYPTION_KEY` | 32 random bytes in base64 (`openssl rand -base64 32`). Seals every stored credential with AES-256-GCM. |

Optional:

| Variable | Role |
| --- | --- |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` | The GitHub App that gives sandboxes the launching person's GitHub identity. See [github-app.md](github-app.md). |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | A scoped installation token for golden checkouts. See [golden-create.md](golden-create.md#server-environment). |
| `ARMADA_DASHBOARD_URL` | The dashboard origin, when it is not the production one. See [github-cli-relay.md](github-cli-relay.md). |
| `ARMADA_AUTH_PROVIDERS` | Social login offered to CLI and MCP clients (`github,google`), only for providers enabled in Supabase. Empty: email only. |

Boat and Modal keys are not server environment: org admins connect them (`armada org connect boat|modal`), and they are stored encrypted per org or per person.

## The dashboard

`apps/dashboard` talks to Supabase as the signed-in user (their JWT from the session cookie) and never holds a service key. Writes row level security cannot express go through the functions in `supabase/migrations/*_dashboard_functions.sql`, which check `auth.uid()` themselves.

| Variable | Where | Role |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build and runtime | The Supabase project. Required. |
| `NEXT_PUBLIC_AUTH_PROVIDERS` | build and runtime | Social buttons to show, `github,google`. Empty: email sign-in only. |
| `ARMADA_MCP_URL` | runtime | The `armada-server` origin. Without it the dashboard lists sandboxes but cannot read live logs, stop or message them. |
| `ARMADA_ENCRYPTION_KEY` | build and runtime | The same key as the server. Without it the dashboard refuses to save a credential. |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_ID` | runtime | Connect GitHub in Settings ([github-app.md](github-app.md)). |

Add `<origin>/auth/callback` (production and previews) to the Supabase project's redirect URLs, and allow `http://127.0.0.1:**` for CLI login callbacks. On Vercel, set the project root to `apps/dashboard` (its `vercel.json` sets the framework and the Bun install and build).

```sh
cp apps/dashboard/.env.example apps/dashboard/.env.local   # then fill it in
bun run dashboard          # next dev
bun run dashboard:build    # next build
bunx playwright install chromium
bun run e2e                # Playwright against a mock of Supabase and the Armada server
```

## Develop

Requires [Bun](https://bun.sh) 1.4.2 (`packageManager` in `package.json`).

```sh
bun install
bun scripts/prepare-runtime.ts       # portable runtime required by local server tests
bun run verify                       # Biome lint, strict tsc and every test: what CI runs
bun run format                       # Biome with safe fixes
bun run armada --help                # the CLI from source

bun run build                        # dist/armada and dist/armada-server for this machine
bun run build --target linux-arm64   # one target
bun run build:all                    # linux and macOS, x64 and arm64
```

Every `packages/*/package.json` carries the same version, the one `armada --version` prints; a test fails if they drift.

## CI and releases

`.github/workflows/ci.yml` runs on every pull request and on `main`: lint, typecheck and test; the dashboard e2e on a production build; and, per platform, the compiled binary, its npm packages, an install with npm and Bun and a smoke run.

Release Please opens the version PR from conventional commits. Merging it publishes `@the-vibe-company/armada` and its platform packages to npm with provenance: [releasing.md](releasing.md).
