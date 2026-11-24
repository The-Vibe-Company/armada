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
## Local process conformance

These Linux guest-process checks run only when explicitly invoked with
`bun test ./path/to/file.conformance.ts`. They use temporary local fixtures.

- `packages/core/test/docker-snapshot-init.conformance.ts` checks that the
  snapshot supervisor reaps a writer that starts a new session and runs init as
  UID 1000 with no new privileges. It requires Linux pidfd support, Python 3,
  and root or passwordless sudo.
- `packages/mcp-server/test/boat-delegated-access-provider.conformance.ts`
  checks SSH authorization cleanup on guest-script success and conflict.
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
  `ARMADA_GOLDEN_OS_IMAGE=<fixture-image> bun packages/provider-modal/test/ssh-os.probe.ts`.
- The Boat integration probe is coordinator-only and uses Boat compute.
  With `BOAT_API_KEY` exported, run
  `ARMADA_RUN_LIVE_BOAT_TESTS=1 bun packages/provider-boat/test/integration.coordinator.probe.ts`.
  Set `BOAT_TEST_SNAPSHOT` to fork an existing snapshot or leave it unset to
  build a disposable one (snapshot creation requires a paid account).
  `BOAT_BASE_URL` can select a different Boat API. The probe is outside unit
  discovery, CI, staging acceptance, and the release gate.
- PostgreSQL skips and artifact portable-manifest skips were replaced by
  explicit release prerequisites. The Modal artifact probe
  (`bun packages/provider-modal/test/artifact.release.probe.ts`) requires the
  Linux runtime distribution and checks the versions of the bundled harness binaries.

## Process-spawning unit cases in the Agent Runtime allowlist

The six Agent Runtime entries in the [process-test allowlist](../scripts/ci/process-tests.txt)
contain eight cases that reach a subprocess. Timings are for whole cases from a
focused Linux run using Bun 1.4.2 on main at `62a28af3`, after
`bun scripts/prepare-runtime.ts`.

| File under `packages/agent-runtime/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `exec-env.test.ts` | private exec env authenticates the real core Git helper without model keys, argv credentials or journal token bytes | Locates Git and sends commands through Runner to Bash and the real Git credential helper. | 40.36 ms |
| `exec-env.test.ts` | exec close sanitizes output before replying, recording the process or replaying the command | Runner starts Bash to write synthetic auth state and emit output for redaction. | 5.89 ms |
| `github-bootstrap.test.ts` | actual Boat broker artifact consumes only private stdin and installs credential-free tool files | Bun starts the built broker with a private stdin pipe and checks the local Unix socket. | 56.58 ms |
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
close case replaces `ChildOwner.spawn` with a synthetic child.

### Agent Runtime harness fixture cases

The four files below start local harness fixtures through their production
drivers or SDKs. The direct-syntax process guard does not see these calls.
Timings measure whole cases in a focused Linux run using Bun 1.4.2 at
`42585581`, after `bun scripts/prepare-runtime.ts`.

#### `codex.test.ts`

Process boundary: CodexDriver starts the local `app-server.ts` fixture over JSONL; CodexDriver starts `recorded-resume.ts` for the recorded protocol.

| Case | Local |
| --- | ---: |
| Codex waits for interrupt terminal then sends steer once on the same resumed thread | 27.54 ms |
| Codex usage snapshot includes all native turns restarted by steer within one Armada prompt | 22.90 ms |
| Codex terminal recorded-failure is a typed failure, never successful completion | 21.21 ms |
| Codex terminal unauthorized is a typed failure, never successful completion | 19.82 ms |
| Codex terminal usageLimitExceeded is a typed failure, never successful completion | 20.59 ms |
| Codex terminal output-limit is a typed failure, never successful completion | 20.17 ms |
| Codex reports malformed JSON buffered after a terminal notification | 24.00 ms |
| Codex delivers MCP header and stdio env only through private JSONL, not native argv or global env | 21.73 ms |
| Codex no-text verification resumes the stored thread without creating a thread or starting a turn | 21.59 ms |
| Codex no-text verification rejects a mismatched native thread response | 20.64 ms |
| Codex no-text verification rejects a mismatched native model response | 19.87 ms |
| native account snapshot reported stays private and never blocks the coding turn | 21.44 ms |
| native account snapshot unavailable stays private and never blocks the coding turn | 20.99 ms |
| native renewable writer admission is exclusive only when managed (true) | 45.38 ms |
| native renewable writer admission is exclusive only when managed (false) | 63.33 ms |
| external subscription refresh completes an already-running Codex turn over private RPC | 22.54 ms |
| native usageLimitExceeded preserves only exhausted-window reset evidence in public outcomes (updated, exhausted primary) | 22.51 ms |
| native usageLimitExceeded preserves only exhausted-window reset evidence in public outcomes (updated, invalid reset) | 21.02 ms |
| native usageLimitExceeded preserves only exhausted-window reset evidence in public outcomes (updated, primary below cap) | 20.55 ms |
| native usageLimitExceeded preserves only exhausted-window reset evidence in public outcomes (read fallback) | 19.90 ms |
| native usageLimitExceeded preserves only exhausted-window reset evidence in public outcomes (raced update) | 20.44 ms |
| Codex usage trusts native model metadata (fresh, native selected) | 23.94 ms |
| Codex usage trusts native model metadata (fresh, requested alias) | 23.80 ms |
| Codex usage trusts native model metadata (resumed, requested alias) | 25.36 ms |
| Codex usage trusts native model metadata (missing native model) | 22.38 ms |
| Codex usage trusts native model metadata (current reroute) | 22.17 ms |
| Codex usage trusts native model metadata (foreign reroute) | 24.83 ms |
| Codex resumed baseline before is adopted only before dispatch on the verified thread | 21.94 ms |
| Codex resumed baseline after is adopted only before dispatch on the verified thread | 24.68 ms |
| Codex resumed baseline partial is adopted only before dispatch on the verified thread | 25.16 ms |
| Codex resumed baseline foreign is adopted only before dispatch on the verified thread | 22.57 ms |
| Codex resumed baseline invalid is adopted only before dispatch on the verified thread | 46.08 ms |
| Codex resumed baseline regressed is adopted only before dispatch on the verified thread | 22.36 ms |
| Codex resumed baseline lost-optional is adopted only before dispatch on the verified thread | 22.75 ms |
| Codex resumed baseline late is adopted only before dispatch on the verified thread | 22.09 ms |
| recorded cold Codex resume publishes one unknown snapshot, never historical totals | 19.52 ms |
| cold Codex resume validates persisted history: closed | 24.70 ms |
| cold Codex resume validates persisted history: after-abort | 20.91 ms |
| cold Codex resume validates persisted history: unclosed | 21.59 ms |
| cold Codex resume validates persisted history: wrong-session | 20.68 ms |
| cold Codex resume validates persisted history: corrupt | 20.41 ms |
| Codex journals a terminal rate limit and remains interruptible during backoff | 20.56 ms |
| Codex resumes the same thread after throttling without a real wait | 20.87 ms |
| Codex interrupt during model backoff needs no native interrupt | 21.07 ms |
| Codex steer during model backoff needs no native interrupt | 20.25 ms |
| Codex refuses a steer after its turn closed with a replayable refusal | 21.23 ms |

#### `claude.test.ts`

Process boundary: the pinned Claude SDK starts the local `claude-process.ts` fixture.

| Case | Local |
| --- | ---: |
| Claude SDK consumes native steering and finishes a merged two-input result once | 24.54 ms |
| closing one Claude SDK turn leaves another conversation alive for its own interrupt | 26.31 ms |
| Claude MCP secrets travel only through a private config file and are removed after turn shutdown | 22.84 ms |
| Claude names a turn cut by the model output limit instead of a configuration failure | 20.03 ms |
| Claude names a result-only output-limit terminal with no assistant error frame | 20.63 ms |
| Claude native /usage fallback does not become public assistant text or partials | 22.56 ms |
| a native result acknowledgement ends private usage suppression before subsequent steered work | 24.53 ms |
| Claude resumed=false usage never attributes saved session totals to a new prompt | 22.77 ms |
| Claude resumed=true usage never attributes saved session totals to a new prompt | 22.54 ms |
| Claude native session reset=false during steer keeps only attributable usage | 23.60 ms |
| Claude native session reset=true during steer keeps only attributable usage | 21.11 ms |
| Claude cold resume accounting: saved | 23.98 ms |
| Claude cold resume accounting: missing | 21.31 ms |
| Claude cold resume accounting: corrupt | 20.89 ms |
| Claude cold resume accounting: wrong-session | 21.77 ms |
| Claude cold resume accounting: reset | 22.62 ms |
| Claude cold resume accounting: lost-model | 22.92 ms |
| Claude cold resume accounting: new-model | 23.73 ms |
| Claude cold resume accounting: optional-absent | 24.32 ms |
| Claude cold resume accounting: unrelated-corrupt | 23.02 ms |
| Claude refuses a steer after its stream closed with a replayable refusal | 22.61 ms |

#### `native-resume.test.ts`

Process boundary: the runtime verifies Codex and Claude session continuity through the corresponding local fixture.

| Case | Local |
| --- | ---: |
| private native resume verifies the persisted session without prompt/events and denies absent or cross-harness identities | 30.31 ms |
| Claude native resume initializes the existing session without creating a user turn | 44.77 ms |

#### `driver-rate-limit.test.ts`

Process boundary: the Claude SDK and OpenCode driver start their local fixtures for retry and shutdown scenarios.

| Case | Local |
| --- | ---: |
| claude terminal 429 continues the same turn after a fake-clock backoff | 22.47 ms |
| claude terminal 529 continues the same turn after a fake-clock backoff | 21.86 ms |
| opencode terminal 429 continues the same turn after a fake-clock backoff | 102.00 ms |
| opencode terminal 529 continues the same turn after a fake-clock backoff | 95.96 ms |
| Claude native API retries are reported without starting an Armada backoff | 22.24 ms |
| OpenCode does not reuse a preceding throttle when the resumed process fails before new output | 96.47 ms |
| runner shutdown interrupts a turn waiting in OpenCode model backoff | 53.12 ms |

Five other cases in these files run in process. The Codex process-loss
regression calls the accounting logic directly. Claude's unsafe-home and
unsupported-reasoning cases reject during preflight. The native-resume
serialization and credential lifecycle cases use synthetic drivers.

### Additional Agent Runtime native driver fixture cases

These cases reach real local subprocesses through the harness drivers. The
times are whole-case measurements from a focused Linux run with Bun 1.4.2
at `df880d86`, after `bun scripts/prepare-runtime.ts`.

| File under `packages/agent-runtime/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `opencode.test.ts` | OpenCode refuses stale history and checkpoint after an unacknowledged export | OpenCodeDriver starts the local OpenCode fixture for ACP and session import/export. | 113.51 ms |
| `opencode.test.ts` | OpenCode meters every new native assistant step once, excludes loaded history and normalizes reasoning output | OpenCodeDriver starts the local OpenCode fixture for ACP and session import/export. | 125.16 ms |
| `opencode.test.ts` | OpenCode driver publishes only the new MCP receipt from a follow-up native export | OpenCodeDriver starts the local OpenCode fixture for ACP and session import/export. | 126.24 ms |
| `acp.test.ts` | ACP v1 finish preserves session identity and native usage without replay and sends pinned MCP configuration on load and new | AcpDriver starts Bun running the local ACP fixture over stdio. | 51.60 ms |
| `acp.test.ts` | ACP v1 steer preserves session identity and native usage without replay | AcpDriver starts Bun running the local ACP fixture over stdio. | 51.96 ms |
| `acp.test.ts` | ACP v1 interrupt preserves session identity and native usage without replay | AcpDriver starts Bun running the local ACP fixture over stdio. | 53.00 ms |
| `acp.test.ts` | ACP v1 unknown preserves session identity and native usage without replay | AcpDriver starts Bun running the local ACP fixture over stdio. | 49.49 ms |
| `acp.test.ts` | ACP names a turn cut by the model output limit instead of a configuration failure | AcpDriver starts Bun running the local ACP fixture over stdio. | 25.13 ms |
| `acp.test.ts` | ACP refuses another protocol before dispatching a prompt | AcpDriver starts Bun running the local ACP fixture over stdio. | 25.95 ms |
| `acp.test.ts` | ACP observes native events before prompt and releases the observer when its stream fails | AcpDriver starts Bun running the local ACP fixture over stdio. | 26.35 ms |
| `acp.test.ts` | ACP refuses a steer after its turn stopped with a replayable refusal | AcpDriver starts Bun running the local ACP fixture over stdio. | 25.64 ms |
| `cwd.test.ts` | claude native subprocess/thread cwd is turn-local across parallel conversations, steering and resume | The Claude SDK starts the local Claude fixture in the requested directory. | 123.58 ms |
| `cwd.test.ts` | codex native subprocess/thread cwd is turn-local across parallel conversations, steering and resume | CodexDriver starts the local app-server fixture in the requested directory. | 123.82 ms |

In `opencode.test.ts`, credential translation and proof extraction run in
process, including the assertions on recorded shell proof. The unsupported
reasoning effort case in `acp.test.ts` is rejected before the driver spawns a
child. The private prompt working-directory case in `cwd.test.ts` injects an
in-process driver. The two native working-directory cases run only on Linux.

### Remaining Agent Runtime subprocess cases

An `execve` audit of the 55 Agent Runtime unit files at `82e5a55c` found two
files outside the preceding inventories that start native harness fixtures.
The direct-syntax allowlist misses both because the drivers own the spawn.
The times are whole-case measurements from untraced Linux runs with Bun 1.4.2
after `bun scripts/prepare-runtime.ts`.

| File under `packages/agent-runtime/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `messages.test.ts` | claude correlates deltas and snapshots without merging distinct messages | The Claude SDK starts the local `claude-process.ts` fixture. | 34.81 ms |
| `messages.test.ts` | codex correlates deltas and snapshots without merging distinct messages | CodexDriver starts the local `app-server.ts` fixture. | 30.04 ms |
| `request-receipts.test.ts` | a steer refused while a completed turn awaits auth publication replays its definite status | Runner starts a real CodexDriver backed by the local `app-server.ts` fixture. | 41.79 ms |

The other receipt cases use injected drivers or return before starting a
harness. The workspace tests inject synthetic children.

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
| `security.test.ts` | snapshot quiescence shell is valid and a failed remote scrub prevents success | Runs `bash -n` inside the stubbed SDK exec and supplies a nonzero scrub result. | 4.13 ms | 2.41 ms |

The audit included tracked Modal unit files and their process-capable helpers.
The CLI boundary in `conformance-app.test.ts` injects its command runner, and
the guest process in `runtime-bootstrap.test.ts` is simulated in a VM.
Explicit release, conformance and probe files are outside unit discovery.

## Process-spawning unit cases in CLI

The [process-test allowlist](../scripts/ci/process-tests.txt) identifies four CLI
files by direct spawn syntax. Two additional cases reach a subprocess through
`nativeCodexLogin`. The times below measure whole cases in one focused Linux
run using Bun 1.4.2 on main at `fbcea6e2`.

| File under `packages/cli/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `npm.test.ts` | the launcher runs the platform binary with the arguments and its exit code | Starts the staged npm launcher, which executes a local shell fixture standing in for the platform binary. | 37.06 ms |
| `npm.test.ts` | the launcher names the missing platform package | Starts the staged launcher with the platform package absent. | 27.35 ms |
| `publish.test.ts` | publication waits for each retrievable platform tarball before publishing the launcher (delayed) | Bash runs the publish script against local npm and sleep fixtures. | 26.84 ms |
| `publish.test.ts` | publication waits for each retrievable platform tarball before publishing the launcher (independent-delay) | Bash runs the publish script with separate retry counts in the local npm fixture. | 35.92 ms |
| `publish.test.ts` | each platform starts its registry check without waiting for the other uploads | Starts `mkfifo`, then runs the publish script with local npm fixtures coordinated through the FIFO. | 26.18 ms |
| `publish.test.ts` | publication refuses the launcher when platform tarballs are unavailable | Bash runs the publish script with local npm pack failures and a fake sleep. | 33.14 ms |
| `publish.test.ts` | publication refuses the launcher when platform tarballs are corrupt | Bash runs the publish script with a local npm fixture that returns different bytes. | 14.15 ms |
| `publish.test.ts` | recovery retrieves existing artifacts even when the rebuild differs | Bash runs the publish script with a local npm fixture that reports existing artifacts. | 14.95 ms |
| `publish.test.ts` | dry runs publish every staged tarball without querying registry availability | Bash runs the publish script with a local npm fixture that records dry-run commands. | 15.09 ms |
| `publish.test.ts` | the SDK is published after the launcher | Bash runs the publish script with a local npm fixture that records order. | 23.93 ms |
| `skill-hint.test.ts` | terminal-only skill advice is occasional, silenceable and stops after discovery | Starts `mkfifo` to supply a named pipe in place of the cooldown file. | 11.04 ms |
| `skill-hint.test.ts` | entrypoint prints advice only on a terminal and keeps stdout clean | Python starts the Bun CLI with piped output and a pseudoterminal. | 158.30 ms |
| `skill-hint.test.ts` | unavailable working directory never breaks a completed command, including quiet paths | Starts Bun to remove its own working directory and exercise the hint code. | 8.82 ms |
| `skill-install.test.ts` | public CLI reports a missing Git prerequisite without a login or raw subprocess diagnostics | Starts the Bun CLI with an empty executable search directory. | 66.64 ms |
| `skill-install.test.ts` | CLI fetches one pinned Git source and reports its actual commit and both installed agent roots | Runs Git to set up the fixture and starts the Bun CLI, which fetches the revision from the local repository. | 93.82 ms |
| `native-model-login.test.ts` | native local login returns private auth material but exposes only the approved device challenge | The native login helper starts the local Codex JSONL fixture. | 34.63 ms |
| `native-model-login.test.ts` | cancellation at the device challenge prevents local auth publication | The native login helper starts the same local fixture and cancels it on receipt of the device challenge. | 23.71 ms |

The package manifest case in `npm.test.ts` and the five other skill-install
cases run in process. The browser login tests inject the browser opener, and
the local host tests inject their command runner. `binary.release.ts` is
explicit release validation outside unit discovery.

## Process-spawning unit cases in Docker Host

The process-test allowlist identifies `cli.test.ts` and
`runtime-install.test.ts` by direct spawn syntax. The daemon state test also
spawns on Linux through `fileStore().lock()`. Whole-case timings below come
from focused Linux runs with Bun 1.4.2 on main at `2cbf531e`.

| File under `packages/docker-host/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `cli.test.ts` | Docker host help succeeds without registration, state or Docker access | Starts the Bun CLI for each of eight help invocations, with an unusable home and executable search path. | 183.57 ms |
| `cli.test.ts` | Docker host status identifies an unregistered installation without Docker access | Starts the Bun CLI with an empty temporary home and an unusable executable search path. | 25.17 ms |
| `runtime-install.test.ts` | runtime starter delivers only enrolment on private stdin and detaches runtime output | Runs the bootstrap shell with a local executable fixture that reads stdin through `sha256sum`. | 6.00 ms |
| `daemon.test.ts` | private native state survives reopening, excludes concurrent owners and rejects unsafe existing files | On Linux, the native file store starts `sh` and `flock` for acquisition and contention. The successful lease uses `cat` to hold the lock until stdin closes. | 12.99 ms |

PR #3193 recorded the first three cases in CI at 189.34 ms, 798.25 ms,
and 16.41 ms respectively. PR #3227 replaced the 2,298.20 ms managed-service
CLI case with direct service calls using injected systemd operations. The
other two runtime installer cases use in-process machine and fetch fixtures.
The daemon archive case replaces `Bun.spawn` with a mock.

## Process-spawning unit cases in the Boat adapter

The SSH case in `provider.test.ts` ran on its own on main at `c9bf4fcf`
using local fixtures and Bun 1.4.2.

| File under `packages/provider-boat/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `provider.test.ts` | cleared Boat /run receipt restarts SSH hydration instead of trusting a previous delivery | The SSH helper starts local `ssh-keygen`. The fake provider refuses authorization before an SSH connection is opened. | 15.63 ms |

The matching-receipt case in `provider.test.ts` returns before SSH hydration.
Provider API calls use fake fetch. Explicit conformance and the coordinator probe are outside unit discovery.

## Core subprocess cases

The ten Core entries in the [process-test allowlist](../scripts/ci/process-tests.txt)
identify files by direct spawn syntax. The inventory below follows calls through
test helpers and the SSH executor. Timings are whole cases from focused,
untraced Linux runs of each file. A separate execution trace identified the
process boundaries. The four mount-isolated Claude cases passed untraced,
and their boundaries are documented from the fixture's command and source.

`sandbox-outputs.test.ts` also runs a shell during module load to check for a
protected Bun executable. That check occurs before the cases and is outside
their timings. Focused traces of `private-ssh.test.ts`,
`golden-build-modal.test.ts`, `github.test.ts`, and
`golden-snapshot.test.ts` showed no child executables.

| File under `packages/core/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `docker-machine.test.ts` | Docker machine executor > installs the fixed runtime archive with private modes and numeric workspace ownership | Tar lists and extracts the generated runtime archive. | 5.45 ms |
| `docker-snapshot-build.test.ts` | snapshot builds mount credentials privately, publish automatic ownership labels and recover without rebuilding | Shell checks the generated snapshot verification and syntax-checks scripts. | 17.12 ms |
| `golden-helper.test.ts` | installs the inert pinned executable without sudo; bad bytes never execute | Bash runs the installer and invokes the inert helper fixture. | 36.75 ms |
| `golden-script-shell.test.ts` | real shell: the baseline tolerates a repo with no package.json, pins across repos, and installs claude/codex when missing | Bash runs the generated baseline with local tool installation fixtures. | 19.35 ms |
| `golden-script-shell.test.ts` | real shell: Boat absolute Claude pin (2.1.319, installer yields 2.1.322, success=true) | Sudo opens a mount namespace and Bash runs the pinned install with local npm and Claude fixtures. | 18.96 ms |
| `golden-script-shell.test.ts` | real shell: Boat absolute Claude pin (2.1.322, installer yields 2.1.322, success=true) | Sudo opens a mount namespace and Bash runs the pinned install with local npm and Claude fixtures. | 13.60 ms |
| `golden-script-shell.test.ts` | real shell: Boat absolute Claude pin (2.1.323, installer yields 2.1.322, success=true) | Sudo opens a mount namespace and Bash runs the pinned install with local npm and Claude fixtures. | 14.89 ms |
| `golden-script-shell.test.ts` | real shell: Boat absolute Claude pin (2.1.319, installer yields 2.1.319, success=false) | Sudo opens a mount namespace and Bash runs the pinned install with local npm and Claude fixtures. | 14.57 ms |
| `golden-script-shell.test.ts` | real shell: cleanup removes only the exact Armada key line and preserves unrelated ones | Bash runs the generated authorized_keys cleanup. | 5.41 ms |
| `golden-script-shell.test.ts` | real shell: cleanup removes the file's only line without error | Bash runs the generated authorized_keys cleanup. | 5.09 ms |
| `golden-script-shell.test.ts` | real shell: a genuine cleanup failure fails closed and never overwrites authorized_keys | Bash runs the generated authorized_keys cleanup. | 5.49 ms |
| `golden-script-shell.test.ts` | real shell: pinned Bun replaces an image binary in a non-writable PATH directory | Bash runs the pinned install with fixture npm, then a fresh shell resolves Bun. | 16.48 ms |
| `golden-script-shell.test.ts` | checkout credential protocol tolerates challenge metadata without widening host access ("protocol=https\nhost=github.com\nwwwauth[]=Basic realm=GitHub\n\n") | Bash runs the checkout and a shell invokes the inline credential helper. | 4.73 ms |
| `golden-script-shell.test.ts` | checkout credential protocol tolerates challenge metadata without widening host access ("protocol=https\nhost=github.com:443\nusername=git\ncapability[]=authtype\n\n") | Bash runs the checkout and a shell invokes the inline credential helper. | 4.16 ms |
| `golden-script-shell.test.ts` | checkout credential protocol tolerates challenge metadata without widening host access ("protocol=https\nhost=other.example\nwwwauth[]=Basic realm=GitHub\n\n") | Bash runs the checkout and a shell invokes the inline credential helper. | 2.62 ms |
| `golden-script-shell.test.ts` | checkout credential protocol tolerates challenge metadata without widening host access ("protocol=http\nhost=github.com\n\n") | Bash runs the checkout and a shell invokes the inline credential helper. | 2.69 ms |
| `golden-script-shell.test.ts` | checkout credential protocol tolerates challenge metadata without widening host access ("protocol=https\nwwwauth[]=Basic realm=GitHub\n\n") | Bash runs the checkout and a shell invokes the inline credential helper. | 2.73 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: Authentication failed for https://opaque@example/) | Bash runs generated checkout with a fixture Git function. | 2.12 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: Repository not found. opaque) | Bash runs generated checkout with a fixture Git function. | 1.72 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: Remote branch missing not found in upstream origin opaque) | Bash runs generated checkout with a fixture Git function. | 1.80 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: unable to access opaque: Could not resolve host) | Bash runs generated checkout with a fixture Git function. | 1.92 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: git-lfs opaque error) | Bash runs generated checkout with a fixture Git function. | 1.85 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: destination path opaque already exists and is not an empty directory.) | Bash runs generated checkout with a fixture Git function. | 1.80 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: opaque: No space left on device) | Bash runs generated checkout with a fixture Git function. | 1.79 ms |
| `golden-script-shell.test.ts` | clone stderr is reduced to a closed category (fatal: arbitrary-opaque-error) | Bash runs generated checkout with a fixture Git function. | 1.83 ms |
| `golden-script-shell.test.ts` | clone diagnostics finish in repository order and an empty failed checkout gets its own unknown reason | Bash runs generated checkout with a fixture Git function. | 2.53 ms |
| `golden-script-shell.test.ts` | per-repository history overrides checkout default without changing other repositories (shallowDefault=false) | Bash runs generated checkout with a fixture Git function. | 3.19 ms |
| `golden-script-shell.test.ts` | per-repository history overrides checkout default without changing other repositories (shallowDefault=true) | Bash runs generated checkout with a fixture Git function. | 3.07 ms |
| `golden-script-shell.test.ts` | the golden build provisions its own collector Bun and requires the probe answer: the managed collector answers | Bash runs the emitted collector provisioning and probe with a Bun fixture. | 16.48 ms |
| `golden-script-shell.test.ts` | the golden build provisions its own collector Bun and requires the probe answer: the image already ships the managed Bun | Bash runs the emitted collector provisioning and probe with a Bun fixture. | 7.47 ms |
| `golden-script-shell.test.ts` | the golden build provisions its own collector Bun and requires the probe answer: an incompatible Bun exits 0 without answering | Bash runs the emitted collector provisioning and probe with a Bun fixture. | 14.15 ms |
| `golden-skillpack.test.ts` | golden Skillpack provisioning offline | Bash runs the bootstrap with a local curl fixture. | 7.57 ms |
| `golden-skillpack.test.ts` | golden Skillpack provisioning corrupt | Bash runs the bootstrap with a local curl fixture. | 7.52 ms |
| `launch.test.ts` | launch > unstartable codex fails idle and prompted launch before publication | Shell runs the admission command against a local failing harness fixture. | 5.05 ms |
| `launch.test.ts` | launch > unstartable claude fails idle and prompted launch before publication | Shell runs the admission command against a local failing harness fixture. | 3.24 ms |
| `launch.test.ts` | claude launch artifacts stay out of worker Git staging without changing tracked skills | Local Git checks staging and the generated exclude script runs in a shell. | 14.11 ms |
| `launch.test.ts` | codex launch artifacts stay out of worker Git staging without changing tracked skills | Local Git checks staging and the generated exclude script runs in a shell. | 12.24 ms |
| `launch.test.ts` | generated refresh never merges after a failed fetch and preserves its completed failure marker | Bash runs generated refresh with a fixture Git command. | 1.87 ms |
| `launch.test.ts` | generated refresh uses the installed caller helper without writing its token to commands or config | Bash runs generated refresh with a fixture Git command. | 3.38 ms |
| `sandbox-outputs.test.ts` | the Python-free collector bounds admitted files in name order | Shell runs the generated collector or probe against a local Bun executable or fixture. | 245.19 ms |
| `sandbox-outputs.test.ts` | the collector isolates its working directory and environment | Shell runs the generated collector or probe against a local Bun executable or fixture. | 16.77 ms |
| `sandbox-outputs.test.ts` | the real collector refuses a symlink in a parent of the declared directory | Shell runs the generated collector or probe against a local Bun executable or fixture. | 13.54 ms |
| `sandbox-outputs.test.ts` | the capability probe refuses a Bun that exits 0 without running the collector | Shell runs the generated collector or probe against a local Bun executable or fixture. | 15.04 ms |
| `sandbox-outputs.test.ts` | probe and read fall back to Python when Bun cannot access descriptors | Shell runs the collector probe or read with Python fallback. | 58.10 ms |
| `sandbox-outputs.test.ts` | a sandbox from a pre-upgrade golden (no managed Bun, an old pinned Bun, Python 3) still collects | Shell runs the collector probe or read with Python fallback. | 36.70 ms |
| `sandbox-outputs.test.ts` | the Python fallback keeps the Bun reader's bounds, exclusions and exit codes | Shell runs the collector probe or read with Python fallback. | 250.93 ms |
| `sandbox-outputs.test.ts` | privileged exec without the managed Bun refuses agent-replaceable readers | Shell probes the collector and checks ownership with stat. | 3.47 ms |
| `sandbox-outputs.test.ts` | the managed reader accepts only a root-owned, non-writable chain without symlinks | Shell runs the emitted path check with stat. | 8.88 ms |
| `sandbox-outputs.test.ts` | a privileged exec collects through a protected managed Bun | Shell runs the generated collector or probe against a local Bun executable or fixture. | 25.56 ms |
| `sandbox-outputs.test.ts` | the cloud collector refuses a chunk from a replaced revision | Shell runs the generated collector or probe against a local Bun executable or fixture. | 44.44 ms |
| `ssh-executor.test.ts` | the argv-joined remote shell preserves stdin and trusted undefined home | Bash executes the joined SSH command or quoted value locally. | 5.87 ms |
| `ssh-executor.test.ts` | the argv-joined remote shell preserves stdin and trusted user home | Bash executes the joined SSH command or quoted value locally. | 4.45 ms |
| `ssh-executor.test.ts` | the argv-joined remote shell preserves stdin and trusted root home | Bash executes the joined SSH command or quoted value locally. | 4.18 ms |
| `ssh-executor.test.ts` | shellQuote round-trips a value containing single quotes through a real shell | Bash executes the joined SSH command or quoted value locally. | 1.32 ms |
| `ssh-executor.test.ts` | real SSH remote shell reports only allowlisted phase and exit code (checkout) | SSH executor starts ssh-keygen, then Bash runs the generated guest command. | 17.74 ms |
| `ssh-executor.test.ts` | real SSH remote shell reports only allowlisted phase and exit code (explicit-init-exit) | SSH executor starts ssh-keygen, then Bash runs the generated guest command. | 16.44 ms |
| `ssh-executor.test.ts` | refuses invalid SSH username metadata admin before SSH | SSH executor starts real ssh-keygen, then refuses the SSH destination. | 5.05 ms |
| `ssh-executor.test.ts` | refuses invalid SSH username metadata root; touch /tmp/forged before SSH | SSH executor starts real ssh-keygen, then refuses the SSH destination. | 4.22 ms |
| `ssh-executor.test.ts` | refuses invalid SSH username metadata (empty string) before SSH | SSH executor starts real ssh-keygen, then refuses the SSH destination. | 4.46 ms |
| `ssh-executor.test.ts` | refuses invalid SSH username metadata null before SSH | SSH executor starts real ssh-keygen, then refuses the SSH destination. | 4.04 ms |
| `ssh-github-token.test.ts` | git overrides stale auth but preserves inherited auth when ephemeral state is missing or expired | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 57.22 ms |
| `ssh-github-token.test.ts` | git refuses insecure state instead of downgrading to inherited credentials | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 57.71 ms |
| `ssh-github-token.test.ts` | gh overrides stale auth but preserves inherited auth when ephemeral state is missing or expired | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 60.96 ms |
| `ssh-github-token.test.ts` | gh refuses insecure state instead of downgrading to inherited credentials | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 59.39 ms |
| `ssh-github-token.test.ts` | Git helper emits only the freshest available GitHub credential on the credential protocol | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 57.97 ms |
| `ssh-github-token.test.ts` | installer refuses symlink and non-root-owned code paths before replacing any executable | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 64.00 ms |
| `ssh-github-token.test.ts` | installer waits through transient lock contention but fails at its deadline before credential or executable writes | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 62.47 ms |
| `ssh-github-token.test.ts` | installer reports the failed directory check or atomic install as a closed phase | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 63.88 ms |
| `ssh-github-token.test.ts` | bootstrap relays an exact installer phase and maps all other child stderr to sudo | Local Python executes the emitted GitHub client, installer, or bootstrap with fixture dependencies. | 58.35 ms |
| `ssh-readable-variables.test.ts` | Boat fixed bootstrap successfully restores the same readable file after /run loss | Local Python executes the emitted bootstrap and installer with fixture filesystem paths. | 122.09 ms |

## Server subprocess cases

The [process-test allowlist](../scripts/ci/process-tests.txt) finds
Server files with direct spawn syntax. The push-ledger fixture and the SSH
executor also start real processes from tests outside the allowlist. The
table records whole-case timings from untraced Linux runs with Bun 1.4.2
(744846f84). The control and GitHub broker cases ran at `f9e67913` and
`4718766a`, respectively. The remaining cases ran in per-file invocations
at `c8f81db1`. Separate execution traces and source
inspection identify process boundaries.

| File under `packages/mcp-server/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `docker-host-install.test.ts` | installer publishes both build digests without credentials and refuses missing artifacts | POSIX sh checks the generated installer syntax. Route requests are in process. | 3.35 ms |
| `docker-host-install.test.ts` | one-line installer verifies bytes, delivers the one-use token privately and confirms a poll | POSIX sh runs the installer with local command and artifact stubs for download, service, registration, and package runners. | 125.71 ms |
| `main.test.ts` | standalone server entrypoint reports configuration errors without starting the CLI | A fresh Bun process runs the standalone server entrypoint and rejects missing configuration. | 459.24 ms |
| `managed-inspection.test.ts` | native argv sentinel inspection excludes its exec command and ancestors, but catches an actual native-looking child leak | A local Node wrapper invokes Bash to install the sentinel and inspect Linux procfs while fixture Node CLI processes supply argv. | 301.53 ms |
| `orchestrator-bootstrap.test.ts` | built-in reference preserves conflicting files | An injected provider exec runs the built-in reference script in POSIX sh against temporary files. | 9.61 ms |
| `serve-database-boot.test.ts` | startServer retries real Supavisor admission errors before serving and closes both pools on exhaustion | A fresh Bun fixture isolates the SQL and clock doubles and makes loopback HTTP requests against the composed server. | 701.26 ms |
| `push-ledger.test.ts` | push evidence survives a pruned tracking ref and reports pushes that escaped the ledger | The helper runs POSIX sh and local Git to push, prune, and detect a push without ledger hooks. | 204.57 ms |
| `push-ledger.test.ts` | a missing reference-transaction hook is reported, kept in the ledger and restored | POSIX sh and local Git push, remove the reference-transaction hook, and exercise ledger repair. | 113.01 ms |
| `push-ledger.test.ts` | a missing pre-push hook is reported, kept in the ledger and restored | POSIX sh and local Git push, remove the pre-push hook, and exercise ledger repair. | 114.75 ms |
| `push-ledger.test.ts` | a push the ledger cannot attribute leaves a gap even after its tracking ref is pruned | POSIX sh and local Git exercise alternate push paths and inspect the ledger after tracking-ref pruning. | 460.51 ms |
| `push-ledger.test.ts` | the repository's own hooks keep running, with their input and exit status, beside the ledger | POSIX sh and local Git install and exercise existing repository hooks alongside the ledger. | 215.14 ms |
| `push-ledger.test.ts` | recreating a deleted branch at the SHA its tracking ref still holds is recorded | POSIX sh and local Git use two clones to recreate a deleted branch at its previous SHA. | 110.57 ms |
| `push-ledger.test.ts` | a push the remote rejects is an unconfirmed attempt, never push evidence | POSIX sh and local Git exercise a push rejected by a local remote hook and inspect the pending and aged ledger records. | 123.66 ms |
| `push-ledger.test.ts` | confirmed pushes keep their chronological order across both evidence sources | POSIX sh and local Git push and recreate a branch from a newer fetched commit to check ordering. | 160.10 ms |
| `push-ledger.test.ts` | a verified push is confirmed by its tracking update even without a reflog entry | POSIX sh and local Git disable reflogs, push, prune, and read the tracking-update evidence. | 97.46 ms |
| `push-ledger.test.ts` | an accepted push whose tracking update failed stays unresolved; a later confirmed push supersedes it | POSIX sh and local Git exercise a locked tracking ref and competing pushes across local clones. | 359.84 ms |
| `push-ledger.test.ts` | a relative hooks path still resolves in each linked worktree once the ledger is installed | POSIX sh and local Git exercise distinct hook behavior in the primary and linked worktrees. | 59.20 ms |

The unattributed-push gap case took 1,631.84 ms in the
[archived unit shard](https://github.com/The-Vibe-Company/armada/actions/runs/44526380196/job/135567940848#logs).
It sets up four local launch fixtures and exercises four push paths in one case.

The other
`orchestrator-bootstrap.test.ts` cases inject the provider result or reject
the request before execution. The Boat provider composition test injects its
SSH spawn function. Explicit conformance and release probes are outside unit
discovery.

## Repository-script subprocess cases

The [process-test allowlist](../scripts/ci/process-tests.txt) selects files by
spawn syntax. The inventory covers 373 cases across 13 files and follows helper calls,
including the post-deploy preservation bundle verifier. Linux timings use Bun 1.4.2
(744846f84) at `f9bf5dd6`, with the sandbox-access row remeasured after the
fixture change described below. Each timing is for one case in an untraced
per-file run, excluding shared hooks. Separate `execve` traces identify
subprocess boundaries. Provider, deployment and publishing commands use
offline fixtures.

The audit traced helper callers in the local-port, changed-workspace,
artifact publishing, model-price, architecture-counter, migration-renumbering,
release publication, receipt, rollback, agents, docs, ratchet, table-owner and
unit-shard tests. Those cases either inject command results or exercise pure
helpers. They started no child processes.

### `scripts/build.test.ts`

Bun runs the build entrypoint with compilation and preparation spawns stubbed.

| Case | Local (ms) |
| --- | ---: |
| `build batch {"args":[],"compilations":2}` | 12.04 |
| `build batch {"args":["--target","linux-arm64"],"compilations":2}` | 9.12 |
| `build batch {"args":["--all"],"compilations":8}` | 9.37 |
| `build batch {"args":["--target","bad"],"compilations":0,"failure":true}` | 8.44 |
| `build batch {"args":["--all","--target","bad"],"compilations":0,"failure":true}` | 9.29 |
| `build batch {"args":["--all"],"compilations":0,"failure":true,"failAt":0}` | 8.11 |
| `build batch {"args":["--all"],"compilations":2,"failure":true,"failAt":2}` | 8.57 |

### `scripts/check-boat-runtime.test.ts`

Bun runs the coordinator entrypoint with an injected HTTP transport and clock.

The parameterized case name is `one-launch coordinator check is fail-closed (<case>)`.

| Case | Local (ms) |
| --- | ---: |
| `success` | 16.26 |
| `ordinary` | 10.56 |
| `ordinary-idle` | 11.06 |
| `ordinary-claude-resume` | 11.55 |
| `ordinary-native-default` | 10.51 |
| `ordinary-unknown-default` | 10.12 |
| `ordinary-native-receipt` | 11.50 |
| `ordinary-wrong-source` | 12.32 |
| `idle` | 10.88 |
| `idle-resume` | 10.83 |
| `idle-not-ready` | 12.00 |
| `idle-conversation` | 11.84 |
| `idle-lost-send` | 12.76 |
| `disabled` | 10.23 |
| `wrong-source` | 12.46 |
| `runtime-failed` | 13.37 |
| `old-diagnostics` | 10.75 |
| `followup` | 10.05 |
| `old-followup` | 9.72 |
| `followup-lost` | 12.01 |
| `checkpoint` | 10.35 |
| `old-checkpoint` | 9.90 |
| `bad-checkpoint` | 11.96 |
| `checkpoint-lost` | 12.54 |
| `resume` | 12.08 |
| `old-resume` | 10.11 |
| `resume-lost` | 12.33 |
| `bad-resume` | 12.88 |
| `github` | 10.54 |
| `old-github` | 10.45 |
| `github-preflight-denied` | 10.33 |
| `github-no-tool` | 12.25 |
| `github-no-audit` | 13.81 |
| `github-resume` | 11.89 |
| `github-resume-no-tool` | 12.66 |
| `github-resume-no-audit` | 13.31 |
| `github-resume-stale-status` | 12.80 |
| `github-resume-lost-refresh` | 14.11 |
| `github-resume-lost-history` | 16.43 |
| `mcp` | 11.26 |
| `mcp-resume` | 11.21 |
| `old-mcp` | 9.72 |
| `mcp-preflight-denied` | 9.49 |
| `mcp-invalid-json` | 10.48 |
| `mcp-no-default` | 9.83 |
| `mcp-wrong-server` | 11.84 |
| `mcp-wrong-args` | 11.90 |
| `mcp-no-result` | 12.77 |
| `mcp-resume-no-tool` | 13.18 |
| `mcp-github-resume` | 12.95 |
| `mcp-skills-resume` | 13.24 |
| `skills` | 10.96 |
| `skills-empty` | 11.38 |
| `skills-status` | 11.92 |
| `skills-golden` | 11.62 |
| `skills-resume` | 10.69 |
| `claude-resume` | 10.69 |
| `invalid-harness` | 7.99 |
| `usage` | 11.02 |
| `usage-resume` | 11.90 |
| `usage-unknown` | 10.53 |
| `usage-no-admission` | 11.77 |
| `usage-wrong-counters` | 12.07 |
| `usage-resume-repriced` | 13.09 |
| `usage-no-event` | 14.09 |
| `workspace` | 10.36 |
| `workspace-resume` | 10.65 |
| `workspace-missing` | 11.57 |
| `workspace-late` | 12.73 |
| `workspace-resume-rerun` | 12.79 |
| `old-workspace` | 9.67 |

### `scripts/db/check-migrations.test.ts`

Local Git builds a temporary migration history and Bun runs the migration CLI against it.

| Case | Local (ms) |
| --- | ---: |
| `migration CLI rejects collisions, placeholder versions and non-increasing additions against the current base` | 371.08 |

### `scripts/golden-runtime-smoke.test.ts`

Bash runs the guest probe against a local executable or a download stub.

| Case | Local (ms) |
| --- | ---: |
| `helper probe accepts the pinned executable and rejects changed bytes without emitting guest output` | 9.51 |
| `Skillpack probe rejects an untrusted archive before extraction and removes temporary downloads` | 6.58 |

### `scripts/post-deploy-smoke.test.ts`

The preservation suite creates one local bundle in shared setup using six Git
commands. An isolated run of a case that stops before bundle verification took
56 ms end to end, including Bun startup and that setup. The table marks cases
that also start local Git in the bundle verifier. The workflow case runs the
workflow shell step with a stub Bun executable.

| Case | Local (ms) | Git in verifier |
| --- | ---: | --- |
| `wrong_handle_owner` | 8.24 | Yes |
| `none` | 6.38 | Yes |
| `default_policy` | 8.38 | Yes |
| `default_empty` | 6.95 | Yes |
| `default_wrong_receipt` | 6.17 | Yes |
| `default_opt_out_ignored` | 0.54 | No |
| `default_wrong_golden` | 0.25 | No |
| `scoped_pair` | 10.43 | Yes |
| `scoped_unsupported` | 9.62 | Yes |
| `missing` | 0.49 | No |
| `wrong` | 0.52 | No |
| `corrupt` | 0.35 | No |
| `corrupt_pack` | 4.15 | Yes |
| `clean_note` | 6.78 | Yes |
| `clean_archive` | 6.36 | Yes |
| `overwritten` | 0.54 | No |
| `explicit_missing` | 6.44 | Yes |
| `selector_ignored` | 6.17 | Yes |
| `recovery_changes` | 6.22 | Yes |
| `recovery_wakes` | 6.08 | Yes |
| `recovery_note_changes` | 5.91 | Yes |
| `the advertised smoke workflow invocation admits ordinary staging checks` | 4.83 | No |

### `scripts/release/configuration.test.ts`

Bash runs release preflight or the publish verification step against local fixtures.

| Case | Local (ms) |
| --- | ---: |
| `release preflight lists all missing names once without disclosing any configuration values` | 3.20 |
| `staging requires its smoke token, cases and origin in addition to common deployment configuration` | 1.28 |
| `complete release configuration succeeds silently for each environment` | 3.72 |
| `release preflight rejects an unsupported environment before credentials or external commands` | 1.11 |
| `the production consumer rechecks its configuration in its actual first step` | 3.28 |
| `npm verifies tarballs before publish (intact)` | 18.42 |
| `npm verifies tarballs before publish (tampered)` | 15.84 |
| `npm verifies tarballs before publish (incomplete artifact)` | 16.66 |

### `scripts/release/deploy-production.test.ts`

Local Git prepares source archives and Bash runs the release entrypoint.
Provider executables and sleeps are stubbed. The production-ordering cases
synchronize through a local FIFO.

| Case | Local (ms) |
| --- | ---: |
| `release uploads and gates providers in migration/server/health/dashboard order` | 124.23 |
| `production builds while Railway is pending and publishes only after exact health` | 321.48 |
| `staging retries a transient list-failed Railway deployment list and completes` | 129.91 |
| `production retries a transient list-failed Railway deployment list and completes` | 128.69 |
| `staging retries a transient list-unparseable Railway deployment list and completes` | 145.39 |
| `migrations failure stops later release stages` | 55.00 |
| `server failure stops later release stages` | 115.70 |
| `health failure stops later release stages` | 195.25 |
| `wrong-commit failure stops later release stages` | 191.23 |
| `dashboard-pull failure stops later release stages` | 123.63 |
| `dashboard-build failure stops later release stages` | 123.14 |
| `dashboard-deploy failure stops later release stages` | 125.00 |
| `missing VERCEL_TOKEN fails before any deployment mutation` | 11.29 |
| `missing RAILWAY_TOKEN fails before any deployment mutation` | 10.73 |
| `missing RAILWAY_SERVICE_ID fails before any deployment mutation` | 11.69 |
| `current source only supersedes ordinary queued main deployments` | 126.60 |
| `stale source only supersedes ordinary queued main deployments` | 16.81 |
| `pinned source only supersedes ordinary queued main deployments` | 121.80 |
| `unresolved source only supersedes ordinary queued main deployments` | 15.51 |
| `deployment carries only a matching generated official-image pin into the source archive` | 228.24 |

### `scripts/routines-staging.test.ts`

Python runs the offline routine runner unit suite with injected HTTP, including
the public sandbox deletion path, bearer header and organization query.

| Case | Local (ms) |
| --- | ---: |
| `routine staging script validates proof, cleanup and credential-safe HTTP` | 280.98 |

### `scripts/sandbox-access/staging-check.test.ts`

Python runs the offline sandbox-access unit suite, including the public status
and stop request paths, headers and JSON bodies. On the baseline, this
wrapper took 1,080.77 ms. Profiling attributed 900 ms to 47 default CA store
loads, although the tests substitute the HTTP transport. The fixture now skips
loading the host trust store while keeping the real TLS context and redirect
handler.

| Case | Local (ms) |
| --- | ---: |
| `sandbox staging runner's offline safety contracts` | 139.27 |

### `scripts/smoke-docker-lifecycle.test.ts`

Python runs the Docker smoke entrypoint against stubbed transport and SSH, or
rejects an invalid snapshot invocation during argument validation.

The parameterized case name is `normal Docker smoke uses normal routes (<case>)`.

| Case | Local (ms) |
| --- | ---: |
| `launch` | 79.50 |
| `resume` | 75.38 |
| `cost` | 76.66 |
| `bad-cost` | 76.09 |
| `claude` | 79.41 |
| `opencode` | 77.99 |
| `repository` | 77.70 |
| `repository-no-proof` | 75.93 |
| `github` | 75.67 |
| `github-no-proof` | 80.41 |
| `github-no-broker` | 80.95 |
| `variable` | 78.63 |
| `variable-mcp` | 76.05 |
| `variable-no-proof` | 75.57 |
| `variable-whitespace` | 75.73 |
| `secret` | 80.01 |
| `secret-mcp` | 77.91 |
| `secret-no-proof` | 78.43 |
| `secret-wrong-digest` | 79.51 |
| `snapshot` | 77.33 |
| `snapshot-no-init` | 78.31 |
| `snapshot-wrong-version` | 77.49 |
| `snapshot-build-failed` | 76.40 |
| `snapshot smoke refuses repository overrides before config or host work` | 72.39 |

### `scripts/testflight/testflight.test.ts`

Bash runs the TestFlight entrypoint with fixture platform tools. The signing
case uses local OpenSSL and also runs the cleanup entrypoint.

| Case | Local (ms) |
| --- | ---: |
| `signs with the distribution identity, uploads and distributes without exposing keys` | 54.41 |
| `refuses a build number that could collide with the hand-uploaded builds` | 3.60 |

## Evidence owed after merge

Run the existing publishing release validation on the exact release SHA. Verify
routed Bun suites print executed testcase counts with zero skips, the native
Codex and Modal artifact probes report success, and native version validation
and checkpoint process boundaries pass. No production action or
Boat lifecycle is required for this test-routing change. OS/container checks
remain separately opt-in, not an implied pass from green unit CI.
