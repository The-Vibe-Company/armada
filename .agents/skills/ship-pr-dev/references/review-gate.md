# Worker self-check and coordinator review

The worker performs an **author self-check**, not an independent review. Inspect
the full diff against the ticket, document coverage/findings and fix problems.
OCR preview/rules may assist this self-check but do not establish approval.

Push the candidate, finish local verification and all latest-SHA CI, mark the PR
ready for review, and return `READY FOR REVIEW: PR #<n> head <full SHA>`.
State "Independent review: pending coordinator" in the PR.

The independent gate belongs exclusively to the coordinator, including an Armada
orchestrator parent using its existing scoped launch tool. Follow the installed
`armada-manager/references/reviewer.md` prompt and lifecycle protocol.
No worker login, new launch capability, reviewer subagent or copied parent token.
Missing coordinator launch authority blocks its merge gate, not worker handoff.

The coordinator sends changes requested back to the original worker session.
The worker fixes, self-checks, verifies, pushes and returns a new frozen head.
Only the coordinator can establish approval of that head and merge when authorized.
