## Summary
- Upgrade Claude Code **2.1.319 → 2.1.322**, matching SDK **0.3.319 → 0.3.322**, npm latest non-prerelease pair checked Nov 10; upstream SDK explicitly declares parity.
- Update lockfile integrity, native/portable manifests, embedded server guards and Modal image. Runtime SHA-256 is computed from rebuilt bundle, no static checksum bypass.
- Shared golden recipe installs with `sudo -n npm install --global --prefix /usr/local` and verifies `/usr/local/bin/claude --version`, failing the build if it is not exactly 2.1.322. Newer image versions are deliberately downgraded to the validated exact pin, never shadowed with a user-prefix copy; real Bash regressions cover old/current/newer and ineffective installation. Codex and explicit default model unchanged.
- [Compatibility audit and operator runbook](docs/claude-runtime-upgrade.md). Merge this before #866; no catalogue changes.

## Compatibility checked
Reviewed upstream Code/SDK .319–.322 changelogs and published declarations. Consumed core/event types unchanged; native help retains stream-json, MCP config, resume, model and permission flags. Real-SDK/local-process tests cover steering, results, private MCP configuration and interrupt. Resume initialization ordering improves; unused WarmQuery/auto-mode changes require no rewrite. Fable alias now targets 5.2; Armada uses explicit claude-opus-5-5 by default. MCP OAuth redirect and Bash permission fixes retained. Sources and details in runbook.

## Operator prerequisites
Release/rebuild the server with the new artifact. Rebuild **every Boat and Modal golden used for Claude launches**, private and org, separately per provider. Preserve original full repos/branches/init configuration and original setup file, removing old tool overrides:
```sh
armada golden update <name> --provider boat --org <org> --config golden.json
armada golden update <name> --provider modal --org <org> --config golden.json
# Add --setup <original-setup-file> if originally used.
armada golden build-status <job-id>
```
Only run for providers hosting that golden. Boat uses shared recipe; Modal also uses rebuilt runner/pinned image. Use owner session for private goldens. Existing snapshots/running sandboxes do not self-upgrade; launch fresh after successful builds.

## Production check (operator, after #866 and golden refresh)
On each refreshed provider golden with an entitled account:
```sh
armada launch <name> --provider <boat-or-modal> --agent claude --model claude-fable-5-2 "Which model are you running? Report your exact model ID."
armada launch <name> --provider <boat-or-modal> --agent claude --model claude-opus-5-5 "Which model are you running? Report your exact model ID."
```
Inspect turn/model metadata and responses. Ineligible accounts must fail without substitution. No production/deploy/model calls performed here.

## Verification
- Local follow-up: lint and typecheck pass; native runtime build and validation pass again.
- Golden real-shell and service tests: **26 pass, 2 opt-in skips**. Shell suite alone: **12 pass**; mount-isolated Linux cases execute `/usr/local/bin/claude --version` at its exact launch path without changing the host installation. Installer fixture writes the executable, rather than just logging an npm command. A successful installer leaving a wrong version fails the golden build. The new focused test fails against the previous production code and passes with this fix.
- Independent read-only review of this follow-up: all four changed files reviewed, zero findings.
- Prior pushed head `8670c776de75fbe0f865b5174ccbcbe4f3c5b5fd`: all visible executable CI checks passed, including Linux runtime build/validation, full tests, golden OS/PostgreSQL, e2e, four binaries and Vercel; smoke skipped. New local follow-up has **not** been pushed or run in CI; coordinator must transport and wait for its latest-SHA CI.

## Real Boat golden build check — coordinator, required before rollout
The CI **Golden OS recipe (actual provider image)** uses the Modal image and is not proof of a real Boat golden. Run a **real Boat golden rebuild and absolute executable check**, using a non-production test golden and its original config/setup:
```sh
armada golden update <test-golden> --provider boat --org <org> --config golden.json
# Include --setup <original-setup-file> if originally used.
armada golden build-status <job-id>
armada launch <test-golden> --provider boat --agent claude
armada exec <sandbox-id> '/usr/local/bin/claude --version'
```
Require a successful golden build and exact output `2.1.322 (Claude Code)` from the absolute path Boat launches. Stop the test sandbox afterwards. This real Boat check was **not performed** in this sandbox. After #866, also perform the Fable and existing-model production checks above on refreshed goldens.

Migration files: **none**. No migrations applied.

Closes #870

Local follow-up commit for transport: `58f2bb6e9165d7359e71c95c4a1c7867ed681254`.
