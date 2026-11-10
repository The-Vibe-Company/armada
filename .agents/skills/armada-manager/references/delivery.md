# Delivery ownership

The worker owns implementation, same-session ship-pr ownership with separate-sandbox review, findings, required tests, PR creation and CI repair. The integrator owns final readiness, serialized merges, deployment and release follow-through within the user's authorized scope.

## A ready receipt

Require the exact PR head and base, scoped changes, final source/review coverage, findings and dispositions, verification commands/results, latest-head check state, and deployment prerequisites. Evidence must identify the source it proves. An OCR preview or self-review does not establish an independent review.

Use the repository's existing `ship-pr-dev` instructions and their real dependencies. Require the worker to launch a fresh Armada reviewer sandbox per round, with only the ticket and frozen-diff instruction, not its transcript. Prefer a different available harness/model, allow at most two rounds, and require stopped-state receipts. Never substitute a host subagent. See ship-pr-dev/references/review-gate.md. A final source change invalidates affected evidence, not necessarily every unrelated gate. Preserve a justified excluded/deleted-file disposition; do not manufacture coverage by labeling files reviewed without reading them.

For UI acceptance, inspect actual rendered frames at the relevant sizes and interactions. Include the area changed and any accepted area it must preserve. A screenshot's existence does not prove it matches the final source. Product requirements such as visual continuity cannot be waived by the coordinator simply to make a gate green.

## Merge and deploy

Check the current head, target branch, mergeability and all real latest-head CI required by the repository/ship-pr policy. Distinguish actual check runs from integration registrations that never created a run. Investigate failed, cancelled or incomplete checks; do not waive them as generic flakiness.

Merge the reviewed head through the authorized repository mechanism, with a pinned head or merge lease where available. Observe the confirmed merge before treating the role as merged. Keep each PR linked to its issue so closure is automatic. A competing main change requires relevant integration/retest, not a blanket restart of every worker's workflow.

Schema/API/UI compatibility is a deployment gate. An additive-looking migration may reject old writers. Check both directions, drain or hold the affected admissions only when needed, apply reviewed immutable migration bytes, deploy the compatible writer and perform postflight. Bound any maintenance window; do not leave the old UI unusable indefinitely while another lane works.

Ordinary rolling deployments should not unnecessarily serialize independent work. Coordinate a short checkpoint for explicit downtime or non-idempotent admission. Keep unknown provider outcomes fenced and account for active user jobs.

## Releases

When release/installation is authorized, finish that role too: inspect the release PR at its final head, run its agreed review/checks, merge, observe publication and registry availability, then verify the installed CLI and sign-in. A green preparation job alone is not a published release. Choose a coherent compatible batch rather than holding every completed independent fix for an unrelated future feature.

## Worker launch permission and evidence

Before dispatch, verify the worker has the Armada CLI, its own Armada login or
approved service identity, an accessible clean golden, provider quota and a
Bash permission gate allowing the intended `armada launch/status/wait/logs/stop/list`
commands (including cleanup). In interactive Claude Code, approve the applicable
`Bash(armada *)` rule only under the organization's policy; do not disable
permissions globally. A source invocation needs its own approved Bash rule.
Armada's native Claude runtime currently uses `bypassPermissions`; that does
not supply Armada API auth or quota. Never copy your token into a work order.
If missing, provision via the approved secret channel or report the exact blocker.

For lifecycle, provider-adapter and agent-runtime PRs, require a
**Real-provider verification** section: actual live commands/results or the exact
deployed check you must run. See `docs/post-deploy-smoke.md`; mocks are not live
evidence. Workers do not deploy or touch staging/production to fill this section.
