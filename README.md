# Armada

Armada launches coding agents (Claude Code, Codex) on [boat.dev](https://boat.dev) sandboxes, from a golden snapshot, with or without a prompt. Orchestrators drive the agents through a remote MCP server; people use the `armada` CLI, which ships in the same binary.

Armada is a launcher, not an orchestrator: it does not split work, merge pull requests or read a tracker.

- **Specification (v0):** [#455](https://github.com/The-Vibe-Company/armada/issues/455)
- **This scaffold:** [#456](https://github.com/The-Vibe-Company/armada/issues/456)

> **Status:** scaffold. The binary only answers `--version` and `--help`. The commands of the spec land ticket by ticket (see #455).

## Layout

A Bun and TypeScript monorepo (Bun workspaces, strict `tsconfig.json` shared by every package).

| Package | Name | Role |
| --- | --- | --- |
| `packages/core` | `@armada/core` | The contract every other package shares: types (harnesses, visibility, provider), the version. No I/O. |
| `packages/provider-boat` | `@armada/provider-boat` | The boat.dev placement: the provider adapter over the boat.dev API. |
| `packages/cli` | `@armada/cli` | The `armada` command; `src/main.ts` is the entry of the compiled binary. |
| `packages/mcp-server` | `@armada/mcp-server` | The remote MCP server (hosted on Railway) that orchestrators call. |

`scripts/build.ts` compiles the binary. Every package carries the same version, the one `armada --version` prints (`packages/core/package.json`); a test fails if they drift apart.

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

bun run build                        # dist/armada for this machine
bun run build --target linux-arm64   # dist/armada-linux-arm64
bun run build:all                    # dist/armada-<target> for linux and macOS, x64 and arm64
./dist/armada --version
```

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
