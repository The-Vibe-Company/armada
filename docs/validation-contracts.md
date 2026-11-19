# Validation contract routing (#2369)

Root cause: default Bun filename discovery treated opt-in provider, native and
PostgreSQL proof as ordinary green unit coverage even when prerequisites were absent.
A skipped declaration is not evidence of its contract.

## Explicit release owners

The existing publishing release `check` job owns a disposable PostgreSQL service
and native build. It runs `scripts/validate-release-contracts.py` after migrations.
Every selected file must report at least one testcase and zero skips/errors/failures.
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
| provider-modal/artifact | built native artifact bootstrap, checkpoint, journal reopening |
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
- `provider-boat/integration.coordinator.ts` is no longer automatically
  discovered at all. Only the coordinator may explicitly invoke its documented
  billed-compute opt-in command. It is not part of release/staging acceptance:
  `boat: not part of the release gate`.
- PostgreSQL skips and artifact portable-manifest skips were replaced by
  explicit release prerequisites. The native `mcp-codex-bridge` release
  probe (`packages/mcp-server/test/mcp-codex-bridge.release.probe.ts`) requires
  the pinned binary and a successful process exit.

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

## Evidence owed after merge

Run the existing publishing release validation on the exact release SHA. Verify
routed Bun suites print executed testcase counts with zero skips, the native
Codex probe reports success, and native version
validation and checkpoint process boundaries pass. No production action or
Boat lifecycle is required for this test-routing change. OS/container checks
remain separately opt-in, not an implied pass from green unit CI.
