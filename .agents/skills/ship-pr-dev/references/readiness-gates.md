# Readiness gates by owner

## Worker: READY FOR REVIEW

Require scoped committed/pushed source, correct base/issue link, fresh local
verification, explicit author self-check, and all visible non-skipped latest-SHA
CI green. Failed/cancelled/pending/stale/partially inspected checks block this
receipt. No secrets, unresolved conflicts, unrelated work or bypassed checks.
Run capture-learning-tools report-only and record migration/deployment prerequisites.

UI changes require repository-mandated rendered/interaction checks; explain any
unavailable optional visual check. Auth/security changes require affected tests.
Record exact commands, results, self-check findings and coverage, full head/base,
CI inventory and limitations in the ignored run directory.

Independent review is pending coordinator, **not** a worker completion gate.
No worker Armada auth or launch capability is needed. End with
`READY FOR REVIEW: PR #<n> head <full SHA>`, never a merge-ready claim.

## Coordinator: merge readiness

Follow armada-manager/references/reviewer.md. Require an actual submitted GitHub
approval for the exact current head, complete diff coverage, no unresolved
critical/high/medium findings (medium requires explicit human risk acceptance),
confirmed reviewer stop, all visible non-skipped latest-head CI green and merge
authorization. Missing/incomplete review or cleanup blocks merge.
Lifecycle/provider/runtime changes also require Real-provider verification in
the PR body (live evidence or exact coordinator deployed check to run).
Any new source head invalidates approval; use a new bounded review round.
Never merge from the worker receipt alone or from a self-authored approval.

## Bounded correction

At most two independent rounds, controlled by the coordinator. Return findings
to the original worker session, not a replacement author. After the second
unsuccessful round, request human direction; do not waive gates or launch a third.
Ordinary test/CI failures should be diagnosed and safely fixed; report a blocker
only when further progress requires unavailable input, access or a human decision.
