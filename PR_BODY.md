## Summary
Closes #867. Launch-first slice explicitly permitted by the ticket. Golden defaults, build-time installation and golden listing are tracked in #868; private skills/credentials are owned by #841 / PR #872.

- Repeatable CLI --skill becomes skills[] on API/MCP launch and selection.skills for orchestrator children.
- Reuses #839's native public catalog install command and lock receipt validation, extracted into server-only core. Exact public pins only; no implicit private/auth/custom-origin fallback.
- Installs before first turn (including idle launches), records verified UUID/version/checksum/origin receipts, exposes them in status/detail, and fails closed with sanitized errors and stopped-machine cleanup.

## Design recorded before implementation
Investigated Armada's bootstrap, launch/store/API/MCP/child paths and read-only Skillpack runtime/internal/cli/install.go and public.go. Chose native CLI project-scoped installs for the selected harness/repository or golden root. The golden must already contain native Skillpack. At most 20 distinct public slugs; invalid pins fail before allocation. No downloaded scripts, request credential fields, golden config changes or secret storage. Golden-config validation remains unchanged in this permitted launch-only slice.

The owner's skills are PRIVATE: this public slice alone does not install them. The trusted server-only SkillInstallTransport is retained for its concrete consumer, #841 / PR #872 (codex/841-private-skillpack-skills). It separates install and receipt-read commands so a closure can inject a resolved encrypted-store credential as ephemeral environment for the install process only. Shared catalog validation stays catalog-only; #841 must implement private workspace provenance explicitly. No transport or credential is exposed in public requests/config/receipts.

Golden builds must remain credential-free: #868 must never invoke credential-bearing transport, persist a Skillpack login/profile/config secret, add credentials to persistent environment, or snapshot a credential-bearing builder. No golden build code is introduced here.

## Round 1 review corrections
1. Selected coding checkouts now locally exclude the Skillpack lock, its persistent .lock sibling, shared .agents skills and Claude copies via Git's info/exclude (including worktree-aware path resolution), before the first turn. Exclusion failure fails closed. The shared real-serve assertion checks the exclusion command ran on both provider fakes. Git ignores cannot hide already tracked files; existing tracked skill conflicts remain subject to Skillpack rules and normal Git review.
2. Existing production scoped-child composition test now sends non-empty skills through the actual gateway, executor and launchSandbox; verifies install-before-prompt and persisted child receipts; verifies identical replay and changed-skills idempotency conflict without another fork/install/prompt.
3. Receipt writes require exactly one returned row, with missing-row/other-owner regression assertions, preventing response/status divergence.
4. Transport unit test and canonical CLI output fixture moved into core; consumer noted in code.
5. Human launch output prints one reference/checksum per line, not raw JSON.
6. Launch/status share the same typed receipt schema.
7. Stale seam-validation status removed; reviewed-head CI was green at 67143b0f. Latest local corrections require transport/push and fresh CI; GitHub access is unavailable in this sandbox.
8. AGENTS.md documents the server-only shared Skillpack module.

## Verification
Round 1 local head eeabf4234153c6eb041897274b053d147c8adabe: bun run verify passed (lint, strict typechecks and full default-timeout suite): 1603 passed, 20 skipped, 0 failed, 18914 assertions. Independent follow-up review covered every candidate path with no outstanding findings. Actual Git staging regressions failed on reviewed pre-fix head 67143b0f (both harnesses) and passed after the fix. No live catalog/provider or deployed check is claimed from mocks. Earlier head 67143b0f passed 1601 tests (20 skipped), independent review and GitHub CI; that is historical evidence only, not CI for the unpushed corrections.

## Coordinator deployed check
On Boat and Modal, use a compatible golden with native Skillpack on PATH and public catalog egress:
1. Launch with a currently advertised public exact pin, --repo and a first prompt; inspect status receipt and ask the agent to read the skill.
2. Confirm git status in the checkout does not offer the untracked lock/installed skill files for commit (local excludes), and inspect existing tracked files normally.
3. An unavailable release must fail/stop without a first turn. Repeat a delegated child launch with skills; retrying its key with different pins must conflict.
No deploy or production/staging migration application performed in this session.

## Migration / deployment prerequisites
- 20261110192000_sandbox_skills.sql adds public receipt JSON plus authenticated SELECT, no secrets. It is above main's 20261110181000 and the reserved 20261110190000 (#872) / 20261110191000 (#889); coordinator must recheck current main before transport push because GitHub is unavailable here.
- Apply migration before server rollout; native Skillpack CLI on compatible goldens, public catalog egress. No environment secret changes.
- Skills are untrusted instructions, not a confinement boundary.


## Transport handoff
Local-only head: acdd439988a0898a5834b7774d7a9033bf93fddc. No push attempted (GitHub access unavailable). Updated description changes are in PR_BODY.md at repo root and intentionally not committed (the coordinator previously tracked this file). Coordinator transports commit and description, rechecks current migration ordering and all latest-SHA CI, and retains the ready (not draft) PR. No merge/deploy performed.


## Round 2 corrections
Merged current origin/main, preserving launch-only nonempty skills digest suffix and #852 extend ttlSeconds branch. Exclusion writes now create the resolved info/exclude parent directory before append; existing real-Git tests also exercise a missing info directory. Renamed migration to 20261110192000_sandbox_skills.sql to avoid #872/#889 reservations; regenerated database types (no schema-content change from rename). Updated migration references. Round-2 final bun run verify passed: 1615 passed, 20 skipped, 0 failed, 18983 assertions. Targeted merge/skills/lifetime checks: 59 passed. Independent review: all eight candidate paths checked, no outstanding findings.

Round-2 merged-main broad verification exposed a pre-existing fixture race: the steer semantic-refusal assertion sometimes received the background observation lease conflict instead. The fixture now retries that explicit retryable sandbox_not_ready admission code for steer too (as it already does for successful operations); it still requires no_running_turn and preserves the deliberate admission-conflict assertion. No production behavior or timeout/assertion relaxed. Fresh full verify passed after the fixture correction and native runtime refresh described below.


## Final local verification / environment
Merged main upgrades the pinned Claude native runtime from 2.1.319 to 2.1.322; initial broad validation detected the old ignored local binary. Rebuilt with bun packages/agent-runtime/build.ts, validated with bun scripts/validate-runtime-native.ts, and the actual runtime artifact test passed. Then reran bun run verify from scratch: 1615 passed, 20 skipped, 0 failed (18983 assertions), lint and strict typechecks passed. No source assertion/timeout was weakened. Database types regenerated from the renamed migration with no schema-content diff. No push attempted; latest-SHA CI and final remote conflict/migration checks remain with transport.
