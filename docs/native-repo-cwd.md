# Boat native repository cwd regression

## Production evidence

The npm 2.3 production launch with `--repo The-Vibe-Company/armada` installed
PR535's `/usr/local/bin/codex.armada-wrapper` for `/home/user/armada`, but the
agent's first native `pwd` returned `/home/user`.

Safe inspection of the installed Boat server's static bundled implementation
(`/opt/ascii-agent/ascii-agents-server`) establishes the actual path:

- `resolveCodexCommand` uses `CODEX_PATH` with no prefix arguments.
- `buildArgs` launches `app-server --listen stdio://` and dynamic config flags.
- `ensureThread` sends `cwd: await requireDirectoryEnv("WORK_DIR")` in both
  `thread/start` and `thread/resume`.
- `turn/start` carries the runtime model, effort, service tier and input.

The running Codex executable's process cwd was the selected repository, confirming
that the wrapper was not bypassed. Explicit thread cwd overrides process cwd;
removing CLI `-C` arguments cannot affect this JSON-RPC setting. No credential
environment, authentication file, prompt log or secret was inspected for this proof.

## Correction

Only selected-repo Codex wrappers interpose an input-only stdio bridge. It replaces
`params.cwd` in `thread/start`, `thread/resume` and `turn/start` with the validated
selected repo, including subsequent sends and process restarts. All other fields
(including runtime model/config, inputs, IDs, effort and service tier) are preserved.
Native stdout/stderr are inherited directly; exit status and termination signals
are propagated. Alternate app-server transports fail closed. Python 3 is already
present on the Boat image and is checked during preparation.

There is no prompt prefix, agent-directed `cd`, SDK-only unknown request field,
server environment mutation, or new persisted credential. Claude and launches
without a repo selector retain their existing behavior.

## Regression checks

- `bun run verify`: full repository lint, typecheck and tests.
- The SDK-boundary test executes the real serialized `/commands` installation
  payload against a temporary native harness, then sends Boat-shaped JSON-RPC
  messages. It proves the actual child `pwd` uses the selected repo even when
  requests explicitly supply the wrong cwd. It covers start, resume, turn,
  argument/field preservation, unrelated messages, malformed input, stderr, EOF
  and native exit status.
- The synthetic cwd sentinel in `native-cwd.test.ts` replaces the native
  binary with a stdio peer that reports its process cwd and the cwd it received.
  It proves the selected repo is both the process cwd and the rewritten
  `thread/start`, `thread/resume` and `turn/start` cwd, without a real binary.
- The former opt-in real-binary cwd test ("real Codex app-server reports the
  selected thread cwd") was removed from unit CI in #2622. It started pinned Codex
  twice inside a five-second test and failed the release check intermittently.
  The real executable now runs only in the publishing contract
  `packages/mcp-server/test/mcp-codex-bridge.release.ts`, which runs the pinned
  executable behind the managed wrapper and checks its exclusive writer lock.
- Automated post-deploy smoke excludes Boat (see
  [Deployed checks](post-deploy-smoke.md)), so a green smoke run gives no Boat
  result for the first native `pwd`. Checking it in a real Boat sandbox is a
  separate on-demand verification: the coordinator-only production Boat parity
  run described in that document.

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server).
