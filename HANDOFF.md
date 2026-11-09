# Handoff — issue #681 / PR #684
Branch: codex/681-owner-mcp-defaults; base main; sandbox expires 21:30 UTC.
Completed source commit: 4fc8227e72a3375f891ac070788a84597b90cc7d (tree 544ba2d5d91adaa44378fba380377cfb36beff4e).
Normal merges preserve current main e5fc554f and reviewed #680 parent 3b239aa9d0c48b004dc9f302a667cf421f24dfc5.
Done: owner-personal MCP launch defaults, deliberate selection/empty overrides, immutable bindings, new migration 20261110121200.
Security: same-org/current-owner membership and personal grant ownership preserved; admin interior cannot bootstrap another owner personal grant.
Actual published Linux npm client 2.12.0 passed 51 assertions against exact completed source; registry integrity and ELF provenance verified.
Compatibility: default list and JSON are safe metadata JSON; absent permission hints mean unknown; old client omits new model-binding fields.
Verification: full verify 1085 passed / 18 opt-in skips / zero failures; native build/validation and artifact test passed.
Review: same original independent primary cleared final 36 source paths plus five final compatibility artifacts; no open findings.
Scope: own 12 paths plus inherited #680 29 paths, five overlaps; inherited current-main UI/iOS was not reimplemented.
Evidence: plans/ship-pr-dev/runs/20261109-180236-armada/final-3b/ (ignored, local); code bundle at /tmp/armada-681-integration-handoff/.
Remote PR last observed at obsolete 92ce40b8; guest GitHub authentication is dead; do not wait for token renewal.
Remaining: transport this final branch unchanged, run all actual exact-head CI, update PR status, and reconcile consumer #683 backend bytes.
Open findings: none; NOT READY until final-head CI passes; coordinator owns merge and coupled 211+212/consumer deployment, no production operations performed.
