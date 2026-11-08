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
- Optional offline real-binary test (no inference or credentials):
  `CODEX_NATIVE_TEST_BINARY=/path/to/unwrapped/codex bun test packages/provider-boat/test/native-cwd.test.ts`.
  It runs the native app-server with an isolated HOME and allowlisted environment.
  The unwrapped process starts in repo B but returns the caller-supplied other cwd;
  the wrapped process returns repo B for the same `thread/start` request.

The optional test passed using the production-installed
`/usr/local/bin/codex.armada-original`. This does not replace the parent's final
post-deployment first-native-`pwd` check in a new sandbox.

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server).
