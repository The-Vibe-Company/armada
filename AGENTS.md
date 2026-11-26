# Armada: rules for coding agents

## Product
- Armada launches Claude Code, Codex and OpenCode sandboxes on Boat, Modal or a user Docker host through the API, SDK, CLI, MCP and dashboard.
- API clients own waits, captains and orchestration.
- `armada-server` is one TypeScript/Bun server on PostgreSQL (Supabase). The `armada` CLI and the SDK are API-only clients.
- Modal and Boat run agents through the Armada runtime.
- New machine lifecycle adapters implement the server-only `Machine` contract and expose capabilities through the core registry. Integration and cutover follow `docs/machine-contract.md`.
- `docs/architecture.md` guides new code. Migrate existing code only in program tickets.

## Layout
| Path | Holds |
|---|---|
| `packages/core` | shared contracts, catalogs, policies, credentials, `packages/core/src/crypto.ts`; browser-safe `packages/core/src/index.ts`, server-only `packages/core/src/server.ts`, contract subpath `packages/core/src/contract` (`@armada/core/contract`, shared REST/MCP launch schema; auth/admission stay server-side). |
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
1. **No compatibility layers.** When replacing a route, tool, command, field or table, delete the old one and update all in-repo callers (CLI, SDK, dashboard, iOS, MCP, `.agents/skills/armada`, docs, smoke scripts). No aliases, `-vN` routes, deprecation windows, feature flags or old-shape decoders. Overlap exists only for DB objects, the runtime protocol and the Docker host daemon protocol. Breaking changes move callers first, delete last, in one ticket. Bump `PROTOCOL_VERSION` only per `packages/agent-runtime/src/protocol.ts`; server keeps N and N-1.
2. **Lifecycle.** Status changes use `sandbox_transition()`; one lease and one deadline per sandbox; provider calls carry `(sandboxId, generation)`; no new cleanup loop or retry timer. Details in `packages/mcp-server/AGENTS.md`.
3. **Separate client and server.** Never import Supabase, providers or server startup into the CLI/SDK graph (`scripts/ci/import-boundaries.ts`).
4. **Secrets.** Never print or write secrets to files, fixtures, logs or argv (only argv exception: single-use 5-min Docker host install token). Goldens hold no secrets; credentials arrive on stdin or file. In DB, secrets are `*_enc` ciphertext (`encryptSecret`/`decryptSecret` with `ARMADA_ENCRYPTION_KEY`) or lowercase SHA-256 hashes; no user JWT may read either.
5. **Database access.** RLS is the access rule: members see org resources, owners alone see private ones, admins alone change org goldens/membership/keys. New user-JWT access needs explicit grants; JWT writes name `select=` columns, never `*`. Server SQL bypasses RLS and enforces visibility itself. Schema changes are new migrations; never edit an applied one (`docs/database-migrations.md`). Keep TS table writes with their owner in `scripts/ci/tables.ts` and shrink exceptions.
6. **Fix the cause.** Name the root cause with evidence before editing; fix or list all siblings with the same defect in the same PR. No workarounds; urgency never waives this. If only prod can prove it, add the diagnostic.
7. **Build only what the ticket asks.** If a rule blocks the ticket, stop and report.
8. **Never state as verified what you did not run.**
9. **Boat is never part of CI or staging acceptance.** Boat checks are on demand, by the coordinator only.
10. **One version** across package manifests under `packages`. **English** in code, output, docs and comments.
11. **Landmines rules are mandatory.** Give the reason for any inline disable in the PR and only shrink baselines.
12. **Self-register.** Define routes, MCP tools, workers, mounts and CLI commands in their owning modules. Wire server routes, workers and mounts through `packages/mcp-server/src/modules.ts` and commands through `packages/cli/src/commands/index.ts`. Use `@armada/core/<area>` subpaths.
13. **Providers are machines.** Outside `packages/provider-*`, `packages/docker-host` and the machine adapters, never branch on a provider id; read `MachineCapabilities`.

## Pull requests
- **One module, at most 600 changed lines** (excluding generated files, pure deletions and `git mv`). If bigger, stop and ask the coordinator to split.
- **Lifecycle work needs a design note in the issue first** (state, leases, deadlines, retries, provider create/stop/resume/delete, cleanup, output capture, exports; see `packages/mcp-server/AGENTS.md`).
- **Breaking surface change:** update `.agents/skills/armada` and docs in the same PR, and include `Coordinator commands affected:` (or `none`).
- **One branch, one agent.** Never push to another session's branch.
- **At most one migration per PR**, unique 14-digit version newer than main's; recheck order before merge.
- **Titles** follow Commitizen: `feat(cli): launch an agent from a template`.

## Review
- A lifecycle risk with owner sign-off in `docs/accepted-risks.md` is accepted within its documented bound. Report behavior outside that bound.
- The coordinator decides merge. After three rounds it may defer non-security, non-data-loss findings to an issue whose body contains the failing test.

## Tests
- One test per behaviour, at the cheapest boundary that proves it. No network, no wall-clock wait, no sleep (inject clocks).
- No child process when a function call proves the same thing. Real Git, gh and provider behaviour belongs in the staging smoke.
- No new process-spawning test files. Run `bun scripts/ci/process-tests.ts --check` and remove stale entries from `scripts/ci/process-tests.txt`. The allowlist only shrinks.
- A test over 1s is rewritten or deleted; never raise a timeout to make a test pass.
- Delete flaky tests the day they appear (never retry or quarantine); replace with a deterministic test if the behaviour matters.
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

## OpenBoard
- Board API: https://openboard.thevibecompany.co/api/tvc/main · Default channel: `armada` (labels: `area=<module>`, `priority=p0|p1|p2`).
- Worker-owned tasks: in sandboxes, install `ob` via https://openboard.thevibecompany.co/install.sh (or `npx -y @the-vibe-company/openboard-cli`), connect under a worker profile via the `armada` connection (secret injected via stdin/env, never in tracked files), and verify with `ob whoami`.
- Claim with `ob tasks claim <id>`, read scope with `ob read <id>`, renew via `ob tasks renew <id>`, post progress and PR URL via `ob reply <id> "<update>"`, and close with `ob tasks complete <id> "<result>"` under the same profile. Put `OpenBoard #<id>` in the PR body (never `Closes #<id>` for an OpenBoard ID).

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
