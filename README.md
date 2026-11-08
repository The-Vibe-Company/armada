# Armada

Armada launches coding agents (Claude Code, Codex) on [boat.dev](https://boat.dev) sandboxes, from a golden snapshot, with or without a prompt. Orchestrators drive the agents through a remote MCP server; people use the `armada` CLI, which ships in the same binary.

Armada is a launcher, not an orchestrator: it does not split work, merge pull requests or read a tracker.

- **Specification (v0):** [#455](https://github.com/The-Vibe-Company/armada/issues/455)
- **This scaffold:** [#456](https://github.com/The-Vibe-Company/armada/issues/456)

> **Status:** goldens can be created, connected, snapshotted and listed (`armada golden`), and a golden can be launched into a sandbox (`armada launch`). `armada login` and `armada token` sign a person in and mint service tokens. Events and the MCP tool server are #464: it mounts the OAuth routes and calls `authenticate` from `@armada/auth`.

## Layout

A Bun and TypeScript monorepo (Bun workspaces, strict `tsconfig.json` shared by every package).

| Package | Name | Role |
| --- | --- | --- |
| `packages/core` | `@armada/core` | The contract every other package shares: types, the golden config and workflow, the generated database types, the version. No I/O of its own. |
| `packages/provider-boat` | `@armada/provider-boat` | The boat.dev placement: the provider adapter over the boat.dev API. |
| `packages/cli` | `@armada/cli` | The `armada` command; `src/main.ts` is the entry of the compiled binary. |
| `packages/auth` | `@armada/auth` | Supabase login (GitHub, Google), the MCP OAuth server, service tokens and bearer checks. |
| `packages/mcp-server` | `@armada/mcp-server` | The remote MCP server (hosted on Railway) that orchestrators call. |

`scripts/build.ts` compiles the binary. Every package carries the same version, the one `armada --version` prints (`packages/core/package.json`); a test fails if they drift apart.

## Database

`supabase/migrations` is the schema, applied by the [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase db reset` on a local project, or `supabase migration up`). It assumes a fresh Supabase database: Auth's `auth.users` and `auth.uid()`, and the `authenticated` and `service_role` roles.

`packages/core/src/database.types.ts` is generated from those migrations. After changing them, run `bun run db:types` and commit the result. A test fails if the file drifts. The migrations themselves are checked on a fresh in-memory Postgres, including the row level security rules.

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
bun run armada login
bun run armada token create --org <name> --label <label>

bun run build                        # dist/armada for this machine
bun run build --target linux-arm64   # dist/armada-linux-arm64
bun run build:all                    # dist/armada-<target> for linux and macOS, x64 and arm64
./dist/armada --version
```

## Launching

`armada launch` forks a golden's saved snapshot, pulls each repo, runs the init commands and, with a prompt, starts the agent. Without a prompt the sandbox waits, ready, for its first prompt. The fork gets `noEnv`, an explicit TTL (default 4 hours) and Armada's labels, and an environment with only the credentials of the chosen agent (the caller's own, else the org's). Nothing is written to the golden.

Until the encrypted credential store lands (#461), credentials come from the environment: `ARMADA_CLAUDE_OAUTH_TOKEN` (becomes `CLAUDE_CODE_OAUTH_TOKEN`) and `ARMADA_OPENAI_API_KEY` (an OpenAI key, or the content of Codex's `auth.json`), with `ARMADA_ORG_CLAUDE_OAUTH_TOKEN` and `ARMADA_ORG_OPENAI_API_KEY` as the org defaults.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`:

- **Lint, typecheck and test**: `bun run lint`, `bun run typecheck`, `bun run test`.
- **Binary (linux-x64, linux-arm64, darwin-x64, darwin-arm64)**: each binary is compiled with `bun build --compile` on a runner of its own platform, checked with `armada --version` there, and uploaded as the `armada-<target>` artifact of the run.

## Armada v1

This repository used to hold Armada v1, a fleet orchestrator (Linear, merge queue, dashboard, desktop app, the `@the-vibe-company/armada` npm package up to 0.2.73). It is archived:

- Its last commit is tagged [`armada-v1-final`](https://github.com/The-Vibe-Company/armada/tree/armada-v1-final); its release tags (`v0.1.0` to `v0.2.73`) and the whole history stay in this repository.
- Its code is not on `main` anymore. Pieces worth keeping (for example the Claude Code and Codex adapters) are brought over by hand, as v2 needs them: `git show armada-v1-final:<path>`.
- The npm package is not published from this repository anymore; its released versions stay on npm.

## License

[MIT](LICENSE)
