# Persisted repository context

For a Boat or Modal launch, select a repository configured on the starting snapshot. For a Boat snapshot named
`my-snapshot` with the configured directory `web`, an idle launch looks like this.

```sh
armada launch my-snapshot --provider boat --agent codex --repo web
```

You can also pass the repository's `owner/repo` identity, for example
`--repo acme/web`. The selection sets the agent's initial working directory,
including for a launch without a prompt. It does not restrict filesystem access.

## Public contract

- HTTP: optional `repo` on authenticated `POST /api/v1/sandbox/launch`.
- MCP: optional `repo` on `launch`.
- Selectors: an exact configured `config.repos[].dir` (for the UI), or the existing `owner/repo` manifest identity (case-insensitive, through `resolveLaunchWorkdir`). Unknown, invalid and ambiguous selectors fail before allocation. Arbitrary paths are not accepted.
- Canonical response: `repositoryDir: string | null`, always the configured directory, never the raw owner/repo selector. HTTP, MCP and CLI launch place it on `sandbox`. List, status and detail responses also expose the field. Omitted selection and legacy records return `null`.
- Dashboard: choose a repository in the **Repository** picker to find starting
  snapshots that already contain it. With a snapshot selected and no repository
  picked, the **Folder** control lets you choose a configured directory when
  shown. The sandbox detail page displays the persisted selection under
  **Repository context**.
- To use the API default, omit `repo` entirely.

The selection is stored before any prompt in immutable `sandboxes.repository_dir`. Existing metadata validation remains in `20261110020000_sandbox_repository_context.sql`; `20261110050000_repository_native_cwd_comment.sql` corrects its column description without editing the prior migration. Later edits to the snapshot cannot change an existing sandbox's selected repository.

## Runtime and native behavior

For Boat and Modal snapshot launches using the Armada runtime, sandbox configuration sets the
working directory to `/home/user/<configured-dir>` from the stored
`repositoryDir`. With no selection, the runtime starts in `/home/user`.

On the native path, the provider must support repository working-directory
preparation.

After pulls/init and before either the first prompt **or returning an idle sandbox as ready**, launch calls the public provider method:

```ts
prepareNativeHarnessCwd({ sandboxId, harness, cwd: `${GOLDEN_ROOT}/${repositoryDir}` })
```

A selected repository requires that real preparation capability. An unavailable capability is rejected before fork; failed preparation fails/stops the launch rather than pretending the cwd was changed. Omitted selection retains legacy provider behavior and makes no preparation call.

Boat retains PR535/PR540's native executable wrappers. The Codex stdin app-server bridge also rewrites thread/start, thread/resume and turn/start cwd, because Boat's explicit JSON-RPC cwd overrides process cwd. The wrapper filesystem persists across stop/resume, subsequent sends, new conversations and steer. Prompts and steer instructions are **not prefixed with repository guidance**; model/effort/config fields remain independent and unchanged. See [native-repo-cwd.md](native-repo-cwd.md) for the upstream native regression and real-driver evidence.

Use the provider that owns the snapshot.

## Owner-boundary regressions

The former cross-transport test `repository-context-api.test.ts` was removed in #2622: its single five-second test started PGlite and replayed CLI, HTTP, MCP and SQL, and failed the merge queue intermittently. Its behaviours are owned at cheaper boundaries: `packages/core/test/launch.test.ts` (idle launch persists the selected repository and prepares cwd before returning; explicit repo prepares each harness before its first prompt; explicit selectors are validated after authorization and before allocation; preparation failure stops the sandbox and never prompts), `packages/core/test/database.test.ts` (repository context must name a configured repo and stays immutable after a golden edit), and `packages/mcp-server/test/server.test.ts` (an idle launch keeps its model and effort for every send, across stop, and an override lasts one turn).

Upstream `launch-workdir.test.ts` owns legacy owner/repo resolution and ambiguity. Upstream `provider-boat/test/native-cwd.test.ts` owns the actual native wrapper/SDK-serialized script and Codex stdio bridge; the real-binary cwd test was removed from unit CI (#2622); a synthetic stdio peer proves the wrapper half of that contract (the peer's process cwd and the rewritten thread/turn cwd). No test now checks that real Codex reports the selected thread cwd. No duplicate pretend-cwd driver was added.

PR541's golden-capabilities operation and scoped read-only metadata contract are preserved alongside the union.

Historical validation of the native union: full verify passed (419 pass, 4 skip, 0 fail; 423 tests across 73 files). Standalone CLI/server builds, linux-x64 artifacts and npm/Bun tarball/bin smoke passed. The optional real-Codex-binary test was skipped in this sandbox; upstream SDK-installed wrapper/stdio-bridge tests passed. This is not a claim of deployed provider confinement or a replacement for coordinator post-deployment acceptance.
