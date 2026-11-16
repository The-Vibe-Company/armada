# Modal GitHub launch investigation (#2456)

The reported production sandboxes cannot be attributed to a single cause from
source inspection alone. Do not treat this change as production push evidence.

## Confirmed contracts

- `--repo` selects a working directory from the golden configuration. It neither
  adds a repository nor authorizes a checkout found in a snapshot. An older CLI
  must actually send `repo` for working-directory selection to take effect.
- Managed native and enrolled GitHub capabilities authorize repositories from
  `goldens.config.repos`, using the sandbox owner's current GitHub connection.
  A snapshot's checkout is not an authorization grant.
- Native Modal records GitHub enablement from the trusted launch environment at
  first bootstrap; restore refreshes credentials only for an enabled launch.
- Core native setup installs its legacy helper only for connected launch access.
  Enrolled setup uses the runtime broker. Disconnected access can otherwise be
  reported in the launch response without failing a model-only launch.
- Git's missing-Username message is consistent with no effective helper. A
  managed wrapper cannot print its diagnostic when it was never installed or
  selected. This message alone does not identify why setup was absent.
- Native managed setup previously swallowed every authority-query error, treating
  a database failure like an absent connection. The same code serves Boat and
  Modal. Query errors now propagate; an empty authorized result remains optional.

## Evidence needed from the reported launches

The coordinator should correlate each failing and successful sandbox with its
launch response GitHub status, effective native/enrolled path, caller connection
state at launch, and golden repository configuration at launch. Current state
alone does not prove historical authorization. No credential values are needed.

New successful setup emits `launch_github_prepared` with logical sandbox/golden
IDs, provider, native/enrolled path, GitHub status, repository-selection presence
and configured repository count. It never logs identity, URLs, tokens, helper
contents or environment values. The event records the setup result, not proof of
push permission or later helper integrity. A failure before that point has no
success event and must be correlated with its launch error.

The existing provider parity `github` probe already clones an operator-selected
private repository and runs `git push --dry-run`. It verifies provider exec;
agent-shell push parity still requires staging evidence. Boat production
verification remains coordinator-only with `--only boat --production-boat`.
Do not run Boat as part of the release gate.
