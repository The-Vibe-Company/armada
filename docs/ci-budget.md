# Two-minute CI verdict — slice 1 (#1269)

Required names to retain:
- Migration versions
- Lint, typecheck and test
- Golden PostgreSQL concurrency
- Golden OS recipe (actual provider image)
- Binary (linux-x64), Binary (linux-arm64), Binary (darwin-arm64)

The ruleset is coordinator-owned. Retain **Golden OS recipe (actual provider image)** exactly; its cheap verdict reports independently of full informational conformance. **CI budget (120s)** is non-required per the coordinator decision.
Intel macOS still builds/tests on main, manual runs, and the unchanged release workflow.

PR and merge-group expensive checks compare the entire candidate against its event
base. Both conservatively depend on all packages (including CLI/server entrypoints,
shared core, providers and runtime artifacts), migrations (embedded binary schema
version), the lockfile/root package/tsconfig, build/npm/runtime/image scripts, fixtures,
local actions and CI workflow. Dashboard-only and documentation-only changes report
the existing required names without building. Main/manual runs always build everything.
A classifier failure cannot produce a green budget diagnostic.

## Non-required timing diagnostics (urgent coordinator decision, 2026-11-13)

**Lint, typecheck and test** depends only on the real verification jobs and
checks every dependency's result. It never depends on or executes the budget
check. Runner timing cannot turn successful code checks red.

**CI budget (120s)** is a separate, visible, **non-required** job on PRs and merge
groups, after the required verdict and its prerequisites, as established by the
coordinator-owned ruleset. Its own runner queue, checkout, API calls and setup
are not admission latency: the script measures the latest completed required-path
verdict minus workflow start, including the required aggregate. Only known
required-path names participate; informational Golden OS, Intel macOS, unrelated
informational jobs and the budget job itself are ignored. A late required path
still fails this diagnostic and writes its summary, without failing the required
gate. No threshold increase, polling or test/assertion weakening.

## Informative recipe policy (coordinator decision, 2026-11-12)

The informational Golden OS job runs on affected PRs and main/manual runs,
not merge groups. The cheap required Golden OS verdict is retained with its exact ruleset name
on PRs and merge groups; it never waits for the full recipe.
Do not require the informational name. A full failure remains visible/loud on main.
Recipe classification now shares migration validation and includes actual source,
manifest, recipe/fixture and OS-test inputs, not unrelated test files or migrations.

The coordinator explicitly accepted this separation in
[issue #1269](https://github.com/The-Vibe-Company/armada/issues/1269#issuecomment-6835653366).
The cold recipe no longer holds the required verdict open. Real PR/merge-group
timings still need measurement, including runner queues. Browser sharding is the
next separate slice.

## Runner headroom: corrected with CI evidence

The first local eight-shard sizing underestimated hosted-runner setup. In real
CI run 43331661708, all eight unit jobs passed (95–109s), but the old required
timing enforcement failed at 128.5s. The urgent policy above removes that timing
failure from correctness admission; it is not a reason to weaken any tests.

Weights now use **354 actual CI per-file wall timings**, totalling **447.262s**.
New files remain automatic discoveries with a 1s estimate. CI setup includes
PostgreSQL startup, installs and migrations as well as native building: the
native build itself measured 1.8–7.1s, not the entire build-plus-migration span.

Unit jobs now prepare the portable bundle instead of rebuilding the same native
runtime in every shard. The existing static-checks job still builds/validates the
full native runtime and runs the three relocated native-only assertions: actual
artifact bootstrap, real Codex cwd, and real same-process MCP rotation. Their JUnit
reports must contain each selected case exactly once, passed and not skipped;
Bun's unrelated filtered cases do not count against that check. Other assertions
still run in unit shards unchanged. No retries or raised timeouts.

After removing repeated native build time, observed CI setup/cleanup overhead is
conservatively bounded at about 48.2s. Including the newly discovered routing-state
test's 1s estimate, refreshed LPT sizing is:

| Shards | Slowest test-process load | With 48.2s observed overhead |
| --- | --- | --- |
| 8 | 56.035s | 104.235s |
| 10 | 44.828s | 93.028s |
| **11** | **40.754s** | **88.954s** |
| 12 | 37.357s | 85.557s |

Eleven, not eight, is the smallest count below ~90s under this CI-derived model.
The required-path job count drops from 21 to 19 versus main; including the
separate budget diagnostic, runner jobs drop from 22 to 20 (plus informative
recipe work when affected). Classification shares the migration job, and the
required Golden OS compatibility verdict is retained. All discovered test files remain assigned
exactly once, with one fresh Bun process each and cancellation cleanup.

The organisation API returns `plan: null`, not an Actions concurrency limit.
An administrator must confirm the actual limit L and reserve R slots for browser,
PR and other workflows before deriving a safe queue cap `floor((L - R) / 19)`.
The temporary cap two is not proven safe without that information. Browser
promotion still needs complete PR/merge-group timing and capacity evidence.
