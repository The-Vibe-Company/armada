# Issue #689 handoff — codex/689-ios
PR: https://github.com/The-Vibe-Company/armada/pull/698 (draft; Closes #689; target main).
Verified implementation head: f9a9be75b2a24b90618d4729510d120f6bb1525a; base fc8410c41f5412b198f18254926bab391e1e9752.
Done: apps/ios/project.yml deterministically generates Armada project/shared scheme; Swift6/iOS26/local ArmadaKit.
Done: Debug co.thevibecompany.armada.dev, Release co.thevibecompany.armada, production API pinned; team K28B69CWQ7.
Done: plist/config, ignored generated output, root-only export instructions, TestFlight metadata/discovery plan.
Done: additive Apple Quality runs real package tests and unsigned Debug/Release generic simulator compile; no boot/MCP.
Dependencies: actual main #695 UI integrated; inherited ten Kit files EXACT stable c00d98ac6553a9eac758db29855eae9cf4cdd0d8, explicitly authorized by Mac operator.
Verification: local runtime build/native validator/full verify PASS1074 tests,17 opt-in skips,0fail; no worker local Apple claims.
Exact-head CI: ALL12visible checks SUCCESS at f9a9be75; AppleQuality42693958214 passed15Swift tests and both simulator variants.
Review: SAME isolated primary reviewed original scope and integration deltas;21/21diffpaths reconciled; zero own build/integration findings.
Open dependency findings: #694 original owner/root handles generic409/CAS recovery medium and later forward-compat/rejection fixes; NOT cleared by stable c00 proof.
Remaining: consume FINAL actual #694/main, resolve shared version-test hunk to main, resume SAME reviewer if available, rerun affected local/native/exact-head CI.
Evidence: full21path SHA256 table posted #689 comment6750900691; local ignored plans/ship-pr-dev/runs/20261109-183712-armada has review/logs/learning report.
Root alone merges/signs/registers/uploads/distributes; Mac c00+6956b07+6897fb rendered/auth proof is composition-scoped; no final TestFlight/native enablement claim; GitHub token dead, coordinator transports branch.
