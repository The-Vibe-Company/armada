# Armada: rules for coding agents

Rules only. Procedures live in the documents listed under "Where truth lives".

## Product
- Armada launches coding agents (Claude Code, Codex, OpenCode) in sandboxes on Boat, Modal or a user's Docker host, and exposes them through the API, SDK, CLI, MCP and dashboard.
- It is a launcher, not a workflow engine. Waits, captains and orchestration live in API clients, not in Armada.
- `armada-server` is one TypeScript/Bun server on PostgreSQL (Supabase). The `armada` CLI and the SDK are API-only clients.
- Two agent paths exist until the native retirement finishes: the provider-run path (Boat agent API, Modal runner) and the Armada runtime (`packages/agent-runtime`). The target is the runtime only.
- `docs/architecture.md` is the target for new code. Do not migrate existing code toward it outside a program ticket.

## Layout
| Path | Holds |
|---|---|
| `packages/core` | shared contracts, catalogs, policies, credentials, `packages/core/src/crypto.ts`. `packages/core/src/index.ts` is browser-safe; server-only exports live in `packages/core/src/server.ts`. API operation metadata and shared request schemas belong in the browser-safe `packages/core/src/contract` subpath, exported as @armada/core/contract. Authorization and provider admission stay on the server. |
| `packages/mcp-server` | `armada-server`: HTTP, control routes, MCP tools, workers, provider adapters. Read `packages/mcp-server/AGENTS.md` before editing it. |
| `packages/agent-runtime` | the runtime that runs inside a sandbox, and its harness drivers |
| `packages/provider-boat`, `packages/provider-modal` | provider SDK adapters |
| `packages/docker-host` | the outbound-only Docker host daemon |
| `packages/auth`, `packages/mcp-gateway` | login, OAuth, tokens; scoped MCP transport |
| `packages/cli`, `packages/sdk` | API-only clients |
| `apps/dashboard` | Next.js client acting as the user JWT, never the service key; pure logic in `apps/dashboard/src/lib`; resource create flows follow `docs/dashboard-design.md` |
| `apps/ios` | Swift client |
| `supabase/migrations` | append-only schema and row-level security |

## Non-negotiables
1. **No compatibility layers.** When you replace a route, tool, command, field or table, delete the old one and update every in-repo caller (CLI, SDK, dashboard, iOS, MCP, `.agents/skills/armada`, docs, smoke scripts). No aliases, `-vN` routes, deprecation windows, feature flags or decoders for old shapes. Three things keep an overlap: database objects, the runtime protocol and the Docker host daemon protocol. A breaking change may span modules; move callers first, delete last, within one ticket.
2. **Lifecycle.** Only the sandbox module writes `sandboxes.status`; one lease and one deadline per sandbox; every provider call carries `(sandboxId, generation)`; no new cleanup loop or retry timer. These bind new and changed code; details in `packages/mcp-server/AGENTS.md`.
3. **Separate client and server.** Never import Supabase, provider implementations or server startup into the CLI or SDK graph.
4. **Secrets.** Never print a secret or write one to a file, fixture, log or argument. Goldens hold no secrets. Credential values arrive on stdin or from a file. In the database a secret is `*_enc` ciphertext (`encryptSecret`/`decryptSecret` with `ARMADA_ENCRYPTION_KEY`) or a lowercase SHA-256 hash, and no user JWT can read either. The only argv exception is the single-use, five-minute Docker host install token.
5. **Database access.** Row-level security is the access rule. Members see organization resources, owners alone see private resources, and only admins change organization goldens, membership or organization keys. New user-JWT access needs explicit grants; JWT writes name their returned columns (`select=`), never bare `*`. Server SQL bypasses RLS and must enforce visibility itself. Schema changes are new migrations; never edit an applied one (`docs/database-migrations.md`). Place new TypeScript table writes with the owner in `scripts/ci/tables.ts` and remove exceptions as writes move or are deleted.
6. **Fix the cause.** Name the root cause with evidence (the wrong statement, state or contract) before changing code. Fix every sibling with the same defect in the same PR, or list them. Do not copy a workaround or make one check pass. Urgency does not waive this. If only production can prove the cause, add the diagnostic that will name it.
7. **Build only what the ticket asks.** If a rule blocks the ticket, stop and report.
8. **Never state as verified what you did not run.**
9. **Boat is never part of CI or staging acceptance.** Boat checks are on demand, by the coordinator only.
10. **One version** across package manifests under `packages`. **English** in code, output, docs and comments.
11. **Landmines rules are mandatory.** Give the reason for any inline disable in the PR and only shrink baselines.

## Pull requests
- **One module, at most 600 changed lines.** Generated files, pure deletions and `git mv` do not count. If the work is bigger, stop and tell the coordinator so the ticket is split.
- **Lifecycle work needs a design note first**: sandbox state, leases, deadlines, retries, provider create/stop/resume/delete, cleanup, output capture, exports. The note goes in the issue before code (contents: `packages/mcp-server/AGENTS.md`).
- **Breaking surface change.** Update `.agents/skills/armada` and docs in the same PR, and add a `Coordinator commands affected:` line to the body (or `none`).
- **One branch, one agent.** Never push to a branch another session owns.
- **At most one migration per PR**, with a unique 14-digit version newer than main’s. Recheck the order before merge.
- **Titles** follow Commitizen: `feat(cli): launch an agent from a template`.

## Review
- A lifecycle risk with owner sign-off in `docs/accepted-risks.md` is accepted within its documented bound. Report behavior outside that bound.
- The coordinator decides merge. After three rounds it may defer non-security, non-data-loss findings to an issue whose body contains the failing test.

## Tests
- One test per behaviour, at the cheapest boundary that proves it. No network, no wall-clock wait, no sleep (inject clocks).
- No child process when a function call proves the same thing. Real Git, gh and provider behaviour belongs in the staging smoke.
- No new process-spawning test files. Run `bun scripts/ci/process-tests.ts --check` and remove stale entries from `scripts/ci/process-tests.txt`. The allowlist only shrinks.
- A test over one second is rewritten or deleted. Never raise a timeout to make a test pass.
- A flaky test is deleted the day it is seen, not retried or quarantined. A cheaper deterministic test replaces it if the behaviour matters.
- Fixtures never contain literals that match real token patterns. Use short placeholders; build scanner-positive bytes at runtime.
- A bug fix includes a regression test that fails without the fix.

## CI
- One required check, `Lint, typecheck and test`, under two minutes. CI proves the code is sound; staging proves it works.
- CI never builds binaries, goldens or images, never calls a network or provider, never runs a browser, and never retries.
- Adding a CI job, a required check or a gate step is the owner's decision, never an agent's.
- Post-deploy smoke exercises deployed lifecycles using existing goldens. Releases follow `docs/releasing.md`.

## Commands
- `bun install`, then `bun scripts/prepare-runtime.ts` before server tests.
- `bun run verify`: lint, typecheck, unit tests. `bun run verify:changed --base origin/main`: the same for changed workspaces (fetch first).
- `bun run format`: Biome formatting and safe fixes.
- `bun run db:types`: regenerate `packages/core/src/database.types.ts`. Never hand-edit or hand-merge it.
- `bun run dev`: fixture dashboard on ports 3100/54399, sign in as `alice@example.com` / `123456`. UI work only, not lifecycle evidence.
- `bun run armada <args>`: the CLI from source. `bun run build`: binaries in the generated dist directory.

## Where truth lives
| Topic | Authority |
|---|---|
| Target architecture, module owners | `docs/architecture.md` |
| Sandbox states and transitions | `docs/state-model.md` |
| Public API and SDK | `docs/api/README.md`, `docs/sdk.md` |
| Runtime startup and enrolment | `docs/runtime-startup.md` |
| Docker host daemon | `docs/docker-host-daemon.md` |
| Migrations | `docs/database-migrations.md` |
| CI, merge queue, releases, smoke | `docs/ci-budget.md`, `docs/merge-queue.md`, `docs/releasing.md`, `docs/post-deploy-smoke.md` |
| Lint exceptions | `docs/lint-policy.md` |
