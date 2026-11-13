# Repository instructions

Armada v2 launches coding agents (Claude Code, Codex and OpenCode) through provider-scoped sandboxes: a remote MCP server for calling agents, the dashboard and the API-only `armada` CLI. It is a launcher, not a workflow engine. The specification is issue #455; read it before changing behaviour.

Armada v1 (the fleet orchestrator) is archived at the tag `armada-v1-final`. Its code is not on `main`; bring a piece over by hand when v2 needs it (`git show armada-v1-final:<path>`), never by restoring whole folders.

## Layout

- `packages/core` (`@armada/core`): shared contracts/version, provider and harness catalogs, launch/golden/work-preservation policy, credentials, vault, templates and routines. `src/index.ts` (`.`) is browser-safe: no reachable Node builtins or server I/O; `src/server.ts` (`./server`) additionally exports filesystem, process, signing, SQL and service implementations. `boat-snapshot-name.ts` is server-only. `crypto.ts` is the single AES-256-GCM (`iv || ciphertext || tag`) implementation under `ARMADA_ENCRYPTION_KEY`.
- Provider identity: `core/src/sandbox-provider.ts` defines golden providers Boat/Modal, host capabilities and immutable Modal workspace/environment/App binding. Build goldens separately per provider; never invent Boat aliases for Modal or plain-image Docker rows. Docker preview has separate host-bound APIs and additive launch discovery, not a golden source or enabled normal sandbox-control handler.
- `supabase/migrations`: append-only schema/RLS history; `core/src/database.types.ts` is generated (`bun run db:types`). Supabase's broad defaults are revoked by `20261108190000_revoke_default_grants.sql`; new user-JWT access needs explicit grants. No JWT can select token hashes or `*_enc`. JWT writes must name returned columns (`select=`), never request bare `*`. `scripts/db/supabase-prereq.sql` reproduces Supabase defaults for tests.
- `packages/auth`: Supabase login, OAuth server, service tokens and bearer verification. Tokens persist as lowercase SHA256; service-role bearer verification is uncached. `packages/cli` is the API-only `armada` client: `src/run.ts` takes injected I/O, `armada-api.ts` calls `/api/v1/`, and `session.ts` stores only the Armada login (or use `ARMADA_TOKEN`). No provider/database credentials or adapters belong in its runtime graph.
- `packages/mcp-server`: `armada-server`, assembled in `src/serve.ts`. `http.ts` mounts health/OAuth/control/MCP; `tools.ts` and `control.ts` share server policies. SQL in `data.ts` bypasses RLS and must enforce visibility itself. Golden creation shares core's disposable-builder service: caller GitHub authorization, pinned SSH-stdin checkout, secret scan, snapshot/persist and unconditional builder cleanup. GitHub App setup is in `docs/github-app.md`; the normal server image needs `openssh-client`.
- `packages/provider-boat`: SDK adapter (`createBoatProvider`), error/event normalization and native compatibility path. Golden creation always uses `noEnv:true`, never account environment. `packages/provider-modal`: runtime distribution, immutable provider bindings and existing authenticated tunnel. Native Boat and Modal paths remain; experimental Boat runtime selection is immutable/default off. Remote MCP uses standard launch selection/defaults and automatic first/later/resumed-turn preparation. Read `docs/boat-runtime-first-prompt.md` before changing its lifecycle.
- `packages/agent-runtime`: journal, command handler and native Codex app-server/Claude Agent SDK drivers; OpenCode uses ACP v1 and is enabled on Modal only. `docs/runtime-startup.md` covers compiled artifacts, verified caches, private enrolment/epochs and dial-out transport; `docs/runtime/opencode-modal.md` covers OpenCode. `packages/docker-host` is the separate outbound machine-only daemon; install, ownership, TTL, reconciliation and preview APIs are in `docs/docker-host-daemon.md`. Host ACKs are not runtime readiness.
- `packages/mcp-gateway`: scoped MCP transport; upstream grants stay server-side. Runtime and native integrations retain their own authorized lifecycle. Templates resolve current reference versions at launch into frozen manifests, not publication. Boat readable variables are non-secret world-readable configuration, not isolation from guest file readers. Application-secret delivery is a separate security boundary; consult `docs/templates-cli.md` for frozen manifests and raw-delivery limits, and `docs/post-deploy-smoke.md` for staging checks.
- `packages/mcp-server/src/otto/` and browser-safe `core/src/otto/`: explicitly bound, read-only GitHub/fleet observations. Selected append-only facts and replaceable projections do not authorize launches, worker messaging or task completion; partial/hidden evidence stays unknown. Operator scope and checks: `docs/otto-staging.md`.
- `apps/dashboard`: Next.js App Router/Tailwind/shadcn, acting as user JWT over Supabase, never service key. Pure logic is `src/lib` (`bun test`); Playwright uses `e2e/mock-supabase.ts`. Writes RLS cannot express use dashboard SQL functions. Resource create/add flows use `CreateDialog` as `ResourceBrowser.actions`, one short centered form, not side panels or duplicate lists. `apps/ios` contains the Swift client and generated shared wire/harness contracts.
- `scripts/build.ts` compiles CLI/server binaries; `scripts/npm.ts` stages `@the-vibe-company/armada` and platform optional packages; `scripts/npm-smoke.sh` checks installs. Release Please/npm OIDC workflows and operator-controlled staging promotion are documented in `docs/releasing.md`; `docs/merge-queue.md` and `docs/database-migrations.md` own those respective procedures. `docs/post-deploy-smoke.md` owns deployed checks; a procedure is not evidence it passed. `docs/dave-onboarding.md` is the user onboarding guide.

Owner-facing orchestrators have been removed, with no compatibility route or feature flag; ordinary scoped child access remains. Deferred schema retirement and its one-production-day authorization gate are in `docs/orchestrator-retirement.md`.

## Commands

- `bun install`
- `bun scripts/prepare-runtime.ts`: prepare the portable runtime before local server tests. Linux CI builds and validates the native runtime with `bun packages/agent-runtime/build.ts` and `bun scripts/validate-runtime-native.ts` instead.
- `bun run verify`: lint (Biome), typecheck (`tsc`, strict) and tests (`bun test`). CI exposes one required aggregate, "Lint, typecheck and test", over lint/typecheck (including migration and native contract steps) and unit shards.
- `bun run verify:changed [--base origin/main] [--dry-run]`: lint/typecheck plus unit tests in changed workspaces and their transitive consumers; includes staged, unstaged and untracked files. Root/config changes conservatively select every workspace. Root script tests remain included for executable changes. Use `--dry-run` to inspect selection without running checks; this is a local shortcut, not the CI verdict or a two-minute guarantee. Fetch the base ref first.
- `bun run format`: apply Biome formatting and safe fixes.
- `bun run build` (this machine), `bun run build --target <os-arch>`, `bun run build:all`: the binary in `dist/`.
- `bun run armada <args>`: the CLI from source.
- `bun run dev`: fixture-only local dashboard plus the existing Supabase/Armada mock (ports 3100/54399). Sign in as `alice@example.com`, code `123456`; no real sandbox launches or production credentials. Ctrl-C stops both processes. This is UI development, not lifecycle/staging evidence. Ports must be free.
- `bun run dashboard`, `bun run dashboard:build`, `bun run e2e`: the dashboard (dev, production build, browser tests). `bun run verify` typechecks it and runs its unit tests, not the e2e.
- `bun run db:types`: regenerate `packages/core/src/database.types.ts` after a migration change.
- `scripts/aeom/install.sh`: install All Eyes On Me at its pinned commit to redesign or review the public landing (`.aeom/`, `docs/aeom.md`).

## CI: what we test and what we do not

One verdict, under two minutes. A pull request has a single required check, `Lint, typecheck and test`. If it takes more than two minutes, that is a defect to fix before anything else merges.
No blocking PR or merge-queue check may exceed two minutes. The only slow gated
path is a publishing release: release → exact-commit staging deployment/smoke →
production. Staging smoke otherwise runs only after deploying a main commit,
never from PR, gh-readonly-queue/* or release-please branch deployment events
and never as a pull-request check. Do not subscribe smoke to deployment_status.

**CI proves the code is sound on its own. Staging proves it works.**

What CI runs on every pull request and in the merge queue:
- lint and format (Biome), strict typecheck (`tsc`), the migration-version guard;
- the unit tests (`bun test`), in as few shards as the two-minute limit allows.

What runs only when its files change: the iOS checks (`apps/ios`), the migration dry-run (`supabase/migrations`).

What runs after a merge, not before: the staging dashboard build in GitHub Actions
(`vercel pull`, `vercel build`, then `vercel deploy --prebuilt`), the deploy to staging and the post-deploy smoke, which launches real sandboxes on every enabled provider, builds goldens and exercises the whole lifecycle. Production deploys only from a publishing release after its exact-SHA staging
smoke succeeds; there is no opt-in bypass. The #1547 owner cutover in
`docs/releasing.md` records which provider settings still need owner changes.
Vercel Git deployments are disabled for both dashboard projects via
`apps/dashboard/vercel.json`; no PR previews. Keep the Actions staging path
working and follow the owner cutover prerequisites in `docs/releasing.md`.
The release dashboard build also runs in Actions and uploads only prebuilt
output; provider-side Git autodeploy still requires the owner cutover.
Production SQL applies only from the validated release deployment path; the
standalone migration workflow retains manual previews/history/owner repair,
never per-commit production applies.
Ordinary queued staging-main sources are superseded before mutation when newer
main exists; started deployments and explicit pinned release smoke are never cancelled.
Binaries are built by the release workflow when a version is published.

What CI does not do, and must not be added back:
- no binary builds per pull request;
- no golden, image or provider build, no real PostgreSQL service, no browser test;
- nothing that calls the network or a provider;
- no "informational" job: a check either gates the merge or does not exist;
- no timing or budget check: the coordinator measures the verdict time.

Rules for a test:
- one test per behaviour, at the cheapest boundary that proves it; no network, no wall-clock wait, no child process when a function call proves the same thing;
- a test that takes more than one second is rewritten or deleted;
- a test that fails intermittently is deleted the day it is seen, not retried, not quarantined; if the behaviour matters, a cheaper deterministic test replaces it;
- CI has no retries.

Adding a CI job or a required check is the owner's decision, never an agent's. Where something is tested: logic in a unit test; a provider, a golden, a full lifecycle in the post-deploy smoke; a screen by opening it on staging.

## Rules

- **Separate client and server.** `armada` is an API-only client; `armada-server` contains the server and provider/database adapters. Both compile with Bun. Never import Supabase, provider implementations or server startup into the CLI runtime dependency graph.
- **One version.** Every `packages/*/package.json` carries the same version; `@armada/core` exports it and `armada --version` prints it.
- **Secrets never in the repository.** Keys come from the environment or Armada's encrypted store; never print one, never write one into a file, a fixture or a log. Goldens hold no secrets. In the database a secret is ciphertext (`bytea`, `*_enc`) or a token hash, and a user JWT cannot read the ciphertext columns. One encryption scheme: `encryptSecret` and `decryptSecret` in `@armada/core` with `ARMADA_ENCRYPTION_KEY`. Credential values arrive on stdin or from a file, never as arguments. **Owner-approved exception (#1453):** a single-use, five-minute Docker host registration token may appear in the one-click installer command (`sh -s -- --token ...`). The exchanged long-lived host credential must still never appear in argv, logs or public responses.
- **Schema changes are new migrations.** Follow the [migration author checklist](docs/database-migrations.md#migration-author-checklist): use a unique 14-digit version strictly newer than current main and recheck before merge; fresh SQL tests do not verify remote history. Never rename or edit a migration that has been applied. Row level security is the access rule: members see org resources, a private resource is visible only to its owner, and only an admin changes an org golden, the members or an org key.
- **Tests earn their place.** One test per behaviour at the cheapest boundary, no network, no wall-clock waits.
- **English** in code, CLI output, docs and comments.
- Pull request titles follow Commitizen, for example `feat(cli): launch an agent from a golden`.
