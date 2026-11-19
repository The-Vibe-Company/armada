# Validation contract routing (#2369)

Root cause: default Bun filename discovery treated opt-in provider, native and
PostgreSQL proof as ordinary green unit coverage even when prerequisites were absent.
A skipped declaration is not evidence of its contract.

## Explicit release owners

The existing publishing release `check` job owns a disposable PostgreSQL service
and native build. It runs `scripts/validate-release-contracts.py` after migrations.
Each Bun test suite must report at least one testcase and zero skips, errors,
or failures. Standalone probes must exit successfully.
Missing PostgreSQL/native prerequisites fail closed. No PR job/service is added.

| File under `packages/*/test` (now `.release.ts`) | Retained proof |
| --- | --- |
| core/golden-adoption-postgres | cross-session admission/adoption |
| core/golden-build-jobs-postgres | durable claim/admission fencing |
| core/github-runtime-postgres | refresh pool availability and publication fence |
| core/github-reconnect-postgres | reconnect rotation serialization |
| core/golden-create | invisible commit and concurrent rebuild publication |
| core/golden-snapshot-retirement | retirement serialization and bigint image references |
| mcp-server/lifecycle-driver-postgres | production SQL bigint send/stop |
| mcp-server/runtime-enrolment-postgres | membership revocation lock order |
| mcp-server/runtime-native-auth-postgres | credential publication/lifecycle replacement |
| mcp-server/sql | advisory lock exclusion across commit/rollback |
| cli/binary | compiled CLI packaging and argument/environment boundaries |

`scripts/build-migration.release.ts` retains the standalone compiled migration
contract in the same gate. Mixed core and SQL files retain their deterministic
unit declarations in sibling `.test.ts` files; only real PostgreSQL cases moved.
The Boat cwd sentinel in the unit JUnit report uses a synthetic Codex
protocol peer. It verifies that the wrapper rewrites explicit thread and turn
cwd parameters and starts the peer inside the selected repository. The
pinned Codex credential-rotation contract runs once in the explicit release
runner, verifies that the pinned Codex process holds its managed writer lock,
and fails if the native binary is missing. The Claude MCP refresh test in
`packages/provider-boat/test/native-claude-mcp.test.ts` stays in the unit suite:
it runs the wrapper against a synthetic stream-JSON peer, starts no pinned
harness and finishes in about 0.1 s.

## Local process conformance

These Linux guest-process checks run only when explicitly invoked with
`bun test ./path/to/file.conformance.ts`. They use temporary local fixtures.

- `packages/core/test/docker-snapshot-init.conformance.ts` checks that the
  snapshot supervisor reaps a writer that starts a new session and runs init as
  UID 1000 with no new privileges. It requires Linux pidfd support, Python 3,
  and root or passwordless sudo.
- `packages/mcp-server/test/boat-delegated-access-provider.conformance.ts`
  checks SSH authorization cleanup on guest-script success and conflict.
- `packages/provider-boat/test/native-install-race.conformance.ts` checks
  concurrent native installation with real lock and rename primitives.
- `packages/provider-boat/test/native-writer.conformance.ts` checks
  managed writer serialization, guest admission and orphan recovery.
- `packages/provider-boat/test/runtime-bootstrap.conformance.ts` checks
  artifact verification and detached boot in a local Linux mount namespace
  (requires sudo and mount namespace support).
- `packages/provider-modal/test/snapshot.conformance.ts` checks the guest
  snapshot command against a real open journal descriptor.

## Remaining skip audit

Repository-wide search includes `skipIf`, `test.skip`, conditional test aliases,
`describe.skip` and `todo`. No todo declarations were found. Dispositions:

- Linux platform skips remain in core `golden-helper`, `golden-scan`,
  `golden-script-shell`; provider-modal `distribution`;
  provider-boat `native-cwd`;
  mcp-server `templates`, `managed-inspection`, `runtime-native-auth`;
  agent-runtime `skills`, `runtime`, `readable-variables`, `exec-env`,
  `enrolled-harness`, `messages`, `cwd`, `codex`, `claude`.
  These execute in Linux PR CI; skips on unsupported author machines do not
  represent native release evidence. `golden-helper` is x64-specific and
  `golden-scan` privilege-drop cases require a usable nobody account.
- Core `golden-os`, provider-modal `ssh-os`, mcp-server `github-boat-os` are
  opt-in container/image OS acceptance, not ordinary unit proof. They require
  `ARMADA_GOLDEN_OS_IMAGE` and remain on-demand acceptance checks; no provider
  or image build is introduced into PR CI. Run the Modal SSH probe with
  `ARMADA_GOLDEN_OS_IMAGE=<fixture-image> bun packages/provider-modal/test/ssh-os.probe.ts`. For the server GitHub SSH probe,
  build the local image using the [golden OS fixture recipe](../scripts/fixtures/golden-os/README.md)
  and run `bun scripts/prepare-runtime.ts` after installing dependencies. Then run
  `ARMADA_GOLDEN_OS_IMAGE=<fixture-image> bun packages/mcp-server/test/github-boat-os.probe.ts`.
- The Boat integration probe is coordinator-only and spends sandbox and model
  credits. With `BOAT_API_KEY` exported and Claude Code configured on the Boat
  account, run
  `ARMADA_RUN_LIVE_BOAT_TESTS=1 bun packages/provider-boat/test/integration.coordinator.probe.ts`.
  Set `BOAT_TEST_SNAPSHOT` to fork an existing snapshot or leave it unset to
  build a disposable one (snapshot creation requires a paid account).
  `BOAT_BASE_URL` can select a different Boat API. The probe is outside unit
  discovery, CI, staging acceptance, and the release gate.
- PostgreSQL skips and artifact portable-manifest skips were replaced by
  explicit release prerequisites. The native `mcp-codex-bridge` release
  probe (`packages/mcp-server/test/mcp-codex-bridge.release.probe.ts`) requires
  the pinned binary and a successful process exit. The Modal artifact probe
  (`bun packages/provider-modal/test/artifact.release.probe.ts`) requires the
  Linux native runtime build and waits for the runtime's HTTP listen signal.
  The publishing validator requires both probes to exit successfully.

## Process-spawning unit cases in the Agent Runtime allowlist

The six Agent Runtime entries in the [process-test allowlist](../scripts/ci/process-tests.txt)
contain nine cases that reach a subprocess. Timings are for whole cases from a
focused Linux run using Bun 1.4.2 on main at `62a28af3`, after
`bun scripts/prepare-runtime.ts`.

| File under `packages/agent-runtime/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `exec-env.test.ts` | private exec env authenticates the real core Git helper without model keys, argv credentials or journal token bytes | Locates Git and sends commands through Runner to Bash and the real Git credential helper. | 40.36 ms |
| `exec-env.test.ts` | exec close sanitizes output before replying, recording the process or replaying the command | Runner starts Bash to write synthetic auth state and emit output for redaction. | 5.89 ms |
| `github-bootstrap.test.ts` | actual Boat broker artifact consumes only private stdin and installs credential-free tool files | Bun starts the built broker with a private stdin pipe and checks the local Unix socket. | 56.58 ms |
| `github-parent.test.ts` | actual Boat Claude and Codex parent pipes redact arbitrary current and retired leaves before forwarding | Runs the local installer with sudo and Bun, then Bash launches the installed proxy around Python fixtures for both harnesses. | 205.96 ms |
| `github-parent.test.ts` | native proxy forwards termination signals and reaps its actual original child | Uses the same installer and launches the proxy around a waiting Python fixture for each signal. | 217.06 ms |
| `github-parent.test.ts` | native proxy preserves large newline-free binary output and redacts chunk-spanning leaves | Uses the same installer and launches the proxy around a Python stdin-to-stdout fixture. | 181.71 ms |
| `github-selection.test.ts` | managed gh resolves positional repository shapes without Git or network | Python evaluates the repository selection logic with stubbed Git and HTTP calls. | 16.79 ms |
| `harness-cache.test.ts` | only regular archive entries become files: symlinks neither appear in cache nor affect outside paths | Runs tar to build the archive with symlink entries. Extraction runs in process. | 8.46 ms |
| `skills.test.ts` | aborting private installation terminates its owned process group before returning | The Bash installer runs a local Bun fixture that owns a child. A Unix socket signals readiness and ps checks process state after abort. | 32.85 ms |

The other cases in these six files run in process. The corrupt Skillpack
download fails digest verification before any tool self-test or installer
shell starts. The Boat broker and parent cases use local fixtures and no
deployed Boat service.

### Indirect Agent Runtime subprocess calls

These three files reach real subprocesses through Runner, the Codex driver,
or the runtime tool installer. Timings measure whole cases from a focused
Linux run using Bun 1.4.2 on main at `5b591243`, after
`bun scripts/prepare-runtime.ts`.

| File under `packages/agent-runtime/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `runtime.test.ts` | real exec timeout reconciles missing birth evidence and detached PID retains terminal output | Runner starts Bash for the timed-out and detached commands. | 19.17 ms |
| `runtime.test.ts` | revoking a dial-out request kills its synchronous exec before returning | Runner starts Bash. The command writes a readiness file before `exec sleep`. The file watcher revokes the request and Runner terminates the process group. | 6.29 ms |
| `readable-variables.test.ts` | readable bootstrap reaches only intended native harness, not init/exec or request journal | Runner starts Bash for the environment checks. The real Codex driver starts the local app-server fixture. | 37.27 ms |
| `tool-cache.test.ts` | pinned runtime tool download prepares verified foreground binaries with clean env and repairs a corrupt warm cache | The installer starts local shell-script version and help probes on cold install, warm-cache use and cache repair. Fetch is stubbed. | 43.11 ms |
| `tool-cache.test.ts` | runtime tool preparation refuses unsafe redirects, changed bytes and failed version self-tests | The bad-version fixture reaches a real shell-script probe. Redirect and digest rejection happen before any probe starts. | 8.57 ms |

The other five cases in `runtime.test.ts` run in process. The delayed detached
close case replaces `ChildOwner.spawn` with a synthetic child. Other indirect
runtime paths still need case-level timings, including native harness fixtures
in `codex.test.ts`, `claude.test.ts`, `native-resume.test.ts` and
`driver-rate-limit.test.ts`.

## Process-spawning unit cases in `provider-modal`

The [process-test allowlist](../scripts/ci/process-tests.txt) records matching
files. For [#3179](https://github.com/The-Vibe-Company/armada/issues/3179), this
inventory records the individual Modal cases that reach a real subprocess.
The CI column uses the named passing lines from [run 44526380196, attempt 1](https://github.com/The-Vibe-Company/armada/actions/runs/44526380196/attempts/1).
Parallel workers interleave their output, so a file header alone cannot
attribute later timing lines to that file. The local column is one focused
Linux run using Bun 1.4.2 on main at `fa1f93d9`. Both columns measure the
whole case.

| File under `packages/provider-modal/test` | Case | Local subprocess boundary | CI | Local |
| --- | --- | --- | ---: | ---: |
| `artifact-validation.test.ts` | embedded portable loader rejects empty/unpinned artifacts without requiring native files or host architecture | Starts Bun in a disposable package tree to exercise the real file imports. | 58.56 ms | 34.71 ms |
| `distribution.test.ts` | image artifact RUNs replay in real Linux shells beyond MAX_ARG_STRLEN and verify bytes before publication | Checks Linux's argument size limit and replays the generated image commands in `/bin/sh`. | 332.50 ms | 243.98 ms |
| `distribution.test.ts` | fresh saved-golden fork receives current verified runtime without editing native state or restored code | Uses sudo and routes the fixture SDK's exec calls to local processes for the runtime overlay. | 342.43 ms | 248.61 ms |
| `security.test.ts` | snapshot quiescence shell is valid and a failed remote scrub prevents success | Runs `bash -n` inside the stubbed SDK exec and supplies a nonzero scrub result. | 4.13 ms | 2.41 ms |

The audit included tracked Modal unit files and their process-capable helpers.
The CLI boundary in `conformance-app.test.ts` injects its command runner, and
the guest process in `runtime-bootstrap.test.ts` is simulated in a VM.
Explicit release, conformance and probe files are outside unit discovery.

## Process-spawning unit cases in Dashboard

The three Dashboard entries in the [process-test allowlist](../scripts/ci/process-tests.txt)
each contain one case that reaches a subprocess. The times below measure each
whole case in a focused Linux run using Bun 1.4.2 on main at `67d096dd`.

| File under `apps/dashboard/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `routine-staging-transport.test.ts` | routine cleanup DELETE reaches the configured control API through the public origin | Python runs the routine staging checker's request construction with a fake opener. The test forwards the captured request through the Dashboard proxy in process. | 75.06 ms |
| `staging-check-route-parity.test.ts` | staging checker status and stop preserve CLI public-proxy routes, identity and org | Python sends the staging checker's requests to a loopback Dashboard proxy fixture with a fake upstream. | 65.40 ms |
| `stats-db.test.ts` | stats client omits pooler-incompatible startup parameters | A Bun subprocess isolates the `postgres` module mock and captures the stats client's connection options. | 5.31 ms |

The missing-database-URL case in `stats-db.test.ts` runs in process. Both
staging-checker cases use local fixtures and make no calls to deployed services.

## Evidence owed after merge

Run the existing publishing release validation on the exact release SHA. Verify
routed Bun suites print executed testcase counts with zero skips, the native
Codex and Modal artifact probes report success, and native version validation
and checkpoint process boundaries pass. No production action or
Boat lifecycle is required for this test-routing change. OS/container checks
remain separately opt-in, not an implied pass from green unit CI.
