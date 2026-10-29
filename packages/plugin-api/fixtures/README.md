# Plugin conformance fixtures

These synthetic recordings exercise the public plugin API without provider
credentials or remote services. `armada plugin test <directory>` serves them
on a temporary loopback HTTP endpoint, supplied through the plugin directory's
optional `armada-plugin.test.json`. That file contains a `PluginConfig` object;
`${endpoint}` expands to the loopback base URL and `${directory}` expands to
the temporary owned sandbox. For example:

```json
{
  "tracker": { "example": { "endpoint": "${endpoint}/tracker" } },
  "forge": { "example": { "endpoint": "${endpoint}/forge" } },
  "model": { "example": { "endpoint": "${endpoint}/model" } },
  "node": { "example": { "workspaceRoot": "${directory}" } }
}
```

Each `<seam>/response.json` has a `response` served as JSON. Tracker and forge
recordings also define `expectedEvents`, compared with events appended by the
provider during its `read({ project: "plugin-conformance" })` call. Additional
payload fields are allowed. Tracker rows include one ticket and one report
comment. Forge rows include a pull request with a successful `verify` check.
A plugin adapter maps these provider-neutral rows to Armada event payloads;
these recordings do not imitate any vendor's API.

- A read at `/tracker` returns `tracker/response.json`'s `response`. The read must
  append its recorded `ticket.seen` and `ticket.report-posted` events.
- Tracker writes use POST, PUT, or PATCH below `/tracker`. The request body
  must contain the unique comment passed to `write`.
- A read at `/forge` returns `forge/response.json`'s `response`. The read must append
  its recorded `pull-request.seen` event, including the successful CI state,
  check details, and check-completion status.
- Forge merges use POST, PUT, or PATCH below `/forge`, sending PR number `17`
  in the path or body and the requested head in the body. The fixture returns
  `{ "merged": true }` and the provider must confirm that result.
- `POST /model/chat/completions` returns `model/response.json`'s `response`,
  an OpenAI-compatible completion containing one `conformance_echo` tool call
  with `{ "message": "fixture-tool-call" }`. The returned model is exercised
  through AI SDK `generateText` with a JSON Schema tool definition.

Runtime and node checks initialize a local Git repository and ask `prepare`
for a real workspace inside the temporary sandbox. They copy `runtime/worker.mjs`
into that workspace and launch Node. The fixture emits its readiness marker
only when both stdin and stdout are TTYs, acknowledges each delivered nonce,
and exits normally on `exit`. Checks separately observe running, delivery,
stop, and normal process exit. Providers must put output in `observe().reply`.
The public node API has no workspace teardown operation; the runner stops
workers and removes the whole owned temporary sandbox after the checks.

Read transport may use GET or POST (including GraphQL). Native provider
recordings can extend the `response` bodies while retaining the independent
`expectedEvents`; transport shape is owned by each provider.

`node/workspace.json` defines the seed file and branch prefix shared by runtime
and node preparation. Preparation must preserve that file's bytes and check out
the requested branch; returning an empty directory fails the check.
