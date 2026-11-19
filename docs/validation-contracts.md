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
  the pinned binary and a successful process exit.

## Evidence owed after merge

Run the existing publishing release validation on the exact release SHA. Verify
routed Bun suites print executed testcase counts with zero skips, the native
Codex probe reports success, and native version
validation and checkpoint process boundaries pass. No production action or
Boat lifecycle is required for this test-routing change. OS/container checks
remain separately opt-in, not an implied pass from green unit CI.
