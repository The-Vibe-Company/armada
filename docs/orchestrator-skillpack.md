# Skillpack skills for orchestrators

Armada launches parents and provides delegated child-launch tools. An
orchestration method—ticket routing, review, merge rules or scheduling—is a
user-selected skill, not an Armada policy.

## Supported create contract

CLI create accepts one optional `--skill org/slug@exact-version`; API and MCP
create accept the same reference in `skill`. This first slice supports only
anonymous public catalog releases from `https://skillpack.app/v1`.
Unversioned references, private/share-token packages and custom origins are
not supported. The `armada-tools` slug is reserved for launcher knowledge.

The selected golden must contain the released native `skillpack` executable
on PATH. Armada never downloads an installer or executes package code on the
control plane. In the parent, before recording the receipt, configuring
private authority or starting the first turn, it runs:

```sh
skillpack install org/slug --version 1.0.0 --api-url https://skillpack.app/v1 \
  --scope project --project /path/to/repository --tools codex --pin --yes --json
```

Claude parents use `--tools claude-code` instead. The CLI installs project-local
shared and managed host-discovery copies. No `AGENTS.md` or `CLAUDE.md` edit is
needed. Missing commands/releases, conflicting launcher-reference files,
execution failures and invalid receipts fail closed with sanitized errors.

Detail exposes the requested reference in `configuration.skill` and the resolved
origin, package UUID, exact version and checksum in `skillReceipt`. Installation
happens on create only, not on resume. Existing parents keep their installed
project files and are not re-bootstrapped. New creates may also inherit skills
already present in the chosen golden; Armada does not remove them.

Without a selected skill, Armada writes only its minimal `armada-tools` reference
for delegated `launch`, `read`, `message` and `stop`. No orchestration method is
installed. `ARMADA_ORCHESTRATOR_SKILL_REVISION` is deprecated compatibility
metadata; forty zeroes means no legacy revision, not a skill selection.

## Skillpack installation findings

The integration follows Skillpack's native implementation in
`runtime/internal/cli/{install,public,auth}.go` and `commands.go`, documented in
`docs/skillpack-cli.md` and `docs/skillpack-runtime.md` in the Skillpack repository.

Catalog fetches send neither saved nor environment credentials. They verify the
frozen ZIP checksum and package identity, and accept only the currently
advertised validated version. Skillpack copies package scripts but does not run
them. The project lock, `.companion/skills.lock.json`, records the `catalog:org`
workspace, API origin, slug, exact version, package UUID, pin and checksum, plus
per-target version and package checksum. Armada validates these fields before
persisting the public receipt.

Private workspace installs instead need a workspace-bound profile or ephemeral
`SKILLPACK_API_KEY`, never a key argument. Public share-token installs also need
an authorized API key and are not anonymous catalog installs. Armada's delegated
Armada/model/GitHub authority is not Skillpack authentication; private installation
needs a separate credential contract rather than credential reuse or fallback.

## Trust and authority

Skills are untrusted instructions. A malicious or broken method can direct the
parent to run commands, read parent credentials or consume its delegated launch
authority. Armada still enforces owner/org scope, authorized account/golden
selection, owned-child access, expiry and active-child limits. A version and
checksum identify the installed content; they do not establish that it is safe.

## Follow-ups and method migration

- #840: dashboard and iOS selection interfaces.
- #841: user-over-organization defaults and credential/custom-origin design.
- #842: publish The Vibe Company's `armada-manager` and its references, including
  coordinator-launched review from #831, as a Skillpack package. Validate both
  harnesses before removing the repository method copies. Keep `ship-pr-dev`
  unchanged and coordinate publication/removal with #837.

## Staging verification

Use goldens containing the released native Skillpack CLI. Create parents with a
currently advertised public `--skill org/slug@version` on Boat Claude, Boat Codex
and Modal Codex. Inspect detail for the receipt and ask the first turn to read the
installed skill. Confirm that an unavailable release blocks create without a
conversation or first turn. Fake-provider tests do not establish live loading;
these checks belong to coordinator staging verification, not production.
