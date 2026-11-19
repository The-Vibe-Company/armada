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

The [process-test allowlist](../scripts/ci/process-tests.txt) identifies four
Boat adapter files by direct subprocess syntax. One additional case in
`provider.test.ts` starts a local binary through the SSH helper. Timings
measure whole cases in focused Linux runs with Bun 1.4.2. The four allowlisted
files ran together on main at `7dc693ad`. The SSH case ran on its own with
main at `c9bf4fcf`. Both runs used local fixtures.

| File under `packages/provider-boat/test` | Case | Local subprocess boundary | Local |
| --- | --- | --- | ---: |
| `native-claude-mcp.test.ts` | ordinary Claude needs no Python bridge and managed installation refuses a missing interpreter before mutation | Bash runs the ordinary wrapper and the managed installer with Python absent from PATH. | 5.79 ms |
| `native-claude-mcp.test.ts` | Claude refresh ACK gates turns, removes tools and preserves the process/session and internal MCP | Bash starts the managed Python bridge with a local Claude stream-JSON peer. | 108.85 ms |
| `native-cwd.test.ts` | installs the codex VM wrapper and preserves dynamic argv without recursion | Bash runs the Linux installer with a local sudo shim, then the wrapper launches a shell peer. | 59.92 ms |
| `native-cwd.test.ts` | installs the claude VM wrapper and preserves dynamic argv without recursion | Bash runs the Linux installer with a local sudo shim, then the wrapper launches a shell peer. | 36.38 ms |
| `native-cwd.test.ts` | Codex wrapper enforces Boat's thread/turn protocol cwd, not only process cwd | Bash runs the relocated installer on Linux. The installed wrapper and a local Codex peer exercise transport refusal and stdio. | 361.22 ms |
| `native-cwd.test.ts` | generic GitHub preparation preserves the managed Claude MCP bridge and rejects a tampered wrapper | Bash runs both Linux installer variants. The installed wrapper starts the managed Python bridge and a local Claude peer. | 123.53 ms |
| `native-cwd.test.ts` | Codex bridge refuses a second message until the first turn/start replies, then recovers | The installed wrapper starts the Python bridge and a local Codex peer over stdio after Linux shell setup. | 95.99 ms |
| `native-cwd.test.ts` | Codex lone startup abort returns readable relaunch guidance on the pending RPC | After Linux shell setup, the installed wrapper starts a local Codex peer that aborts by signal. | 83.05 ms |
| `native-cwd.test.ts` | Codex lone startup exit returns readable relaunch guidance on the pending RPC | After Linux shell setup, the installed wrapper starts a local Codex peer that exits nonzero. | 90.81 ms |
| `native-cwd.test.ts` | Codex boot abort before initialize still answers the later first request | After Linux shell setup, the installed wrapper starts a local Codex peer that aborts before reading stdin. | 86.15 ms |
| `native-cwd.test.ts` | Boat-framed Codex input reaches admitted native usage through the real bridge | A stubbed guest exec runs usage commands in a local shell. Python drives the wrapper and a local Codex peer. | 179.37 ms |
| `native-cwd.test.ts` | Boat external subscription bridge consumes refresh RPC privately and completes the same native turn | OpenSSL creates a temporary certificate. The wrapper starts a local Codex peer and the bridge calls a loopback HTTPS fixture. | 332.25 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (updated, true) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 77.39 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (updated, false) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 72.78 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (read, true) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 70.69 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (read, false) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 71.01 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (raced, true) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 69.96 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (raced, false) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 74.88 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (unauthorized, true) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 75.26 ms |
| `native-cwd.test.ts` | Boat plan exhaustion reaches a public outcome with only validated reset evidence (unknown, true) | Bash starts the Python bridge and a local Codex peer that emits the fixture error. | 73.14 ms |
| `native-usage.test.ts` | multi-turn Codex cumulative counters yield deltas, retries do not add | Python executes the embedded guest usage code with temporary state. | 28.51 ms |
| `native-usage.test.ts` | a valid stale flush is never frozen at admission or attributed to the next turn | Python executes the embedded guest usage code with temporary state. | 28.02 ms |
| `native-usage.test.ts` | missing resume baseline, symlink, mismatched session identity fail closed | Python executes the embedded guest usage code with temporary state. | 27.39 ms |
| `native-usage.test.ts` | an interrupted native turn leaves counters unknown without poisoning later closed turns | Python executes the embedded guest usage code with temporary state. | 29.39 ms |
| `native-usage.test.ts` | Claude cumulative files without a proven native boundary remain unknown | Python executes the embedded guest usage code with temporary state. | 26.53 ms |
| `native-usage.test.ts` | expired and rejected admissions recover without letting late callbacks claim newer prompts | Python executes the embedded guest usage code with temporary state. | 28.72 ms |
| `native-usage.test.ts` | wire codec rejects ambiguous context and legacy admissions without losing safe recovery | Python executes the embedded guest usage code with temporary state. | 27.50 ms |
| `native-usage.test.ts` | a warm legacy bridge cannot consume a new admission whose raw text aliases an old envelope | Python executes the embedded guest usage code with temporary state. | 26.25 ms |
| `native-usage.test.ts` | collection explains the failed stage without exposing raw state or changing counters | Python executes the embedded guest usage code with temporary state. | 26.19 ms |
| `native-usage.test.ts` | identical ambiguous inputs stay unknown while later distinct admissions and fresh forks recover | Python executes the embedded guest usage code with temporary state. | 25.67 ms |
| `usage-probe.test.ts` | diagnostic probe exports only metadata and does not mutate guest state | Python runs the guest metadata probe against temporary state. | 20.95 ms |
| `provider.test.ts` | cleared Boat /run receipt restarts SSH hydration instead of trusting a previous delivery | The SSH helper starts local `ssh-keygen`. The fake provider refuses authorization before an SSH connection is opened. | 15.63 ms |

The native reader transport-error case in `native-usage.test.ts` injects the
exec response in process. The matching-receipt case in `provider.test.ts`
returns before SSH hydration. Provider API calls use fake fetch. Explicit
conformance and the coordinator probe are outside unit discovery.

## Evidence owed after merge

Run the existing publishing release validation on the exact release SHA. Verify
routed Bun suites print executed testcase counts with zero skips, the native
Codex and Modal artifact probes report success, and native version validation
and checkpoint process boundaries pass. No production action or
Boat lifecycle is required for this test-routing change. OS/container checks
remain separately opt-in, not an implied pass from green unit CI.
