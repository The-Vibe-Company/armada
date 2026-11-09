# Persisted native repository context

`armada launch <golden> --agent codex --repo <configured-dir|owner/repo>` selects a recorded repository as the native agent's initial working directory, including for an idle launch without a prompt. This is **not directory confinement or an authorization boundary**.

## Public contract

- HTTP: optional `repo` on authenticated `POST /api/v1/sandbox/launch`.
- MCP: optional `repo` on `launch`.
- Selectors: an exact configured `config.repos[].dir` (for the UI), or the existing `owner/repo` manifest identity (case-insensitive, through `resolveLaunchWorkdir`). Unknown, invalid and ambiguous selectors fail before allocation. Arbitrary paths are not accepted.
- Canonical response: `repositoryDir: string | null`, always the configured directory, never the raw owner/repo selector. HTTP launch places it on `sandbox`; MCP/CLI launch and list/status/detail DTOs expose the same field. Omitted selection and legacy records return `null`.
- Frontend label: **Repository context**. The hint can say “The agent starts in this repository.” Choices come from the visible selected golden's configured dirs. Omit `repo` for the default; do not send an empty string.

The selection is stored before any prompt in immutable `sandboxes.repository_dir`. Existing metadata validation remains in `20261110020000_sandbox_repository_context.sql`; `20261110030000_repository_native_cwd_comment.sql` corrects its column description without editing the prior migration. Later edits to the golden cannot change an existing sandbox's selected repository.

## Native behavior

After pulls/init and before either the first prompt **or returning an idle sandbox as ready**, launch calls the public provider method:

```ts
prepareNativeHarnessCwd({ sandboxId, harness, cwd: `${GOLDEN_ROOT}/${repositoryDir}` })
```

A selected repository requires that real preparation capability. An unavailable capability is rejected before fork; failed preparation fails/stops the launch rather than pretending the cwd was changed. Omitted selection retains legacy provider behavior and makes no preparation call.

Boat retains PR535/PR540's native executable wrappers. The Codex stdin app-server bridge also rewrites thread/start, thread/resume and turn/start cwd, because Boat's explicit JSON-RPC cwd overrides process cwd. The wrapper filesystem persists across stop/resume, subsequent sends, new conversations and steer. Prompts and steer instructions are **not prefixed with repository guidance**; model/effort/config fields remain independent and unchanged. See [native-repo-cwd.md](native-repo-cwd.md) for the upstream native regression and real-driver evidence.

There is no unsupported SDK prompt-cwd cast, separate `exec cd` workaround, `--workdir` flag or confinement promise. Modal's actual preparation/runtime driver can use this trusted record through its supported contract; an absent driver must not fall back to Boat or claim preparation succeeded.

## Owner-boundary regressions

`packages/mcp-server/test/repository-context-api.test.ts` covers CLI → canonical HTTP launch → SQL → native preparation, idle launch followed by send/resume/new-conversation/steer, unchanged model overrides and unmodified user prompts, native preparation after init with metadata already persisted, configured-dir and owner/repo selectors, null defaults, immutable context after a golden edit, invisible/invalid selections before forks, and fail-closed missing/failed preparation.

Upstream `launch-workdir.test.ts` owns legacy owner/repo resolution and ambiguity. Upstream `provider-boat/test/native-cwd.test.ts` owns the actual native wrapper/SDK-serialized script and Codex stdio bridge; the optional real-binary test remains opt-in, without inference or credentials. No duplicate pretend-cwd driver was added.

PR541's golden-capabilities operation and scoped read-only metadata contract are preserved alongside the union.

Validation of the native union: full verify passed (419 pass, 4 skip, 0 fail; 423 tests across 73 files). Standalone CLI/server builds, linux-x64 artifacts and npm/Bun tarball/bin smoke passed. The optional real-Codex-binary test was skipped in this sandbox; upstream SDK-installed wrapper/stdio-bridge tests passed. This is not a claim of deployed provider confinement or a replacement for coordinator post-deployment acceptance.
