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
Native cwd and MCP credential rotation tests remain mixed unit/protocol files;
the release runner explicitly re-executes them with the real pinned Codex binary.
No contract was deleted as redundant, and no native or PostgreSQL success is
claimed from this local environment.

## Remaining skip audit

Repository-wide search includes `skipIf`, `test.skip`, conditional test aliases,
`describe.skip` and `todo`. No todo declarations were found. Dispositions:

- Linux platform skips remain in core `docker-snapshot-init`, `golden-helper`,
  `golden-scan`, `golden-script-shell`; provider-modal `snapshot`, `distribution`;
  provider-boat `runtime-bootstrap`, `native-install-race`, `native-cwd`;
  mcp-server `templates`, `managed-inspection`, `runtime-native-auth`;
  agent-runtime `skills`, `runtime`, `readable-variables`, `exec-env`,
  `enrolled-harness`, `messages`, `cwd`, `codex`, `claude`.
  These execute in Linux PR CI; skips on unsupported author machines do not
  represent native release evidence. `golden-helper` is x64-specific and
  `golden-scan` privilege-drop cases require a usable nobody account.
- Core `golden-os`, provider-modal `ssh-os`, mcp-server `github-boat-os` are
  opt-in container/image OS acceptance, not ordinary unit proof. They require
  `ARMADA_GOLDEN_OS_IMAGE` and remain on-demand acceptance checks; no provider
  or image build is introduced into PR CI.
- `provider-boat/integration.coordinator.ts` is no longer automatically
  discovered at all. Only the coordinator may explicitly invoke its documented
  billed-compute opt-in command. It is not part of release/staging acceptance:
  `boat: not part of the release gate`.
- PostgreSQL skips and artifact portable-manifest skips were replaced by
  explicit release prerequisites. Missing native-binary skips in `native-cwd`
  and `mcp-codex-bridge` are forbidden by the release runner's no-skip report.

## Evidence owed after merge

Run the existing publishing release validation on the exact release SHA. Verify
all routed files print executed testcase counts with zero skips, native version
validation and checkpoint process boundaries pass. No production action or
Boat lifecycle is required for this test-routing change. OS/container checks
remain separately opt-in, not an implied pass from green unit CI.
