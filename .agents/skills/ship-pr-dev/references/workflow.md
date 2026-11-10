# Delivery loop

1. Worker: read ticket and live code, scope the change, preserve unrelated work.
2. Worker: implement and run fresh targeted/broad verification.
3. Worker: perform and label author self-check, not independent review.
4. Worker: commit/push, create/update PR, fix all latest-head CI.
5. Worker: run report-only learning pass, mark PR ready for review, end with
   `READY FOR REVIEW: PR #<n> head <full SHA>`.
6. Coordinator: launch one fresh reviewer through existing CLI/scoped tools using
   armada-manager/references/reviewer.md. Collect its GitHub review, always stop.
7. Coordinator: forward changes requested to the original worker; at most two
   rounds. Worker repeats steps 2–5 on fixes. No factory authority in workers.
8. Coordinator: merge only when authorized, approved head unchanged, every visible
   non-skipped latest-SHA CI green and required provider-evidence section present.

Neither a worker self-check nor READY FOR REVIEW is independent approval.
