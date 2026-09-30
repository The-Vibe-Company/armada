# Repository instructions

Armada runs a fleet of coding agents on one project: Linear holds the plan and progress, GitHub holds the code, and the `armada` CLI gives the coordinator and the workers one shared reading of the fleet.

## Layout

- `packages/core`: `armada.toml` parsing, read adapters for Linear and GitHub, and the pure fleet derivations (tickets in flight, frontier, pull requests waiting). No I/O outside the adapters, which take an injected `fetch`.
- `packages/cli`: the `armada` command. Side effects are injected through `Io` in `src/cli.ts`; `src/main.ts` wires the real process.
- `packages/dashboard`: placeholder for the live Fleet view.
- `armada.toml`: this repository's own Armada configuration.

## Commands

- `bun install`
- `bun run verify`: lint (Biome), typecheck (`tsc`) and tests (`bun test`). CI runs the same on every pull request.
- `bun run format`: apply Biome formatting and safe fixes.
- `bunx armada status [--json]`: needs `LINEAR_API_KEY`; GitHub uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

## Rules

- **Generic and open source.** No customer or private project names, data, thresholds or recorded responses. Fixtures are synthetic: invented ticket ids, titles and people.
- **Everything project-specific comes from `armada.toml`.** Program root, repository, label names and thresholds are configuration, never constants.
- **Secrets only from the environment.** Tokens are read in one place, `resolveCredentials` in `packages/core/src/credentials.ts`; never read them anywhere else, and never write a token into a file, a fixture or a log.
- **Tests earn their place.** One owner test per behaviour at the cheapest boundary; no network (use the recorded-fetch helper in `packages/core/test/support.ts`), no wall-clock waits (inject `now`).
- **English** in code, CLI output, docs and tracker comments.
- Pull request titles follow Commitizen, for example `feat(cli): show the fleet state with armada status`.
- Work follows the fleet protocol: one ticket, one branch named after it, one pull request. Workers never merge.
