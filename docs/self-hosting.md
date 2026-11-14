# Run, deploy and develop Armada

The [README](../README.md) is for people who want to launch agents. This page is for people who run an Armada server, deploy the dashboard or change the code.

Armada has three deployable parts:

| Part | What it is | Built from |
| --- | --- | --- |
| `armada` | The API-only CLI. It holds only an Armada session or `ARMADA_TOKEN`, never Supabase, provider or database credentials. | `packages/cli`, published to npm as `@the-vibe-company/armada` |
| `armada-server` | The control API (`/api/v1/`), the OAuth authorization server and the remote MCP server (`/mcp`). It holds the database connection, the encryption key and talks to Boat and Modal. | `packages/mcp-server`, compiled by `scripts/build.ts`, shipped by `Dockerfile` |
| Dashboard | The web app (Next.js App Router). It acts as the signed-in user over Supabase, so row level security decides what each person sees. | `apps/dashboard` |

## Scope

Armada is a launcher, not a workflow engine. It does not split work into tasks, read issue trackers, review code or merge pull requests; an external coordinator does that through Armada's MCP server. It does not host machines or models either: sandboxes and agents run, and are billed, on the Boat, Modal and model accounts an organization connects.

The specification is issue [#455](https://github.com/The-Vibe-Company/armada/issues/455); `AGENTS.md` maps every package.

## Contribute: quickstart

UI contributions do **not** require Supabase, provider accounts or deployment
credentials. Start here; the operator setup below is only for running a real
Armada deployment.

### Clone and install

Install [Bun](https://bun.sh) **1.4.2**, pinned by `packageManager` in
`package.json`, then:

```sh
git clone https://github.com/The-Vibe-Company/armada.git
cd armada
bun --version                       # must match the pinned version
bun install --frozen-lockfile
```

### Credential-free UI development

```sh
bun run dev
```

This starts the fixture-only dashboard on port **3100** and the mock
Supabase/Armada server on **54399**; both ports must be free. Sign in as
`alice@example.com` with code `123456`. No real sandboxes are launched and no
production credentials are needed. Ctrl-C stops both processes. This loop is for
UI work, not evidence of a working provider lifecycle or deployment.

### Validate your change

From the repository root:

```sh
git fetch origin main
bun scripts/prepare-runtime.ts       # portable runtime required by local server tests
bun run verify:changed --base origin/main --dry-run
bun run verify:changed --base origin/main
bun run format                      # Biome formatting and safe fixes; inspect the diff
bun run armada --help                # the CLI from source
```

`verify:changed` runs lint and strict typecheck plus unit tests in changed
workspaces and their transitive consumers. It includes staged, unstaged and
untracked files. Root/config changes conservatively select **every** workspace;
executable changes also include root script tests. Inspect `--dry-run` first:
this is a local shortcut, not the CI verdict or a two-minute guarantee.

On a resource-constrained sandbox, do not run the full unit suite (including a
changed selection that expands to all workspaces). Instead run `bun run lint`,
`bun run typecheck` and explicit relevant test files, for example
`bun test path/to/changed.test.ts`; CI runs the rest. On a sufficiently
provisioned machine, `bun run verify` remains available for lint, strict
typecheck and the full unit suite.

Every `packages/*/package.json` carries the same version, the one
`armada --version` prints; a test fails if they drift. Local binaries are
optional: `bun run build` builds for this machine,
`bun run build --target linux-arm64` selects one target, and
`bun run build:all` builds all supported targets. These are not prerequisites
for UI contributions or per-PR CI.

## Operator setup

The following sections require real infrastructure; skip them for fixture-only
contributions.

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
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` | The GitHub App: golden creation clones over the person's connection, and sandboxes get their GitHub identity. The server starts without them, but goldens cannot be built. See [github-app.md](github-app.md). |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | A scoped installation token for golden checkouts. See [golden-create.md](golden-create.md#server-environment). |
| `ARMADA_GITHUB_RUNTIME_ENABLED` | Managed GitHub broker/wrappers; default off. Only exact `true` enables it. See [github-runtime.md](github-runtime.md) for existing-worker limitations. |
| `ARMADA_DASHBOARD_URL` | The dashboard origin, when it is not the production one. See [github-cli-relay.md](github-cli-relay.md). |
| `ARMADA_AUTH_PROVIDERS` | Social login offered to CLI and MCP clients (`github,google`), only for providers enabled in Supabase. Empty: email only. |

Boat and Modal keys are not server environment: org admins connect them (`armada org connect boat|modal`), and they are stored encrypted per org or per person.

### Start a local development server

From the repository root, run `bun install`, then load the required environment above
for a **disposable local Supabase project**. Never reuse staging/production
credentials or point local schema setup at a shared database. If schema setup is
needed, use `supabase db reset` only against that disposable local project;
staging/production migrations remain an authorized operator task under the
[database migration runbook](database-migrations.md).

In that development shell, set explicit local origins and start the API process:

```sh
export NODE_ENV=development
export PORT=8080
export ARMADA_PUBLIC_URL=http://localhost:8080
export ARMADA_DASHBOARD_URL=http://localhost:3000
bun scripts/prepare-runtime.ts
bun packages/mcp-server/src/main.ts
# Alternatively, after bun run build: ./dist/armada-server
```

Keep the server running. In another terminal, verify HTTP health and point the
API-only CLI at the same development origin:

```sh
curl --fail --silent --show-error http://localhost:8080/healthz
export ARMADA_URL=http://localhost:8080
bun run armada --help
```

For the dashboard, load its environment from the [dashboard section](#the-dashboard)
using the same local Supabase project and encryption key, then start it with the
same API origin:

```sh
ARMADA_MCP_URL=http://localhost:8080 bun run dashboard
```

Health confirms only that the HTTP process is running, not that a sandbox launch
works. Follow the existing [provider setup](../README.md) and
[GitHub App setup](github-app.md) before attempting launches or golden builds;
provider credentials still belong in Armada's encrypted store, not the CLI.

## The dashboard

`apps/dashboard` talks to Supabase as the signed-in user (their JWT from the session cookie) and never holds a Supabase service key; launches, golden builds, provider setup and the CLI's `/api/v1` and `/.well-known/armada.json` go through `armada-server`. Writes row level security cannot express go through the functions in `supabase/migrations/*_dashboard_functions.sql`, which check `auth.uid()` themselves.

| Variable | Where | Role |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build and runtime | The Supabase project. Required. |
| `NEXT_PUBLIC_AUTH_PROVIDERS` | build and runtime | Social buttons to show, `github,google`. Empty: email sign-in only. |
| `ARMADA_MCP_URL` | runtime | The `armada-server` origin. Required in practice: without it the dashboard only lists what Supabase shows; it cannot launch, build goldens, set up providers, read live logs, stop or message sandboxes, and `/.well-known/armada.json` answers 503. |
| `ARMADA_ENCRYPTION_KEY` | build and runtime | The same key as the server. Without it the dashboard refuses to save a credential. |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_ID` | runtime | Connect GitHub in Settings ([github-app.md](github-app.md)). |
| `STATS_TOKEN`, `ARMADA_DATABASE_URL` | runtime | Optional, server only: the bearer and privileged Postgres connection of `GET /api/stats`. Never exposed to the browser. |

Add `<origin>/auth/callback` (production and previews) to the Supabase project's redirect URLs, and allow `http://127.0.0.1:**` for CLI login callbacks. On Vercel, set the project root to `apps/dashboard` (its `vercel.json` sets the framework and the Bun install and build).

```sh
cp apps/dashboard/.env.example apps/dashboard/.env.local   # then fill it in
bun run dashboard          # next dev
bun run dashboard:build    # next build
bunx playwright install chromium
bun run e2e                # Playwright against a mock of Supabase and the Armada server
```

## CI and releases

[CI](../.github/workflows/ci.yml) runs on pull requests, merge groups and manual
dispatch, not pushes to main. Its single required verdict,
`Lint, typecheck and test`, aggregates six unit shards, with lint, strict
typecheck and migration guards in shard 1. It does not build binaries or run
provider/network or browser tests per PR. See [CI budget](ci-budget.md) for the
canonical check policy and [merge queue](merge-queue.md) for merge requirements.

Binary compilation, platform/npm installation smoke checks and publication
belong to the publishing release path, not PR CI. Release Please prepares version
PRs; production deployment requires the release's exact-SHA staging smoke.
See [releasing](releasing.md) for publication boundaries and operator prerequisites.

Dashboard browser tests are manual-only: run `bun run e2e` against the local mock.
They do not gate PRs or the merge queue.
