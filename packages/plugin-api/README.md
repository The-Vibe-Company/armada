# Plugin conformance

Run `armada plugin test <directory>` from a checkout or the published CLI. The
command reads `armada-plugin.json`, or the `armada` field in `package.json`, then
uses the daemon's manifest/API/config validation and atomic activation. The
package's `exports` (`import`/`default`) or `main` selects its ES module; without
one, it loads `index.js`. Build TypeScript plugins to JavaScript before running
the published Node CLI. An explicitly tested plugin runs even if disabled in
the app; the command never changes the app's switches or reads owner keys.

Each check prints `PASS` or `FAIL` and its name, followed by passed/failed counts.
A refusal is the loader's single `Plugin <id> refused: ...` line. Exit status is
0 for all passing checks (including `hello` with zero), 1 for a refusal or failed
check, 2 for invalid command arguments. `--report result.json` saves the same
results as JSON; `--json` prints them instead of progress lines. Reports contain
`plugin`, `loaded`, `passed`, `failed`, `checks` (`name`, `passed`, optional
`error`), and an optional load `error`.

The examples under `fixtures/<seam>/` are the executable conformance cases. The
runner gives plugins an in-memory event log, synthetic declared secrets
(`plugin-conformance-secret`), a temporary directory and a local HTTP endpoint.
Nothing contacts Linear, GitHub or a model service on the runner's behalf.
Plugins execute as trusted in-process modules, just as at daemon boot.

For a provider with configuration, add `armada-plugin.test.json` beside its
manifest. Its shape is the same config map passed to `activate(ctx)`, keyed by
seam and contribution kind. `${endpoint}` expands to the temporary loopback
server and `${directory}` to the temporary sandbox. For example:

```json
{
  "tracker": { "example": { "endpoint": "${endpoint}/tracker" } },
  "model": { "example": { "baseURL": "${endpoint}/model", "apiKey": "fixture" } },
  "runtime": { "example": { "workspaceRoot": "${directory}" } }
}
```

Configuration still must pass each contribution's JSON Schema. All declared
contributions run, once per kind. The test configuration should route network
clients to the fixture endpoint and workspace creation into the sandbox. The
reference tracker/forge recordings use provider-neutral rows; providers for
other wire formats can extend the recordings with native responses while
retaining their seam's event expectations. Writes and merges must be observable
at that endpoint. Do not put real credentials in test configuration.

`bun run test:plugins` runs this command for every bundled plugin; it also runs
inside `bun run test` and `bun run verify` and CI's test job. The CLI tarball
includes the fixtures, including the fake worker script.

Each check has a five-second deadline. Runtime continuations observe cancellation,
and a handle returned late is stopped before it can be used. Cleanup gets a
bounded grace period before the sandbox is removed. As with daemon activation,
a trusted provider that never returns a handle or never completes `stop` cannot
be forcibly cleaned up through this in-process API.
