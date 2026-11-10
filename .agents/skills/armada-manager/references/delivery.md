# Delivery ownership

The worker owns implementation, author self-check, required tests, PR creation and CI repair. The integrator owns final readiness, serialized merges, deployment and release follow-through within the user's authorized scope.

## A worker ready-for-review receipt

The worker owns implementation, author self-check, verification, PR and CI.
Require READY FOR REVIEW: PR #<n> head <full SHA>, with exact base, changes,
commands/results and deployment prerequisites. This is not merge approval.
No Armada identity or factory capability is granted to workers.

The coordinator launches and stops the independent reviewer using
[reviewer.md](reviewer.md): minimal prompt, existing CLI or scoped parent launch
tool, distinct available harness/model and two-round budget. Review findings
go back to the original worker session. Keep the author's transcript out.
Require the submitted GitHub review and stopped receipt, not a terminal claim.

For UI acceptance, inspect actual rendered frames at the relevant sizes and interactions. Include the area changed and any accepted area it must preserve. A screenshot's existence does not prove it matches the final source. Product requirements such as visual continuity cannot be waived by the coordinator simply to make a gate green.

## Merge and deploy

Check the current head, target branch, mergeability and all real latest-head CI required by the repository/ship-pr policy. Distinguish actual check runs from integration registrations that never created a run. Investigate failed, cancelled or incomplete checks; do not waive them as generic flakiness.

Require actual GitHub approval at the exact current head and confirmed reviewer cleanup per reviewer.md. Merge the approved head through the authorized repository mechanism, with a pinned head or merge lease where available. Observe the confirmed merge before treating the role as merged. Keep each PR linked to its issue so closure is automatic. A competing main change requires relevant integration/retest, not a blanket restart of every worker's workflow.

Schema/API/UI compatibility is a deployment gate. An additive-looking migration may reject old writers. Check both directions, drain or hold the affected admissions only when needed, apply reviewed immutable migration bytes, deploy the compatible writer and perform postflight. Bound any maintenance window; do not leave the old UI unusable indefinitely while another lane works.

Ordinary rolling deployments should not unnecessarily serialize independent work. Coordinate a short checkpoint for explicit downtime or non-idempotent admission. Keep unknown provider outcomes fenced and account for active user jobs.

## Releases

When release/installation is authorized, finish that role too: inspect the release PR at its final head, run its agreed review/checks, merge, observe publication and registry availability, then verify the installed CLI and sign-in. A green preparation job alone is not a published release. Choose a coherent compatible batch rather than holding every completed independent fix for an unrelated future feature.

## Real-provider evidence

For lifecycle, provider-adapter and agent-runtime PRs require a
**Real-provider verification** section: actual live commands/results or the exact
deployed check the coordinator must run. See docs/post-deploy-smoke.md; mocks
are not live evidence. Workers do not deploy to fill this section.
