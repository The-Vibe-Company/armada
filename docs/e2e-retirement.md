# Legacy Playwright retirement plan (#2313)

Slice 1 preserves legacy specs until their owning journey lands; this is a plan, not a claim of equivalent coverage. No old spec is run by `bun run e2e`. Remove the direct Playwright dependency and old config only in slice 3 after the last spec is retired.

| Legacy spec | Retirement disposition |
| --- | --- |
| `account-recovery.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `api-v1.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `build-quality.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `build-section.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `chat-polling.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `codex-connection.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `command-menu.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `connections.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `conversation-quality.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `credential-projection.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `docker-snapshot-errors.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `fleet-empty-states.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `golden-manage.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `goldens.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `harness.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `host-setup.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `invitation-email-link.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `invitation-states.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `invitations.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `landing.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `launch-account-states.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `launch-skills.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `launch-surface.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `launch.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `lifecycle-errors.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `list-hosts.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `login.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `machine-size.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `model-accounts.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `model-action-errors.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `model-connection-check.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `model-selection.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `model-states.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `navigation.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `orgs.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `personal-provider-keys.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `provider-action-errors.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `provider-overview.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `providers.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `readable-names.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `remove-fleet.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `resource-panel-focus.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `routine-states.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `routines-panel.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `routines.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `sandbox-cost.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `sandbox-golden-label.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `sandbox-outcomes.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `sandbox-summary.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `sandbox-toolbar.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `sandbox-viewport.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `sandboxes.e2e.ts` | Slice 1 baseline journeys added; port remaining access, recovery, error and detail assertions before deleting. |
| `selected-org.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `settings.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `skill-states.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `skills.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `snapshot-build-feedback.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `snapshot-states.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `template-links.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `template-states.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `templates.e2e.ts` | Slice 2: port current launch / Snapshots / Templates / Routines behavior; delete obsolete pre-redesign selectors. |
| `theme.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `tool-states.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `tools-panel.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `variable-states.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `variables-panel.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
| `variables.e2e.ts` | Slice 3: port current account / resource / navigation behavior; delete obsolete pre-redesign selectors. |
