## Summary
Closes #867. Launch-first public-catalog slice explicitly permitted by the ticket. Golden defaults/build installation/listing remain #868. #872 is now merged and provides private orchestrator installs; ordinary sandbox and delegated-child skills remain public-only in this slice.

- Repeatable CLI --skill becomes skills[] on API/MCP launch and selection.skills for orchestrator children.
- Reuses #839 public command/lock receipt validation in server-only core. Installs before first turn (including idle launches); persists verified UUID/version/checksum/origin receipts in status/detail.
- Invalid/private pins on the public-only launch surface fail before allocation. Failed installs/provenance/exclusion setup fail closed with sanitized errors, no first turn and stopped-machine cleanup.
- Selected coding checkouts locally exclude the lock, persistent lock sidecar, shared .agents skill paths and Claude copies using worktree-aware Git info/exclude. Creates its parent directory, appends a leading LF, and never changes tracked ignore files. Existing tracked files are not hidden by Git ignore rules.

## Design and scope
Before implementation investigated Armada bootstrap/launch/store/API/MCP/child paths and read-only Skillpack native install/public source. Chose exact public pins, native CLI project scope, at most 20 distinct slugs, selected harness/repository or golden root. Existing golden must provide native Skillpack CLI; no downloaded script or golden config field. Golden-config validation unchanged in this permitted launch-only slice.

## Reconciliation with merged #872
Merged origin/main at 21aecb84. Private orchestrator bootstrap calls #872's existing installPrivateSkill with its existing encrypted user-over-org credential resolver and PrivateSkillError diagnostics. Its pinned SSH stdin transport, ephemeral install-process environment, capability fence, workspace provenance and key cleanup are reused unchanged; no parallel credential/installer implementation.

Qualified anonymous catalog pins still share skillInstallCommand and parseSkillReceipt with sandbox launches. Public bootstrap never resolves private keys. #872 widened the orchestrator reference pattern to allow bare private slugs; sandbox/child validation now explicitly requires qualified public pins so this merge cannot accidentally admit private refs without their required credential/provenance path.

Removed the speculative SkillInstallTransport hook: #872 uses installPrivateSkill rather than that hook. The core public install test now exercises the actual provider-exec boundary. Future private sandbox work must reuse installPrivateSkill and resolveSkillpackCredential, not duplicate them. Defaults/version resolution remain #841; golden defaults remain #868. Never persist Skillpack credentials in a golden snapshot, profile/login, config or persistent environment. No golden build code is introduced here.

## Review corrections / compatibility
- Real temporary Git tests for both harnesses exercise actual staging; missing info directory and existing excludes lacking a final LF are covered. Pre-fix regression reproduced red.
- Production scoped-child test sends nonempty skills through the real gateway/executor/launch flow, verifies install-before-prompt and persisted receipt, identical replay and changed-pin idempotency conflict.
- Preserve legacy empty/no-skill launch digests and #852 extend ttlSeconds digests.
- Receipt updates require exactly one returned row; missing-row/other-owner guards tested.
- Core tests/fixtures own core public installation; readable human skill output and shared typed launch/status receipt schema.
- Existing real-serve fixture retries only the explicit retryable sandbox_not_ready observation lease conflict before asserting no_running_turn; bounded retries, assertions and deliberate admission-conflict test retained.

## Validation
Merge reconciliation focused tests: 23 passed, including #872 actual private guest installer, missing-key bootstrap on both providers, public/private isolation and both real serve fakes. Full merged-head bun run verify passed: 1625 passed, 20 skipped, 0 failed; 19133 assertions, lint and strict typechecks clean. Independent follow-up review: all nine candidate entries verified, no findings. Earlier review/CI results are historical only; latest-SHA CI requires transport/push because GitHub auth is unavailable here.

## Coordinator deployed check
On Boat and Modal, use compatible goldens with native Skillpack CLI and public catalog egress:
1. Launch a currently advertised public exact pin with --repo and first prompt; inspect status receipt and ask the agent to read the skill.
2. Check Git status does not offer the untracked installed lock/skill artifacts; inspect existing tracked files normally.
3. Unavailable pins must fail/stop without a first turn. Delegated-child retry with changed pins under the same key must conflict.
4. Preserve #872's private-skillpack-staging-boat-modal check for private orchestrator installs (docs/private-skillpack.md); no private-key lookup for qualified public installs.
No real provider/catalog/deployed check is claimed from mocks. No deploy or production/staging migration applied here.

## Migration / deployment prerequisites
- 20261110192000_sandbox_skills.sql retained unchanged, distinct from merged 20261110190000_skillpack_credentials.sql (#872) and reserved 20261110191000 (#889). Regenerated database types from the combined migration set.
- Apply required migrations before server rollout. Native Skillpack CLI on public launch goldens; #872 private orchestrator prerequisites remain unchanged (Node, Python, flock, read-only Skillpack key and pinned SSH).
- Skills are untrusted instructions, not confinement. No new secret environment contract in this PR.

## Transport
Local merge head: d90aac854304626578b4bde2718f32e3fbc85728, parents include origin/main21aecb84. Fresh full verify passed as above. PR_BODY.md description edits intentionally remain uncommitted; no push/PR mutation/merge/deploy performed in this local delivery phase. Coordinator transports source and description, checks current migration ordering/conflicts, and waits for all latest-head CI.
