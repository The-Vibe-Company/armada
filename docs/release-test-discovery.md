# Release test discovery investigation (#2472)

Ordinary PR CI runs `scripts/ci/unit-shards.ts`: tracked files ending in
`.test`, `_test`, `.spec` or `_spec` with JS/TS extensions. Bun default discovery
uses these names too. Explicitly named release/probe files are outside that set.
No CI routing or required contract selection changes are made here.

## Reproduction and attribution

Bun 1.4.2, isolated local fake transport (no provider or production access):
`bun test ./packages/core/test/private-skill.probe.ts -t 'launch ok' --reporter=junit --reporter-outfile=/tmp/private.xml`.

Parent `45ceacef` of #2462: 1 pass, 0 fail. Commit
`f9947c59df5b1120968fa48fab919816295dd627` (#2462): 0 pass, 1 fail,
JSON parse error at line 111. Current main reproduces that same failure.
The added core launch audit record precedes the expected receipt on stdout:

```json
{"event":"launch_github_prepared","sandboxId":"<generated>","goldenId":"golden","provider":"boat","path":"native","status":"not_connected","repositorySelected":false,"configuredRepositories":1}
{"receipt":{"reference":"notes@1.0.0","version":"1.0.0","skillId":"22222222-2222-4222-8222-222222222222","checksum":"sha256:<64 a characters>","origin":"https://skillpack.app/v1","workspaceId":"11111111-1111-4111-8111-111111111111"},"prompted":true}
```

This is a core output-channel regression, not a stale probe. The probe invokes
`launchSandbox` directly, not the CLI. The CLI is API-only; this reproduction
therefore does not establish a CLI `launch --json` regression. Keep its strict
single-JSON assertion. Send diagnostic audit events to stderr. The same defect
exists in ownership retry, GitHub refresh/revocation and golden build phase
logging; all core `console.info` audit sites move together, retaining their data.
GitHub connection replacement/disconnection events in the dashboard and account
API follow the same stderr contract; the shared audit capture helper and its
existing payload/security assertions cover these producers too.

## Test files excluded from ordinary unit discovery

Inventory of tracked executable Bun suites with non-default names (helpers and
non-test provider probes are excluded). These are listed for the owner to decide
routing; this change adds no checks. Some require native artifacts, disposable
PostgreSQL or explicit coordinator authorization and must not enter unit CI.

- `packages/cli/test/binary.release.ts`
- `packages/core/test/database-types.probe.ts`
- `packages/core/test/github-reconnect-postgres.release.ts`
- `packages/core/test/github-runtime-postgres.release.ts`
- `packages/core/test/golden-adoption-postgres.release.ts`
- `packages/core/test/golden-build-jobs-postgres.release.ts`
- `packages/core/test/golden-create.release.ts`
- `packages/core/test/golden-os.probe.ts`
- `packages/core/test/golden-scan.probe.ts`
- `packages/core/test/golden-snapshot-retirement.release.ts`
- `packages/core/test/private-skill.probe.ts`
- `packages/core/test/work-preservation.probe.ts`
- `packages/mcp-server/test/lifecycle-driver-postgres.release.ts`
- `packages/mcp-server/test/runtime-enrolment-postgres.release.ts`
- `packages/mcp-server/test/runtime-native-auth-postgres.release.ts`
- `packages/mcp-server/test/sql.release.ts`
- `packages/provider-boat/test/integration.coordinator.ts`
- `packages/provider-modal/test/artifact.release.ts`
- `scripts/build-migration.release.ts`

The full release unit command was deliberately not run: the delivery owner
explicitly forbids the full unit suite in this sandbox due to machine loss.
Targeted probe output is evidence only for that probe, not a full release pass.

## Other test runners outside ordinary unit discovery

Browser suites (not run in PR CI):

- `apps/dashboard/e2e/account-recovery.e2e.ts`
- `apps/dashboard/e2e/api-v1.e2e.ts`
- `apps/dashboard/e2e/build-quality.e2e.ts`
- `apps/dashboard/e2e/build-section.e2e.ts`
- `apps/dashboard/e2e/chat-polling.e2e.ts`
- `apps/dashboard/e2e/codex-connection.e2e.ts`
- `apps/dashboard/e2e/command-menu.e2e.ts`
- `apps/dashboard/e2e/connections.e2e.ts`
- `apps/dashboard/e2e/conversation-quality.e2e.ts`
- `apps/dashboard/e2e/credential-projection.e2e.ts`
- `apps/dashboard/e2e/docker-snapshot-errors.e2e.ts`
- `apps/dashboard/e2e/fleet-empty-states.e2e.ts`
- `apps/dashboard/e2e/golden-manage.e2e.ts`
- `apps/dashboard/e2e/goldens.e2e.ts`
- `apps/dashboard/e2e/harness.e2e.ts`
- `apps/dashboard/e2e/host-setup.e2e.ts`
- `apps/dashboard/e2e/invitation-email-link.e2e.ts`
- `apps/dashboard/e2e/invitation-states.e2e.ts`
- `apps/dashboard/e2e/invitations.e2e.ts`
- `apps/dashboard/e2e/landing.e2e.ts`
- `apps/dashboard/e2e/launch-account-states.e2e.ts`
- `apps/dashboard/e2e/launch-skills.e2e.ts`
- `apps/dashboard/e2e/launch-surface.e2e.ts`
- `apps/dashboard/e2e/launch.e2e.ts`
- `apps/dashboard/e2e/lifecycle-errors.e2e.ts`
- `apps/dashboard/e2e/list-hosts.e2e.ts`
- `apps/dashboard/e2e/login.e2e.ts`
- `apps/dashboard/e2e/machine-size.e2e.ts`
- `apps/dashboard/e2e/model-accounts.e2e.ts`
- `apps/dashboard/e2e/model-action-errors.e2e.ts`
- `apps/dashboard/e2e/model-connection-check.e2e.ts`
- `apps/dashboard/e2e/model-selection.e2e.ts`
- `apps/dashboard/e2e/model-states.e2e.ts`
- `apps/dashboard/e2e/navigation.e2e.ts`
- `apps/dashboard/e2e/orgs.e2e.ts`
- `apps/dashboard/e2e/personal-provider-keys.e2e.ts`
- `apps/dashboard/e2e/provider-action-errors.e2e.ts`
- `apps/dashboard/e2e/provider-overview.e2e.ts`
- `apps/dashboard/e2e/providers.e2e.ts`
- `apps/dashboard/e2e/readable-names.e2e.ts`
- `apps/dashboard/e2e/remove-fleet.e2e.ts`
- `apps/dashboard/e2e/resource-panel-focus.e2e.ts`
- `apps/dashboard/e2e/routine-states.e2e.ts`
- `apps/dashboard/e2e/routines-panel.e2e.ts`
- `apps/dashboard/e2e/routines.e2e.ts`
- `apps/dashboard/e2e/sandbox-cost.e2e.ts`
- `apps/dashboard/e2e/sandbox-golden-label.e2e.ts`
- `apps/dashboard/e2e/sandbox-outcomes.e2e.ts`
- `apps/dashboard/e2e/sandbox-summary.e2e.ts`
- `apps/dashboard/e2e/sandbox-toolbar.e2e.ts`
- `apps/dashboard/e2e/sandbox-viewport.e2e.ts`
- `apps/dashboard/e2e/sandboxes.e2e.ts`
- `apps/dashboard/e2e/selected-org.e2e.ts`
- `apps/dashboard/e2e/settings.e2e.ts`
- `apps/dashboard/e2e/skill-states.e2e.ts`
- `apps/dashboard/e2e/skills.e2e.ts`
- `apps/dashboard/e2e/snapshot-build-feedback.e2e.ts`
- `apps/dashboard/e2e/snapshot-states.e2e.ts`
- `apps/dashboard/e2e/template-links.e2e.ts`
- `apps/dashboard/e2e/template-states.e2e.ts`
- `apps/dashboard/e2e/templates.e2e.ts`
- `apps/dashboard/e2e/theme.e2e.ts`
- `apps/dashboard/e2e/tool-states.e2e.ts`
- `apps/dashboard/e2e/tools-panel.e2e.ts`
- `apps/dashboard/e2e/variable-states.e2e.ts`
- `apps/dashboard/e2e/variables-panel.e2e.ts`
- `apps/dashboard/e2e/variables.e2e.ts`
- `tests/dashboard/launch.e2e.ts`
- `tests/dashboard/models.e2e.ts`
- `tests/dashboard/presets.e2e.ts`
- `tests/dashboard/sandboxes.e2e.ts`
- `tests/dashboard/snapshots.e2e.ts`

iOS suites (conditional iOS checks when their files change, not the Bun unit gate):

- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/ArmadaClientTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/ConversationLoadingTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/ConversationReadRacesTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/ListOrderingTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/SandboxConversationTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/SandboxLaunchTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/ServerWireContractTests.swift`
- `apps/ios/ArmadaKit/Tests/ArmadaKitTests/URLSessionTransportTests.swift`
- `apps/ios/ArmadaKit/Tests/ConversationProjectionTests/ProjectionTests.swift`

Python suites (outside the Bun unit gate):

- `.agents/skills/review-code-dev/scripts/test_ocr.py`
- `.agents/skills/ship-pr-dev/scripts/test_collect_ship_context.py`
- `.agents/skills/ship-pr-dev/scripts/test_prepare_ship_run.py`
- `scripts/db/test_validate_dispatch.py`
- `scripts/routines/test_staging_check.py`
- `scripts/sandbox-access/test_staging_check.py`
- `scripts/test_smoke_docker_lifecycle.py`
