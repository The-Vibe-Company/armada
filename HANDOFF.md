# HANDOFF: issue #605 / PR #618 (branch codex/605-credential-frontend)
Done: named model accounts on Credentials, launch account selector with explicit credentialId, #624 v3 usage/credits UI, sizing (#667) integration, #612/#643/#666 merges.
Done: copy for Replace/Remove states #612 pinning (new messages refused, files/conversations kept); stale e2e comment fixed at beda92a5.
Local gates at beda92a5: `bun run verify` 1118 pass / 0 fail; Playwright 149/149 and build at 538d6410 (beda92a5 adds one comment only).
Review: same reviewer a6d0e709f98391cdb re-reviewed beda92a5 as final freeze: complete, 22/22 files, 0 critical/high/medium.
Open review findings (all low, accepted): #7 mock org seed name differs from #603 migration; #9 same-scope duplicate account names allowed by #603; #11 light-theme --warning contrast 4.01:1 (global token).
Remains: push this branch (published remote head 6f20e32, fast-forward, contains main e5fc554f), update PR body, wait for all CI on the pushed head.
PR body draft: plans/ship-pr-dev/runs/20261109-162332-repo-b/pr-body-adf2f73d.md is STALE (old Replace wording, old head and counts); fix line 25 and the counts before using it.
Evidence: plans/ship-pr-dev/runs/20261109-162332-repo-b/ (git-ignored, sandbox-local): visual-final/MANIFEST.json, review/, review-gate.md, verification.md, bundle/.
Deploy order: backend #612 with migration 202 before #618. #604 auth-capabilities not on main: UI offers paste only; usage route (#643) is live.
Follow-ups (outside #605): main ModelFields resets effort to "Low" after a refused launch (#685); lib/failure.ts expired-credential hint contradicts pinning.
Follow-ups (outside #605): two creds/list parsers (#666 compatibleAccounts vs accountsFromList); e2e mock housekeeping (orphan comment ~line 44, bindCredential scoping comment, {usage} wrapper).
Follow-ups: Replace dialog effect sentence is outside DialogDescription (screen readers); loading.tsx not verified under real latency.
No real OAuth/provider/VM, merge or deploy was done. GitHub token in this sandbox is dead; transport via bundle or coordinator push.
Remove this HANDOFF.md before merging PR #618.
