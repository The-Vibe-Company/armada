# Repository instructions

Armada v2 launches coding agents (Claude Code, Codex) on boat.dev sandboxes: a remote MCP server for orchestrators and the `armada` CLI, in one binary. It is a launcher, not an orchestrator. The specification is issue #455; read it before changing behaviour.

Armada v1 (the fleet orchestrator) is archived at the tag `armada-v1-final`. Its code is not on `main`; bring a piece over by hand when v2 needs it (`git show armada-v1-final:<path>`), never by restoring whole folders.

## Layout

- `packages/core` (`@armada/core`): the shared contract (types, the version). No I/O. `src/provider.ts` is the `Provider` interface (goldens, sandboxes, prompts, events by cursor), the common `AgentEvent` stream, per-harness capabilities and `ProviderError`. `src/golden-config.ts` is the versionable golden file (repos, branches, init; secret keys refused) and the namespaced boat snapshot name. `src/golden.ts` builds, connects and snapshots a golden through a `Provider` and a `GoldenStore`; `goldenForLaunch` is the lookup launch uses. `src/golden-store.ts` is that store over SQL, under the caller's database role. `src/database.types.ts` is generated from the Supabase migrations (`bun run db:types`).
- `supabase/migrations`: the Supabase CLI migrations. Schema first, then row level security. A fresh Supabase database already has `auth.users`, `auth.uid()` and the `authenticated` and `service_role` roles. `goldens.boat_sandbox_id` is the master sandbox; `boat_snapshot_id` is the namespaced saved-snapshot name, null until snapshot. `oauth_clients` and `oauth_codes` are the MCP authorization server, writable only as `service_role`.
- `packages/provider-boat` (`@armada/provider-boat`): the boat.dev provider adapter over `@boatdev/sdk` (`createBoatProvider`; `src/errors.ts` maps boat errors, `src/events.ts` normalizes events). `createGolden` always sends `noEnv: true` and never an account environment. Unit tests run the real SDK against a fake `fetch`; `test/integration.test.ts` is opt-in (`BOAT_API_KEY`).
- `packages/auth` (`@armada/auth`): Supabase login, the MCP OAuth server, service tokens and bearer verification. Tokens are stored as lowercase sha-256 hex. The CLI keeps the Supabase session on the machine; the MCP server verifies bearers with the service role and does not cache them.
- `packages/cli` (`@armada/cli`): the `armada` command. `src/run.ts` takes its I/O as arguments; `src/main.ts` wires the process and is the binary's entry. `armada golden` creates, connects, snapshots and lists. Supabase is reached with the user JWT (`src/supabase.ts`), never a service role key. Until credentials land, `BOAT_API_KEY` is the boat key and it is not read from the boat account. `armada login` and `armada token` are the auth commands.
- `packages/mcp-server` (`@armada/mcp-server`): the remote MCP server. It re-exports auth so the tool server (#464) can mount `handleOAuthRequest` and call `authenticate`.
- `scripts/build.ts`: compiles the binary with `bun build --compile` (linux and macOS, x64 and arm64).

## Commands

- `bun install`
- `bun run verify`: lint (Biome), typecheck (`tsc`, strict) and tests (`bun test`). CI runs the same as "Lint, typecheck and test".
- `bun run format`: apply Biome formatting and safe fixes.
- `bun run build` (this machine), `bun run build --target <os-arch>`, `bun run build:all`: the binary in `dist/`.
- `bun run armada <args>`: the CLI from source.
- `bun run db:types`: regenerate `packages/core/src/database.types.ts` after a migration change.

## Rules

- **One binary.** The CLI and the MCP server ship as the single `armada` executable from `bun build --compile`. Code in it may use Bun APIs; a dependency must bundle into it.
- **One version.** Every `packages/*/package.json` carries the same version; `@armada/core` exports it and `armada --version` prints it.
- **Secrets never in the repository.** Keys come from the environment or Armada's encrypted store; never print one, never write one into a file, a fixture or a log. Goldens hold no secrets. In the database a secret is ciphertext (`bytea`, `*_enc`) or a token hash, and a user JWT cannot read the ciphertext columns.
- **Schema changes are new migrations.** Never edit a migration that has been applied. Row level security is the access rule: members see org resources, a private resource is visible only to its owner, and only an admin changes an org golden, the members or an org key.
- **Tests earn their place.** One test per behaviour at the cheapest boundary, no network, no wall-clock waits.
- **English** in code, CLI output, docs and comments.
- Pull request titles follow Commitizen, for example `feat(cli): launch an agent from a golden`.
