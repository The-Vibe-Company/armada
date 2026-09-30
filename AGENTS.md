# Repository instructions

Armada runs a fleet of coding agents on one project: Linear holds the plan and progress, GitHub holds the code, and the `armada` CLI gives the coordinator and the workers one shared reading of the fleet.

## Layout

- `packages/core`: `armada.toml` parsing, read adapters for Linear and GitHub, the machine store (`machine.ts`: keys and personal defaults under `~/.config/armada`), and the pure fleet derivations (tickets in flight, frontier, pull requests waiting). No I/O outside the adapters; network adapters take an injected `fetch`.
- `packages/cli`: the `armada` command. Side effects are injected through `Io` in `src/io.ts`; `src/main.ts` wires the real process; `src/bin.ts` is the entry of the published Node bundle.
- `packages/dashboard`: placeholder for the live Fleet view.
- `armada.toml`: this repository's own Armada configuration.

## Commands

- `bun install`
- `bun run verify`: lint (Biome), typecheck (`tsc`) and tests (`bun test`). CI runs the same on every pull request.
- `bun run format`: apply Biome formatting and safe fixes.
- `cd packages/cli && npm pack`: build `dist/armada.js` (Bun bundles `core` for Node) and pack the npm tarball. CI installs that tarball and runs it on every pull request.
- `bun run armada status [--json]`: runs the CLI from source; needs `LINEAR_API_KEY`; GitHub uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.
- `bun run armada auth login|status|logout`: keys stored once per machine in `~/.config/armada/credentials`.

## Rules

- **Generic and open source.** No customer or private project names, data, thresholds or recorded responses. Fixtures are synthetic: invented ticket ids, titles and people.
- **Everything project-specific comes from `armada.toml`.** Program root, repository, label names and thresholds are configuration, never constants.
- **Secrets from the environment or the machine store, resolved in one place.** `resolveCredentials` in `packages/core/src/credentials.ts` picks each key (environment first, then `~/.config/armada/credentials`); only `packages/core/src/machine.ts` reads or writes that file. Never read tokens anywhere else, never print one, and never write one into a repository file, a fixture or a log. Tests point `XDG_CONFIG_HOME` at a temporary directory, never at the real one.
- **Tests earn their place.** One owner test per behaviour at the cheapest boundary; no network (use the recorded-fetch helper in `packages/core/test/support.ts`), no wall-clock waits (inject `now`).
- **English** in code, CLI output, docs and tracker comments.
- **Releases.** The CLI is published to npm as `@the-vibe-company/armada` by release-please (`.github/workflows/release.yml`). Pull request titles become the changelog: while in 0.x, `feat` and `fix` bump the patch version and a breaking change bumps the minor. After any merge that touches `packages/cli` or `packages/core`, the coordinator merges the open release pull request right away, so every change ships (continuous 0.x). Publishing uses npm Trusted Publishing; never add an npm token.
- Pull request titles follow Commitizen, for example `feat(cli): show the fleet state with armada status`.
- Work follows the fleet protocol: one ticket, one branch named after it, one pull request. Workers never merge.
