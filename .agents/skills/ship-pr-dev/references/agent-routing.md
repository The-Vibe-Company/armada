# Agent ownership

The delivery worker owns implementation, Git, PR and CI. Keep bounded helper work
read-only unless a single explicit implementation owner is assigned. Helpers
never mutate Git or remote state. Do not spend agents on polling.

Author self-check stays in the delivery session. It is not independent review.
No independent reviewer is dispatched by ship-pr-dev and no Armada credentials
are provisioned to a worker.

The coordinator alone launches an isolated reviewer using
armada-manager/references/reviewer.md, preferably a different available
harness/model. It owns two-round budgeting, findings delivery to the original
worker, cleanup and merge readiness. Never use a host subagent as a substitute.
