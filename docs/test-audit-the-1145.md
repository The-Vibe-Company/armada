# THE-1145 — Armada test-value audit

Baseline: [`4fb197721bc05993e07acd935c9697b40741daf4`](https://github.com/The-Vibe-Company/armada/commit/4fb197721bc05993e07acd935c9697b40741daf4), `origin/main` when discovery began on 2026-10-06. This is a read-only decision ledger for THE-1146. No test, support file, production source, CI rule or bundled skill artifact changes in THE-1145. No deletion has been applied or mutation claimed.

## Result and limits

The audit records **1225 test declarations**: 1211 TypeScript/Bun declarations and 14 Python declarations. Marks: **1170 R**, **31 F**, **23 C**, **1 D**. F retains a contract with weaker evidence; C requires assertions to reach the named keeper before deletion; D names proof that remains. These marks are recommendations, not an executable cut list. Step 4 plans below control the eventual batches.

The runtime baseline is **1,372 passed, 0 failed, 0 skipped**, across **135 Bun files**, with 2 snapshots and 11,091 assertions. Runtime cases differ from source declarations because `test.each`, template-generated cases and loops expand at execution. A parameterized declaration has one judgment unless its rows need different judgments; all audited rows here share their declaration’s disposition. Python adds **14 passed** in three files.

Full-suite baseline failures / possible product bugs: **none observed**. Supplemental isolated baseline check: `bun test packages/dashboard/test/workers.test.ts -t "exchanges are limited"` fails (0 pass, 1 fail, 10 filtered), requiring an earlier test’s ABC-12 log at line492. This is recorded apart as a test-order defect, not a confirmed product bug. `bun test packages/dashboard/test/secrets.test.ts -t "no value is ever logged"` passes (1 pass, 5 filtered) without exercising the secret operations it claims. Both files were unchanged at the pin and these checks made no edits. F entries otherwise identify assertion defects or gaps, not evidence that the product currently fails. Timing of this cloud baseline was 171.56 s for Bun; this is one host observation, not a calibrated performance benchmark or a claimed speedup.

No whole test file is approved for retirement. Keep fake-network transport proofs, CLI argument/serialization proofs, and PGlite lifecycle/transaction proofs when each catches a distinct boundary failure. Static checks remain when they independently guard architecture, public bytes or generated artifacts. Security and concurrency checks remain conservative.

## Baseline method and counts

Commands on the pinned checkout, after `bun install --frozen-lockfile` (Bun 1.4.2):

```sh
bun test --reporter=junit --reporter-outfile=.context/audit/baseline.xml
python3 -m unittest discover -s .agents/skills/ship-pr-dev/scripts -p 'test_*.py'
python3 -m unittest discover -s .agents/skills/review-code-dev/scripts -p 'test_*.py'
```

JUnit file records supply every Bun file result below; source locations come from a TypeScript AST inventory of tracked test/spec files, including callback-bearing `test.each<T>` and loop-generated declarations. Python declarations come from its AST. The full declarations and parameter tables were read by production-owner lanes, together with owners, callers, related history and `.github/workflows/ci.yml`; a second pass names keepers. Completion checks reconcile identities `(path, declaration line)` against this inventory, with no missing or multiply assigned declarations.

Line counts use tracked text lines at the pin. “Support” includes every non-test file under the package’s `test/` directory, including JSON/text fixtures; it excludes production and vendored Python scripts. This definition avoids confusing fixtures with production simplification.

| Package | Test files | Test LOC | Support files | Support LOC |
|---|---:|---:|---:|---:|
| core | 46 | 13,174 | 4 | 3,339 |
| cli | 46 | 13,652 | 10 | 118 |
| dashboard | 43 | 10,715 | 1 | 46 |

Vendored Python tooling tests: 3 files, 211 LOC. They are outside Bun discovery and are **not executed by current ci.yml**; their pass state comes from the explicit baseline commands above. No claim of automatic CI routing is made.

CI independently runs lint/typecheck/Bun, dashboard build, browser accessibility (English/French, 320px, keyboard/reduced motion), production bundle/Lighthouse/INP budgets and Node 22 packed-CLI smoke. Browser QA and performance scripts are integration keepers; they are not counted as Bun/Python test declarations and were not run in this initial baseline. Their eventual PR check states are delivery evidence, separate from pinned test-file results.

## Every test file: pinned baseline

| File | Source declarations | Runtime cases | Pass / fail / skip | Test LOC |
|---|---:|---:|---|---:|
| [packages/cli/test/attach.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/attach.test.ts) | 2 | 2 | 2 / 0 / 0 | 83 |
| [packages/cli/test/auth.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/auth.test.ts) | 9 | 9 | 9 / 0 / 0 | 210 |
| [packages/cli/test/brief.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/brief.test.ts) | 24 | 24 | 24 / 0 / 0 | 765 |
| [packages/cli/test/ci.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/ci.test.ts) | 12 | 30 | 30 / 0 / 0 | 371 |
| [packages/cli/test/cli.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/cli.test.ts) | 27 | 27 | 27 / 0 / 0 | 613 |
| [packages/cli/test/codex-models.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/codex-models.test.ts) | 4 | 4 | 4 / 0 / 0 | 119 |
| [packages/cli/test/conductor-launch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/conductor-launch.test.ts) | 20 | 20 | 20 / 0 / 0 | 556 |
| [packages/cli/test/coordinator.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/coordinator.test.ts) | 2 | 2 | 2 / 0 / 0 | 84 |
| [packages/cli/test/deferred-launch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/deferred-launch.test.ts) | 2 | 2 | 2 / 0 / 0 | 169 |
| [packages/cli/test/deploy.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/deploy.test.ts) | 5 | 5 | 5 / 0 / 0 | 154 |
| [packages/cli/test/digest.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/digest.test.ts) | 1 | 1 | 1 / 0 / 0 | 56 |
| [packages/cli/test/doctor.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/doctor.test.ts) | 20 | 20 | 20 / 0 / 0 | 522 |
| [packages/cli/test/first-run.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/first-run.test.ts) | 2 | 2 | 2 / 0 / 0 | 32 |
| [packages/cli/test/heartbeat.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/heartbeat.test.ts) | 4 | 4 | 4 / 0 / 0 | 114 |
| [packages/cli/test/herdr-first-run.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/herdr-first-run.test.ts) | 4 | 4 | 4 / 0 / 0 | 81 |
| [packages/cli/test/herdr.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/herdr.test.ts) | 20 | 20 | 20 / 0 / 0 | 529 |
| [packages/cli/test/http.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/http.test.ts) | 1 | 1 | 1 / 0 / 0 | 16 |
| [packages/cli/test/init.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/init.test.ts) | 11 | 14 | 14 / 0 / 0 | 609 |
| [packages/cli/test/job.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/job.test.ts) | 8 | 8 | 8 / 0 / 0 | 256 |
| [packages/cli/test/keys.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/keys.test.ts) | 11 | 14 | 14 / 0 / 0 | 350 |
| [packages/cli/test/launch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/launch.test.ts) | 7 | 7 | 7 / 0 / 0 | 222 |
| [packages/cli/test/lint.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/lint.test.ts) | 1 | 1 | 1 / 0 / 0 | 117 |
| [packages/cli/test/local-launch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/local-launch.test.ts) | 28 | 28 | 28 / 0 / 0 | 726 |
| [packages/cli/test/local-setup.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/local-setup.test.ts) | 9 | 9 | 9 / 0 / 0 | 283 |
| [packages/cli/test/local-tools.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/local-tools.test.ts) | 30 | 30 | 30 / 0 / 0 | 695 |
| [packages/cli/test/login.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/login.test.ts) | 6 | 6 | 6 / 0 / 0 | 179 |
| [packages/cli/test/main-health.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/main-health.test.ts) | 1 | 1 | 1 / 0 / 0 | 28 |
| [packages/cli/test/main.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/main.test.ts) | 6 | 9 | 9 / 0 / 0 | 126 |
| [packages/cli/test/merge.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/merge.test.ts) | 18 | 42 | 42 / 0 / 0 | 956 |
| [packages/cli/test/opencode-model.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/opencode-model.test.ts) | 6 | 6 | 6 / 0 / 0 | 101 |
| [packages/cli/test/output.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/output.test.ts) | 2 | 4 | 4 / 0 / 0 | 79 |
| [packages/cli/test/peek.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/peek.test.ts) | 11 | 12 | 12 / 0 / 0 | 542 |
| [packages/cli/test/presence.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/presence.test.ts) | 2 | 6 | 6 / 0 / 0 | 76 |
| [packages/cli/test/process.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/process.test.ts) | 2 | 2 | 2 / 0 / 0 | 77 |
| [packages/cli/test/release.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/release.test.ts) | 5 | 6 | 6 / 0 / 0 | 111 |
| [packages/cli/test/repo.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/repo.test.ts) | 2 | 2 | 2 / 0 / 0 | 54 |
| [packages/cli/test/reserve.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/reserve.test.ts) | 3 | 3 | 3 / 0 / 0 | 105 |
| [packages/cli/test/review-runtime.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/review-runtime.test.ts) | 1 | 1 | 1 / 0 / 0 | 40 |
| [packages/cli/test/runtime-adapters.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/runtime-adapters.test.ts) | 12 | 14 | 14 / 0 / 0 | 631 |
| [packages/cli/test/runtime.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/runtime.test.ts) | 18 | 27 | 27 / 0 / 0 | 590 |
| [packages/cli/test/secrets.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/secrets.test.ts) | 14 | 14 | 14 / 0 / 0 | 337 |
| [packages/cli/test/skills.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/skills.test.ts) | 1 | 1 | 1 / 0 / 0 | 51 |
| [packages/cli/test/spec.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/spec.test.ts) | 8 | 8 | 8 / 0 / 0 | 172 |
| [packages/cli/test/upgrade.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/upgrade.test.ts) | 8 | 12 | 12 / 0 / 0 | 167 |
| [packages/cli/test/watch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/watch.test.ts) | 19 | 26 | 26 / 0 / 0 | 772 |
| [packages/cli/test/worker.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/worker.test.ts) | 23 | 29 | 29 / 0 / 0 | 726 |
| [packages/core/test/activity.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/activity.test.ts) | 3 | 3 | 3 / 0 / 0 | 156 |
| [packages/core/test/armada-api.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/armada-api.test.ts) | 9 | 9 | 9 / 0 / 0 | 236 |
| [packages/core/test/attachments.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/attachments.test.ts) | 3 | 3 | 3 / 0 / 0 | 36 |
| [packages/core/test/brief.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/brief.test.ts) | 1 | 1 | 1 / 0 / 0 | 41 |
| [packages/core/test/catchup.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/catchup.test.ts) | 11 | 11 | 11 / 0 / 0 | 194 |
| [packages/core/test/ci.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/ci.test.ts) | 15 | 35 | 35 / 0 / 0 | 378 |
| [packages/core/test/config.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/config.test.ts) | 23 | 23 | 23 / 0 / 0 | 475 |
| [packages/core/test/credentials.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/credentials.test.ts) | 5 | 5 | 5 / 0 / 0 | 89 |
| [packages/core/test/dashboard-facts.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/dashboard-facts.test.ts) | 4 | 4 | 4 / 0 / 0 | 109 |
| [packages/core/test/deferred-launch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/deferred-launch.test.ts) | 5 | 5 | 5 / 0 / 0 | 221 |
| [packages/core/test/deploy.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/deploy.test.ts) | 9 | 9 | 9 / 0 / 0 | 264 |
| [packages/core/test/digest.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/digest.test.ts) | 2 | 2 | 2 / 0 / 0 | 82 |
| [packages/core/test/dotenv.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/dotenv.test.ts) | 3 | 3 | 3 / 0 / 0 | 45 |
| [packages/core/test/fleet-api.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/fleet-api.test.ts) | 22 | 22 | 22 / 0 / 0 | 956 |
| [packages/core/test/fleet.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/fleet.test.ts) | 15 | 15 | 15 / 0 / 0 | 412 |
| [packages/core/test/github.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/github.test.ts) | 13 | 14 | 14 / 0 / 0 | 286 |
| [packages/core/test/heartbeat.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/heartbeat.test.ts) | 6 | 8 | 8 / 0 / 0 | 236 |
| [packages/core/test/herdr-profile.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/herdr-profile.test.ts) | 4 | 4 | 4 / 0 / 0 | 94 |
| [packages/core/test/http.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/http.test.ts) | 8 | 8 | 8 / 0 / 0 | 317 |
| [packages/core/test/inbox.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/inbox.test.ts) | 16 | 21 | 21 / 0 / 0 | 767 |
| [packages/core/test/insights.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/insights.test.ts) | 16 | 16 | 16 / 0 / 0 | 431 |
| [packages/core/test/jobs.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/jobs.test.ts) | 5 | 5 | 5 / 0 / 0 | 138 |
| [packages/core/test/labels.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/labels.test.ts) | 4 | 4 | 4 / 0 / 0 | 156 |
| [packages/core/test/linear-write.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/linear-write.test.ts) | 8 | 8 | 8 / 0 / 0 | 324 |
| [packages/core/test/linear.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/linear.test.ts) | 16 | 16 | 16 / 0 / 0 | 452 |
| [packages/core/test/lint.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/lint.test.ts) | 4 | 4 | 4 / 0 / 0 | 74 |
| [packages/core/test/machine.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/machine.test.ts) | 6 | 6 | 6 / 0 / 0 | 182 |
| [packages/core/test/merge.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/merge.test.ts) | 53 | 80 | 80 / 0 / 0 | 1374 |
| [packages/core/test/npm.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/npm.test.ts) | 6 | 6 | 6 / 0 / 0 | 97 |
| [packages/core/test/overlap.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/overlap.test.ts) | 1 | 1 | 1 / 0 / 0 | 27 |
| [packages/core/test/overview.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/overview.test.ts) | 13 | 13 | 13 / 0 / 0 | 464 |
| [packages/core/test/owner-items.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/owner-items.test.ts) | 1 | 1 | 1 / 0 / 0 | 75 |
| [packages/core/test/phases.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/phases.test.ts) | 5 | 5 | 5 / 0 / 0 | 123 |
| [packages/core/test/plans.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/plans.test.ts) | 10 | 16 | 16 / 0 / 0 | 220 |
| [packages/core/test/redact.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/redact.test.ts) | 6 | 6 | 6 / 0 / 0 | 102 |
| [packages/core/test/requests.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/requests.test.ts) | 4 | 4 | 4 / 0 / 0 | 195 |
| [packages/core/test/routing.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/routing.test.ts) | 7 | 7 | 7 / 0 / 0 | 175 |
| [packages/core/test/runtime-state.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/runtime-state.test.ts) | 8 | 8 | 8 / 0 / 0 | 398 |
| [packages/core/test/setup.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/setup.test.ts) | 17 | 17 | 17 / 0 / 0 | 423 |
| [packages/core/test/skills.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/skills.test.ts) | 2 | 2 | 2 / 0 / 0 | 33 |
| [packages/core/test/specs.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/specs.test.ts) | 7 | 7 | 7 / 0 / 0 | 124 |
| [packages/core/test/status.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/status.test.ts) | 13 | 13 | 13 / 0 / 0 | 435 |
| [packages/core/test/timeline.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/timeline.test.ts) | 15 | 15 | 15 / 0 / 0 | 272 |
| [packages/core/test/validations.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/validations.test.ts) | 8 | 8 | 8 / 0 / 0 | 310 |
| [packages/core/test/watch.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/watch.test.ts) | 23 | 23 | 23 / 0 / 0 | 715 |
| [packages/core/test/worker.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/worker.test.ts) | 21 | 22 | 22 / 0 / 0 | 461 |
| [packages/dashboard/test/accounts.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/accounts.test.ts) | 10 | 10 | 10 / 0 / 0 | 357 |
| [packages/dashboard/test/activity-store.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/activity-store.test.ts) | 10 | 10 | 10 / 0 / 0 | 295 |
| [packages/dashboard/test/activity-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/activity-view.test.ts) | 7 | 7 | 7 / 0 / 0 | 132 |
| [packages/dashboard/test/announce.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/announce.test.ts) | 6 | 6 | 6 / 0 / 0 | 71 |
| [packages/dashboard/test/attachments.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/attachments.test.ts) | 6 | 6 | 6 / 0 / 0 | 163 |
| [packages/dashboard/test/auth.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/auth.test.ts) | 14 | 14 | 14 / 0 / 0 | 186 |
| [packages/dashboard/test/cli-api.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/cli-api.test.ts) | 13 | 13 | 13 / 0 / 0 | 463 |
| [packages/dashboard/test/cli-fleet.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/cli-fleet.test.ts) | 20 | 20 | 20 / 0 / 0 | 972 |
| [packages/dashboard/test/cli-version.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/cli-version.test.ts) | 4 | 4 | 4 / 0 / 0 | 136 |
| [packages/dashboard/test/clock-readings.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/clock-readings.test.ts) | 1 | 4 | 4 / 0 / 0 | 19 |
| [packages/dashboard/test/contrast.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/contrast.test.ts) | 5 | 5 | 5 / 0 / 0 | 116 |
| [packages/dashboard/test/coordinator-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/coordinator-view.test.ts) | 17 | 17 | 17 / 0 / 0 | 330 |
| [packages/dashboard/test/coordinators.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/coordinators.test.ts) | 4 | 4 | 4 / 0 / 0 | 228 |
| [packages/dashboard/test/dashboard-facts.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/dashboard-facts.test.ts) | 3 | 3 | 3 / 0 / 0 | 204 |
| [packages/dashboard/test/demo-world.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/demo-world.test.ts) | 6 | 6 | 6 / 0 / 0 | 129 |
| [packages/dashboard/test/deploy-store.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/deploy-store.test.ts) | 5 | 5 | 5 / 0 / 0 | 168 |
| [packages/dashboard/test/fleet-data.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fleet-data.test.ts) | 20 | 20 | 20 / 0 / 0 | 994 |
| [packages/dashboard/test/fleet-store.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fleet-store.test.ts) | 17 | 17 | 17 / 0 / 0 | 867 |
| [packages/dashboard/test/fleet-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fleet-view.test.ts) | 9 | 9 | 9 / 0 / 0 | 140 |
| [packages/dashboard/test/fonts.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fonts.test.ts) | 4 | 4 | 4 / 0 / 0 | 93 |
| [packages/dashboard/test/github-app.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/github-app.test.ts) | 5 | 5 | 5 / 0 / 0 | 217 |
| [packages/dashboard/test/github-install.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/github-install.test.ts) | 4 | 4 | 4 / 0 / 0 | 134 |
| [packages/dashboard/test/icons.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/icons.test.ts) | 2 | 2 | 2 / 0 / 0 | 47 |
| [packages/dashboard/test/insights-store.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/insights-store.test.ts) | 2 | 2 | 2 / 0 / 0 | 176 |
| [packages/dashboard/test/insights-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/insights-view.test.ts) | 2 | 2 | 2 / 0 / 0 | 58 |
| [packages/dashboard/test/jobs-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/jobs-view.test.ts) | 1 | 1 | 1 / 0 / 0 | 75 |
| [packages/dashboard/test/keyboard.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/keyboard.test.ts) | 5 | 5 | 5 / 0 / 0 | 41 |
| [packages/dashboard/test/landing.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/landing.test.ts) | 13 | 13 | 13 / 0 / 0 | 183 |
| [packages/dashboard/test/live-http.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/live-http.test.ts) | 2 | 2 | 2 / 0 / 0 | 43 |
| [packages/dashboard/test/migrations.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/migrations.test.ts) | 1 | 3 | 3 / 0 / 0 | 66 |
| [packages/dashboard/test/notify.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/notify.test.ts) | 2 | 2 | 2 / 0 / 0 | 69 |
| [packages/dashboard/test/overview-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/overview-view.test.ts) | 8 | 8 | 8 / 0 / 0 | 260 |
| [packages/dashboard/test/owner-push.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/owner-push.test.ts) | 17 | 17 | 17 / 0 / 0 | 522 |
| [packages/dashboard/test/page-anatomy.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/page-anatomy.test.ts) | 12 | 19 | 19 / 0 / 0 | 195 |
| [packages/dashboard/test/perf.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/perf.test.ts) | 9 | 9 | 9 / 0 / 0 | 165 |
| [packages/dashboard/test/project-view.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/project-view.test.ts) | 5 | 5 | 5 / 0 / 0 | 140 |
| [packages/dashboard/test/reservations.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/reservations.test.ts) | 6 | 6 | 6 / 0 / 0 | 253 |
| [packages/dashboard/test/runtime-state.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/runtime-state.test.ts) | 2 | 2 | 2 / 0 / 0 | 134 |
| [packages/dashboard/test/search.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/search.test.ts) | 11 | 11 | 11 / 0 / 0 | 399 |
| [packages/dashboard/test/secrets.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/secrets.test.ts) | 6 | 6 | 6 / 0 / 0 | 286 |
| [packages/dashboard/test/vault.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/vault.test.ts) | 6 | 6 | 6 / 0 / 0 | 372 |
| [packages/dashboard/test/webhooks.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/webhooks.test.ts) | 10 | 10 | 10 / 0 / 0 | 295 |
| [packages/dashboard/test/workers.test.ts](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/workers.test.ts) | 11 | 11 | 11 / 0 / 0 | 522 |
| [.agents/skills/review-code-dev/scripts/test_ocr.py](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/.agents/skills/review-code-dev/scripts/test_ocr.py) | 6 | 6 | 6 / 0 / 0 | 97 |
| [.agents/skills/ship-pr-dev/scripts/test_collect_ship_context.py](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/.agents/skills/ship-pr-dev/scripts/test_collect_ship_context.py) | 7 | 7 | 7 / 0 / 0 | 85 |
| [.agents/skills/ship-pr-dev/scripts/test_prepare_ship_run.py](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/.agents/skills/ship-pr-dev/scripts/test_prepare_ship_run.py) | 1 | 1 | 1 / 0 / 0 | 29 |

## Production-owner lanes and keeper plans

| Lane | Files | Declarations | R | F | C | D |
|---|---:|---:|---:|---:|---:|---:|
| core | 45 | 454 | 431 | 7 | 16 | 0 |
| cli | 42 | 399 | 391 | 6 | 2 | 0 |
| dashboard-api | 24 | 198 | 191 | 7 | 0 | 0 |
| dashboard-ui | 16 | 110 | 100 | 6 | 4 | 0 |
| skills-tooling | 11 | 64 | 57 | 5 | 1 | 1 |

# Core layer plan at pinned main 4fb197721bc05993e07acd935c9697b40741daf4

45 files, 454 source declarations: 431 retain, seven fix, 16 consolidate, zero delete. The audit expands every parameterized table in its reasoning, while the ledger has one row per source declaration (including merge.test.ts:274’s dynamic table). The shared pinned baseline was green: 1,372 runtime cases across 135 Bun files. Later main changes, including #224, are outside this ledger and must be inventoried by THE-1146.

This was a second read-only ownership pass over the complete assigned tests, their imported production owners and relevant implementations/call sites, recent file history and CI routing. No test/source/Git mutation belongs to this lane. All R rows in the complete declaration ledger below state their own assertions and credible regression; this plan names the owner keepers and the boundary each group preserves. F/C candidate details appear below.

Use the lowest real contract boundary: pure derivations for frontier/flow/metrics and parser rules; recorded fetch for network serialization, completeness and retry semantics; FakeLinear for authoritative tracker writes; the fake fleet API over memoryFleet for CLI-to-server authorization and lifecycle; injected clock/sleep for polling/leases. Dashboard PGlite tests remain the owner of SQL atomicity and persistence, not replacements for core admission and generation policy. Node22 tarball smoke owns bundle/runtime compatibility, not these business rules.

| File / production owner keeper | Representative retained declaration | Contract / production consumers |
|---|---|---|
| `packages/core/test/activity.test.ts` | `:55` a run from launch to hand-back, newest first, each report once | Agent history deduplication, claim fallback and questions/answers; CLI peek/dashboard Agent reads. |
| `packages/core/test/armada-api.test.ts` | `:13` Armada retries only safe reads, including fleet reads; token consumption and fleet writes are sent once | HTTP/session/device authorization, CLI compatibility and retry policy; CLI credential/project/fleet adapters. |
| `packages/core/test/attachments.test.ts` | `:8` images are byte-sniffed and limited; links require HTTPS | Byte/type/size and safe HTTPS admission; CLI attach and fleet attachment route. |
| `packages/core/test/brief.test.ts` | `:5` the Plan line includes the explicit launch reason while needs-approval keeps precedence | Explicit pre-approval reason and needs-approval precedence; launch prompt consumed by runtimes. |
| `packages/core/test/catchup.test.ts` | `:29` starts a new one after more than 30 minutes away, from when they were last seen | Visit windows, dismissal and summary derivation; dashboard visit/since API routes. |
| `packages/core/test/ci.test.ts` | `:21` bun failure names tests and first error; disk-full is a runner problem | Runner-neutral diagnostics, tracked flaky retry admission and workflow-attempt fencing; CLI ci why. |
| `packages/core/test/config.test.ts` | `:16` spec title styles default to N, accept totals explicitly, and reject other values | All TOML defaults, invariants and unknown-key validation; repository-wide configuration boundary. |
| `packages/core/test/credentials.test.ts` | `:5` GitHub falls back from GITHUB_TOKEN to GH_TOKEN to the gh login, which is asked only when needed | Environment/API/machine key precedence and safe fallback; every CLI authenticated read. |
| `packages/core/test/dashboard-facts.test.ts` | `:9` one recorded forge call carries files, exact totals, mergeability and completeness | Recorded forge totals/completeness, aggregate health and hand-back actions; dashboard status overview. |
| `packages/core/test/deferred-launch.test.ts` | `:38` deferred launches wait for every blocker in the stored reading, wake with a stable id and clear on claim | Persisted blocker/launch scope, stable wake id and single consume; dashboard requests/CLI launch. |
| `packages/core/test/deploy.test.ts` | `:20` old, old, new deploy runs smoke once and records failure with last output | Ancestry-aware deploy state, injected deadline/smoke lease and output bounds; CLI deploy and merge followup. |
| `packages/core/test/digest.test.ts` | `:5` digest reads and sends reject worker sessions; sends without a configured channel explain the next step | Worker authorization plus English/French owner text, preserved titles/links and qualified estimates; CLI/channel digest. |
| `packages/core/test/dotenv.test.ts` | `:4` reads shell-style assignments; the last duplicate wins; broken lines are reported by number only | Independent value round-trips, safe shell quoting and preservation of unknown/comments; secrets export/set. |
| `packages/core/test/fleet-api.test.ts` | `:30` masks prose from older clients, using injected project values plus patterns | Client/server transport shape, worker session scope, server-time writes and exact generation guards; all CLI fleet operations. |
| `packages/core/test/fleet.test.ts` | `:17` a closed blocker reveals ready, unspecified, parked and still-blocked dependents | Ready frontier, outside-program blockers, closed states, merge/unblocked and main-health derivation; buildStatus/buildOverview. |
| `packages/core/test/github.test.ts` | `:42` combines classic and active requirements without duplicate checks or weakening approvals | Recorded GraphQL/REST reads, pagination/completeness, reviews/checks, policies and pinned writes; CLI/dashboard forge adapters. |
| `packages/core/test/heartbeat.test.ts` | `:21` the API uses server time and current worker identity, rejects other tickets and stale claims | Pinned claim heartbeat schedule, parent/session termination and separation of report/liveness; background worker heartbeat. |
| `packages/core/test/herdr-profile.test.ts` | `:19` adds each native full-permission flag once and keeps unrelated arguments | Native permission flags, idempotent profile edits and preserved comments/unrelated arguments; CLI local setup and launch. |
| `packages/core/test/http.test.ts` | `:7` caller cancellation inside a transport wrapper is not retried as a deadline | Bounded retry/cancellation/deadline, safe versus guarded write behavior; all network adapters. |
| `packages/core/test/inbox.test.ts` | `:48` mine resolves ticket ownership before filtering entries, flight and ETags | Questions/answers, named ownership, liveness, stale completion repair and ETag polling; CLI inbox/watch. |
| `packages/core/test/insights.test.ts` | `:71` counts merges per UTC day of the range, and the previous period's | Cycle/daily/week/wait/silence metrics, prior-period and owner estimates; dashboard insights/digest. |
| `packages/core/test/jobs.test.ts` | `:11` parses the last status line and estimates completion from elapsed progress | Job output parsing, durable scoped state and observation fencing; CLI runner jobs/dashboard JobStrip. |
| `packages/core/test/labels.test.ts` | `:21` the program's team group wins over a shared one, another team's is ignored, and gaps are named | Team/workspace label precedence, gap diagnostics and configured plan labels; init/doctor. |
| `packages/core/test/linear-write.test.ts` | `:26` looks up an ungrouped label by name in the ticket's team, then the workspace | Single authoritative write adapter, team label lookup, payloads and no unsafe replay; worker/specs commands. |
| `packages/core/test/linear.test.ts` | `:18` status lines accept any dash and markdown, map legacy words, and reject unknown phases | Program tree and relation/comment pagination, status parsing and completeness; all tracker reads. |
| `packages/core/test/lint.test.ts` | `:16` readable tickets and both spec formats pass; only the spec name counts toward the limit | Configured readable ticket sections, fenced-example handling and actionable diagnostics; launch readability gate. |
| `packages/core/test/machine.test.ts` | `:25` release reservations serialize commands, remember time, and recover a dead holder | Permissions/atomic credentials and scoped lock/watch/reservation persistence; CLI per-machine state. |
| `packages/core/test/merge.test.ts` | `:274` checklist matrix (dynamic name table) | Pure checklist/lineage plus pinned mutation, leases, waits, uncertain outcome repair, cleanup and deploy holds; coordinator merge. |
| `packages/core/test/npm.test.ts` | `:12` uses abbreviated metadata and verifies the newest stable tarball no higher than the build | Stable release metadata AND tarball availability; API release announcements/upgrade. |
| `packages/core/test/overlap.test.ts` | `:4` declared paths compare files and globs conservatively, and never hide incomplete readings | Conservative file/glob intersection and incomplete-reading warning; launch/report plan path warnings. |
| `packages/core/test/overview.test.ts` | `:69` an approval shows the full plan, its actionable inbox id and any pending answer request | Owner waiting actions, named coordinator facts and public flow/history/health projection; dashboard fleet read. |
| `packages/core/test/owner-items.test.ts` | `:41` fire for a validation to decide, a question escalated to the owner and a stopped coordinator with items waiting | Shared owner validation/question/coordinator-stop keys and links; webhook push and overview helper reexports. |
| `packages/core/test/phases.test.ts` | `:8` [policy] plans decides, a ticket label overrides it, and asking for approval wins over pre-approval | Full transition table, plan label precedence and hand-back gate; worker claim/report/validate. |
| `packages/core/test/plans.test.ts` | `:33` a plan reaches the coordinator with its full text and handle, once per approval transition | Full plan persistence, literal plan blocks, pre-approval and answer/request lifecycle; report/answer/dashboard approval. |
| `packages/core/test/redact.test.ts` | `:18` names exact values, prefers known values over patterns, merges overlaps and skips short values | Independent masking, overlap selection, stream splits, unicode and routing-preserving prose; CLI/server redaction. |
| `packages/core/test/requests.test.ts` | `:52` the answer waits in the coordinator's inbox until it is delivered; then the question and the request close | Owner answer/launch/decision request validation, idempotence and cleanup; dashboard actions/coordinator inbox. |
| `packages/core/test/routing.test.ts` | `:17` plain-language rules defer unmatched tickets to the coordinator, even with a default or only profile | Unicode/order matching, semantic reasons and explicit override; brief/claim/status. |
| `packages/core/test/runtime-state.test.ts` | `:21` organization operations target an exact claim, use server time, and allow archiving an already released claim | Exact claim observations, TTL/sequence/idle/working liveness and archived filtering; status/inbox/runtime adapters. |
| `packages/core/test/setup.test.ts` | `:24` matching gates, signatures, linear history and up-to-date rules allow squash merges | Repository gates, minimally invasive init, skill drift, lock safety and stop-hook joining; CLI doctor/init. |
| `packages/core/test/specs.test.ts` | `:17` append in N style leaves every legacy title alone and includes the In short template | Stable N versus N/M numbering and safe write plans plus status projection; CLI spec add/renumber. |
| `packages/core/test/status.test.ts` | `:8` mine filters owned work after full derivation and retains the whole frontier with launch owners | Recorded adapter composition, optional forge outages, owned flight, ready routes, recent merges and main health; CLI/dashboard reads. |
| `packages/core/test/timeline.test.ts` | `:46` heartbeats keep the session line alive without adding report dots or advancing phases | Deduplicated history, phase/liveness, bounded tracks and coordinator state; overview public track and flow derivation. |
| `packages/core/test/validations.test.ts` | `:40` a worker submits its design: awaiting-validation with the link, on the owner's page; a resubmission replaces it | Worker work/owner decisions, supersession, approved design closure and reviewed-head merge approval; validate/ask-owner/done/merge. |
| `packages/core/test/watch.test.ts` | `:58` the coordinator's own session is not a worker, and a new worker changes the etag | Coordinator watch ETags, rearm/stop-hook decisions, runtime observations, holds and deploy silence; CLI watch and hooks. |
| `packages/core/test/worker.test.ts` | `:39` claims the ticket in Linear and records the handle and the event through Armada | Claim races/repair, allowed phase/report/handback changes and guarded release under partial outages; worker protocol. |


Keep every other R declaration in each file as the keeper of the independently stated contract in its ledger row. The representative column is a navigation aid, not permission to collapse a file to its first test. In particular, worker scope, unsafe write replay, incomplete remote readings, exact generation cleanup, forked ownership and outcome recovery are separate safety behaviors despite shared fixtures.

Carried assertions and retired files: no entire core file retires under this plan. Consolidation carries all C rows into the named keeper first, then retires just those 16 declarations. Config receives attachment, deploy, jobs and known-failure policy tables; config’s parked-label case joins its default/override table. API, inbox, plans, routing, catchup and merge consolidate duplicate invocations with independent fixture rows. Retain the public quantile and compareVersions helper tests at their cheap scalar owner boundaries; their independent literal API oracles are not replaced by aggregate metrics or release selection. No redundant stronger layer is established.

Repair the seven F owners before any associated cuts. Redaction literals and missing deploy-ancestry coverage are the highest-priority weak oracles. Worker transport scope, pinned heartbeat retry and design closure need asserted input/effect facts. Pointer setup should use independent metadata/path facts. Merge serialization should retain deterministic contention with a barrier rather than a real timer. The current green suite is evidence that these missing oracles are coverage gaps, not evidence of a detected failing product.

Cross-lane layer move: core owner-items.test.ts retains composed ownerItems URLs, decided filtering, stable stop keys and ordinary-worker suppression. Before dashboard overview-view helper tests retire, carry absent-validations fallback and multi-project oldest/coordinator-count fixtures into this core owner. Browser notification title, quiet-hours and suppression remain dashboard transport keepers.

Production seams unlocked: none confirmed. compareVersions, quantile, attachmentImageType, globToRegExp, pointerText, pipeline and coordinatorTrack all have production callers or exported compatibility surfaces. pipeline remains used for emitted overview data and sorting; coordinatorTrack remains called by overview. showSummary still serves dashboard visit/since routes. Screen removal alone therefore does not justify deleting their core rules. Synthetic FakeLinear/memoryFleet/recorded fetch remain essential adapter substitutes; no production branch or injected dependency was identified as test-only deletion material.

Conservative uncertainty: C marks are contingent migration candidates, not immediate cuts. Root-query versus relation timeout must retain service-context evidence; plan versus question polling must retain distinct entry-kind keys; question-only release must be carried rather than assumed equivalent to owner-request cleanup; emitted historical APIs require explicit compatibility decisions. No broad integration test is removed merely because a pure helper assertion exists. No D is justified at this pin.

Focused validation is listed per candidate. After future edits, run those owner/keeper files, then bun run verify. Full verify is the single CI lint/type/test gate; packed Node22 smoke and dashboard build/a11y/performance are separate jobs. No network calls or wall-clock waits should be added by the follow-up.

## Relevant last-change history at the pin

These commits establish why the contracts exist; recency alone is never grounds for retention or deletion. The candidate table ties each conditional consolidation to its proposed keeper; retained helper false positives are explained separately.

| Test owner | Latest relevant file commit |
|---|---|
| `activity.test.ts` | c6298b1 feat(dashboard): show every agent and each agent's page (#86) |
| `armada-api.test.ts` | 4322b3a feat(jobs): track long jobs on project runners (#219) |
| `attachments.test.ts` | d03b5cc feat(attachments): let agents privately attach screenshots and links (#103) |
| `brief.test.ts` | 5f634f2 feat(cli): pre-approve plans at launch (#200) |
| `catchup.test.ts` | 2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188) |
| `ci.test.ts` | daf007f feat(ci): rerun tracked flaky failures once per workflow (#230) |
| `config.test.ts` | daf007f feat(ci): rerun tracked flaky failures once per workflow (#230) |
| `credentials.test.ts` | 69a60ab feat(cli)!: reach the fleet's live data only through the Armada API (#55) |
| `dashboard-facts.test.ts` | 01afa00 feat(dashboard): a clear overview and a live fleet that scrolls back 24 h (#98) |
| `deferred-launch.test.ts` | 0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228) |
| `deploy.test.ts` | 4fb1977 feat(deploy): check merged deploys and pause on failure (#237) |
| `digest.test.ts` | c42c298 feat(dashboard): send scheduled owner fleet digests (#225) |
| `dotenv.test.ts` | 69a60ab feat(cli)!: reach the fleet's live data only through the Armada API (#55) |
| `fleet-api.test.ts` | fceaf43 feat(secrets): mask worker output and messages (#239) |
| `fleet.test.ts` | 11ee2fa feat(fleet): show when main is red and which merge broke it (#204) |
| `github.test.ts` | 00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236) |
| `heartbeat.test.ts` | 1249b4c feat(fleet): distinguish code review from CI while shipping (#176) |
| `herdr-profile.test.ts` | a32c262 feat(cli): set up local harnesses and explain first-run questions (#160) |
| `http.test.ts` | 527a4ee fix(core): retry temporary Linear, GitHub and Armada failures (#210) |
| `inbox.test.ts` | a5823d8 feat(cli): scope named coordinators to their own work (#243) |
| `insights.test.ts` | 8466d22 feat(dashboard): build the Night watch look across the dashboard (#128) |
| `jobs.test.ts` | 141e2d7 feat(dashboard): show a ticket's long jobs on its session page and the overview (#235) |
| `labels.test.ts` | 374bf6a fix(core): create configured plan labels during init (#233) |
| `linear-write.test.ts` | 5f634f2 feat(cli): pre-approve plans at launch (#200) |
| `linear.test.ts` | f5ff024 feat(cli): check ticket readability before launch (#238) |
| `lint.test.ts` | f5ff024 feat(cli): check ticket readability before launch (#238) |
| `machine.test.ts` | 0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228) |
| `merge.test.ts` | 4fb1977 feat(deploy): check merged deploys and pause on failure (#237) |
| `npm.test.ts` | 61d5b8d fix(api): announce CLI releases only after npm serves their tarballs (#113) |
| `overlap.test.ts` | ccc3133 feat(cli): warn workers when planned paths overlap files in flight (#223) |
| `overview.test.ts` | 783cc8d feat(dashboard): show which coordinator owns each session (#241) |
| `owner-items.test.ts` | 47b62cf feat(dashboard): send owner alerts to a chat webhook (#212) |
| `phases.test.ts` | 802ceb9 feat: ask the owner to validate only what they want, on one Validations page (#108) |
| `plans.test.ts` | 5f634f2 feat(cli): pre-approve plans at launch (#200) |
| `redact.test.ts` | fceaf43 feat(secrets): mask worker output and messages (#239) |
| `requests.test.ts` | ba22466 feat(dashboard): show every project and each project's page (#83) |
| `routing.test.ts` | dc46b9c feat(cli): launch local workers through herdr (#140) |
| `runtime-state.test.ts` | df8f084 feat(fleet): check Conductor sessions before silence alarms (#213) |
| `setup.test.ts` | 00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236) |
| `specs.test.ts` | 6f544bb feat(cli): add specs without renaming every other spec (#206) |
| `status.test.ts` | a5823d8 feat(cli): scope named coordinators to their own work (#243) |
| `timeline.test.ts` | 9ced0b7 fix(core): renew worker liveness after waiting turns (#161) |
| `validations.test.ts` | 802ceb9 feat: ask the owner to validate only what they want, on one Validations page (#108) |
| `watch.test.ts` | 4fb1977 feat(deploy): check merged deploys and pause on failure (#237) |
| `worker.test.ts` | 0ab9035 feat(ci): explain failed checks and runner problems (#208) |

History limit: inspected pinned file history and recent contract changes. A parent deep git log -S scan hit an unavailable promisor object, so no claim of exhaustive prehistory is made; the pinned tree and ordinary recent file logs were readable.

## CLI lane: owner and layer plan

Pinned reading: `4fb197721bc05993e07acd935c9697b40741daf4`. Read all 42 assigned files, their full tables and fixtures, primary production owners, dispatch/entry wiring, native adapters and relevant history. Ledger: 399 source declarations, 391 R, 6 F, 2 C, 0 D. Parameter rows are covered by their enclosing declaration. The typed `test.each` at worker.test.ts:457 is included. Baseline supplied by the root audit is green; these findings are proof gaps or duplication, not reproduced product failures.

The CLI owns parsing, command scope, serialization, terminal messages, credential persistence, shell/stdin/stdout, native tool protocols and runtime side effects. Core retains phase/fleet/merge/config semantics; using the same scenario at the CLI is justified where an assertion proves dispatch, auth selection, native argv or output that core cannot observe. Runtime tests using literal protocol argv protect public/native boundaries; they are not rejected just for matching an array. `Io`, injected clocks, `recordedFetch`, `fakeArmada`, `FakeLinear` and `memoryFleet` remain legitimate adapter boundaries. Native subprocess tests are retained for Node/Bun/stdin/stdout contracts; fake `Io` alone cannot prove kernel pipe EOF/drain behavior.

CI routing: `.github/workflows/ci.yml` verify job runs `bun test` without path filters, so all 42 files run on every PR. The package job packs the single Node22 bundle and checks version/help/doctor. That smoke job does not prove large Unicode drain, runtime protocols or command ownership. Dashboard build, browser accessibility and performance jobs own separate contracts.

### Owners, entry points, callers and keepers

All public commands enter `bin.ts -> main.ts -> cli.ts:run/dispatch`; human output and JSON are owned here, and primary read adapters come through `apiOf`/core. Per-file latest commit metadata is provided by the root audit; the candidate history below is additionally inspected with log/blame/commit descriptions.

| Owned test files | Production owners and real caller/callee chain | Layer keepers and carried assertions |
| --- | --- | --- |
| `cli.test.ts`, `main-health.test.ts` | `cli.ts:parseArgs/findConfig/status/run`, `render.ts:renderStatus`, `projects.ts:statusAll`; dispatch calls core loadStatus and worker statusLive | `cli.test.ts` retains config precedence, argv/help, exit/recovery, actual JSON/human command rendering and all-project credential selection. `main-health.test.ts:6` retains pure rendered main status. Consolidate missing-key recovery only after all assertions and both fixture cases reach the canonical CLI error table. |
| `auth.test.ts`, `keys.test.ts`, `login.test.ts` | `auth.ts:loadCredentials/authLogin/authStatus/authLogout`, `login.ts:login/whoami/logout/sessionHandle`, core credentials/machine/API | `auth.test.ts` retains actual temporary 0600 machine file, prompt input and stored Linear precedence; `keys.test.ts` retains scoped worker/organization broker selection and optional availability; `login.test.ts` retains device/API-key/URL-bound identity/output/logout. Core credentials.test.ts:52 keeps sign-in precedence. |
| `main.test.ts`, `output.test.ts`, `secrets.test.ts` | `main.ts` real stdin/output wiring, `spawn.ts`, `secrets.ts:runCommand/secretsCommand`, core stream redactor | `main.test.ts:84/:97/:104` keep real redirected/Unicode/delayed EOF proofs, `output.test.ts:61/:70` keeps bundle output draining and exit codes, `secrets.test.ts:119/:153/:176` keeps real masked stream/env delivery. Carry child env, split UTF8, both channels and process exit assertions. |
| `attach.test.ts` | `attach.ts:attachItems/attachCommand` also called by `validate.ts`; core attachment validations/API transport | Keep CLI metadata/scope/output and read-binary/file transport assertions. Keep file-backed proofs at CLI and content policy in core; no replacement layer established. |
| `brief.test.ts`, `conductor-launch.test.ts`, `launch.test.ts`, `local-launch.test.ts`, `deferred-launch.test.ts` | `brief.ts:brief/loadBrief`, `launch.ts:launch/launchWorker/launchPlan`, `plan-approval.ts:preparePreApproval`, `deferred-launch.ts`, `after-merge.ts`; runtimeFor selects native adapters | Keep prompt byte/notes/preapproval/reservation assertions, dispatch-selected profile, token lifecycle, exact stdin/native argv, runtime returned handles, recovery/no duplicate launch and real worker worktree config copy. Core brief/deferred launch rules stay in core; CLI validates actual delivery and lease/token ordering. |
| `herdr.test.ts`, `herdr-first-run.test.ts`, `first-run.test.ts`, `opencode-model.test.ts` | `herdr.ts:Herdr` called by HerdrAdapter, setupLocal, heartbeat/report; `first-run.ts:inspectFirstRun`, `opencode-model.ts:verifyOpenCodeModel` called before prompt/probe | Keep recorded native protocol/footer/setup-screen recognition, explicit permissions/argv, model/provider exact identity, sanitized error results, bounded injected readiness waits. Repair three error disclosure oracles before considering cuts. |
| `local-tools.test.ts`, `local-setup.test.ts`, `codex-models.test.ts` | `local-tools.ts:detectLocalTools/offerLocalInstalls/offerLocalModels/localHarnesses`, doctor localRuntimeChecks, launch ensureLocalProfile, setupLocal; `codex-models.ts` is main's model/list adapter | Keep exact installed account catalog, installer env/consent and config edit safety at CLI boundary. `localHarnesses` has real doctor and setup callers; retain its cloud-profile exclusion proof. `local-setup.test.ts:217` needs explicit noninteractive fixture in the existing declaration. |
| `runtime-adapters.test.ts`, `runtime.test.ts`, `peek.test.ts` | `runtimes/adapter.ts:runtimeFor/guarded/checkedMutation`, native Conductor/Herdr/guided adapters, `runtime.ts:observeRuntimes/deliverToRuntime/stop`, `peek.ts:peek`; inbox, worker status and afterMerge call these | `runtime-adapters.test.ts` keeps adapter protocol/provenance/generation fences; `runtime.test.ts` keeps public report/ask/answer/heartbeat/stop orchestration and recovery; `peek.test.ts` keeps cursor/cache/terminal/redaction/check output. They own different boundaries. Repair literal phase mapping oracle without losing native source/env/error checks. |
| `worker.test.ts`, `heartbeat.test.ts` | `worker.ts:claim/report/release/withContext/currentTicket/statusLive`, `inbox.ts:ask/inbox/answer`, `redact.ts`, `hold.ts`, `heartbeat.ts`; core worker/inbox semantics and fleet API | Keep argv/scoped auth and serialization/outgoing masking, optional fleet warnings, input file bytes, authenticated ownership, shipping path/stage, repeated paths, heartbeat parent/session stop. Core worker tests own transitions; CLI tests prove adapter wiring/exit/output. |
| `merge.test.ts`, `deploy.test.ts` | `merge.ts:merge/ghMerge/ghUpdateBranch/gitRepo`, `after-merge.ts:afterMerge`, `deploy.ts:deploy/startDeploys/recordDeploy`; core merge/deploy orchestrators | Keep exact pinned gh/git/shell protocol, selected checkout, throwaway worktree cleanup, CLI queue intent and output, sessions ended before watcher start, deploy command env/leases/recovery. Core owns merge gate decisions; CLI keeps destructive mutation and native/archive proof. |
| `watch.test.ts`, `process.test.ts`, `presence.test.ts`, `coordinator.test.ts` | `watch.ts:watch/watchUntil/stopWatch/hookStop/watchDeadline`, `process.ts`, `presence.ts:detectCoordinator/recordPresence`, `coordinator.ts`; status/inbox/merge feed watch machine state | Keep OS process identity before signaling, exact own lock cleanup, named-role scoping/cursors, real command presence facts and hook fail-open/required-version behavior. `watch.test.ts:695` keeps literal Node timer bound; it protects platform limit, not arbitrary implementation timing. |
| `release.test.ts`, `upgrade.test.ts` | `release.ts:noticeRelease/pendingRelease` called by run/watch, `upgrade.ts:upgrade` called after root/worker checks | `release.test.ts:90` owns actual worker-silence behavior; doctor does not substitute. Keep daily race/minimum-version/setup drift and upgraded binary/doctor/selected-root proof. Core machine storage tests own persistence format only. |
| `ci.test.ts`, `http.test.ts`, `digest.test.ts`, `job.test.ts`, `reserve.test.ts`, `spec.test.ts`, `lint.test.ts` | Matching CLI command modules plus core read/derive/write adapters; httpOptions passes bounded retry notices/waits through Io | Keep command-only key requirements, exact argv scopes/filters, output/exit/recovery, safe rerun native write boundaries, real runner dispatch env/id recovery, durable reservation/no fallback, spec apply ordering and warning-before-launch. Core owns parser/calculation semantics. |
| `repo.test.ts` | `repo.ts:fsRepoView/applyPlan` called by init/skills/doctor | Retain real filesystem symlink refusal and whole-plan preflight; pure setup-plan tests cannot observe external-target writes. |

Second-pass disposition: no whole CLI file retired. The two C declarations should be absorbed into one CLI configuration-error table before their declarations are removed. No source export, module, fake API, filesystem harness or support file is proven removable. Explicit `BindLaunch` in launch.ts is a test-only optional hook used by conductor-launch.test.ts for binding failure/recovery; its independent retained binding contract is not retired by any finding, so no seam removal is claimed. Other examined exports (`localHarnesses`, `herdrPhase`, `verifyOpenCodeModel`, `reportHerdr`, `noticeRelease`, `watchDeadline`, `gitRepo`) have real production callers. No additional test scaffolding is unlocked by the proposed rows. R declarations not singled out above remain keepers for the precise independent assertion/regression described in the ledger.

### Candidate evidence (follow-up only)

**C — packages/cli/test/auth.test.ts:194 — “with no key anywhere, the error names the variable and the login command”; C — packages/cli/test/cli.test.ts:382 — “LINEAR_API_KEY is required”.** Detected failure is the same public `run(["status"])` returning2 with `LINEAR_API_KEY is not set` and `armada auth login` recovery. Both reach cli.ts:status -> auth.ts:loadCredentials -> core resolveCredentials, then io.ts:missingKey; no caller depends on which test file owns the message. Candidate keeper: cli.test.ts:358 (“a missing armada.toml or a missing key is a configuration error naming what is missing”), expanded to include missing-key cases. It currently proves missing config and malformed config only, so deletion is conditional on carrying the exit2, complete missing-key message and terminal `Next` suffix, including empty actual temporary machine-store versus no-machine-store cases. Core credentials.test.ts:43 independently proves key discovery/message but does not replace CLI exit/recovery output. History: cli:382 comes from a6b5c9f (#1) and e69633c9 added recovery; auth:194 came from 6922151 (#2), 6095280 updated message for broker resolution. This is accreted command coverage, not evidence that credentials are obsolete. Deletion unlocked: exactly these two source declarations after absorption; no fixture/support/source deletion. Risk: collapsing the temporary-store scenario could hide filesystem fallback behavior; keep both fixture inputs in one canonical table rather than discarding an input. Focused validation: `bun test packages/cli/test/cli.test.ts packages/cli/test/auth.test.ts packages/core/test/credentials.test.ts`; then `bun run verify` when follow-up changes tests.

**F — packages/cli/test/herdr.test.ts:240 — “failures never echo a prompt or arbitrary herdr diagnostics”.** Actual detectable failures: native throw produces message containing `herdr agent prompt failed`; structured native error has `agent_blocked`. Test supplies `armada_launch_CANARY` and private prompt but checks only `rejects.toThrow` substrings, so an error retaining those substrings and appending the canary still passes. Non-test callers: Herdr.prompt <- Herdr.promptChecked <- HerdrAdapter.launchPrepared <- launchWorker, with worker token delivered here. Keeper: this declaration repaired to capture complete thrown Error and exclude token and private prompt for both exception and structured error variants, retaining failure classification; no equivalent exact native-error canary keeper shown elsewhere (launch output canary assertions protect another layer). History: dc46b9c (#140) introduced native launch and this row; sanitizer remains the purpose. Deletion unlocked: none; repair assertions only, no support/seam deletion. Risk of deletion: loss of last direct prompt native-error contract; risk of repair low. Focused validation: `bun test packages/cli/test/herdr.test.ts packages/cli/test/local-launch.test.ts`.

**F — packages/cli/test/herdr.test.ts:509 — “pane and metadata failures are sanitized, even when pane cleanup also fails”.** Actual detectable failures: metadata/pane read then cleanup failure yield `could not close worker pane` and `No worker brief was sent`. Canaries in provider error/private pane exception are never asserted absent from thrown error; suffix disclosure would pass. Non-test callers: Herdr.start/startChecked <- HerdrAdapter.launchPrepared and setupLocal; startup proof must precede token brief or token-free model probe. Keeper: repaired same declaration capturing full errors and checking each private canary absent, keeping both failure and cleanup variants. Other retained first-run/launch checks prove caller behavior and cannot prove this native error text never contains canary. History: 0c352ab (#159) preserved OpenCode model checks and introduced this assertion; 048492d (#165) switched to display/provider metadata, 89d50e8 (#173) adapted startup identity. None supports retiring sanitation. Deletion unlocked: none; no support/source seams. Risk: direct native startup disclosure proof lost if removed. Focused validation: `bun test packages/cli/test/herdr.test.ts packages/cli/test/local-setup.test.ts packages/cli/test/local-launch.test.ts`.

**F — packages/cli/test/opencode-model.test.ts:86 — “unavailable provider catalog fails closed without surfacing metadata”.** Actual detectable failure: catalog fetch throws private canary and verification rejects with `could not verify`; same substring still matches if metadata is appended. Non-test callers: verifyOpenCodeModel <- Herdr.start/startChecked/probeChecked (native startup and owner setup model verification). Keeper: repaired same focused model test captures complete failure text and excludes fixture canary while proving fail-closed result. Retained herdr startup tests exercise this through caller but their canary oracles are themselves F; no substitute proven. History: 048492d (#165) added this file after real model/provider footer mismatch and explicitly preserved fail-closed metadata errors; deterministic recorded native footer fixtures remain relevant. Deletion unlocked: none. Risk: privacy regression if dropped; fix adds meaningful independent oracle with low maintenance cost. Focused validation: `bun test packages/cli/test/opencode-model.test.ts packages/cli/test/herdr.test.ts`.

**F — packages/cli/test/runtime.test.ts:231 — “phase self-reporting uses Armada source, maps every phase, and is nonfatal”.** Actual detectable failures include missing/wrong native argv source/agent, native failure not remaining nonfatal and runtime-disabled call leaking through. Phase correctness is not independently detected: expected `herdrPhase(phase)` is the exact helper reportHerdr uses to produce actual state, so a mapper returning wrong state for awaiting-validation/ready-to-merge can satisfy both. Non-test callers: worker.ts:withContext -> reportHerdr for claim/report/ask outcomes and heartbeat.ts -> reportHerdr for liveness. Keeper: repair same table with literals: planning/implementing/shipping working; blocked/awaiting-approval/awaiting-validation blocked; ready-to-merge idle. runtime.test.ts:269 independently hardcodes shipping->working and ask->blocked only; :294/:326 cover scoped heartbeat/native question, not every phase. Keep its literal native source/agent/env gating, no-leak/nonfatal assertions. History: c811e71 (#143) introduced mapping/self reporting; db6dbb9 (#202) moved runtime orchestration into common adapters, 69c173f (#214) added ended-generation recovery without changing this same-helper oracle. Deletion unlocked: removal of test import dependency on herdrPhase only; export has real reportHerdr caller and remains. Risk: assertion drift against native protocol; literal mapping is the intended documented runtime vocabulary. Focused validation: `bun test packages/cli/test/runtime.test.ts packages/cli/test/heartbeat.test.ts packages/cli/test/worker.test.ts`.

**F — packages/cli/test/local-setup.test.ts:217 — “JSON and noninteractive setup never ask, save permissions, or start sessions”.** Actual detected contract is JSON readiness false and recovery, with no questions/writes/native calls. Fixture uses json:true and always interactive:true, so removing `!io.interactive` guard while preserving JSON guard passes this test. Non-test caller: cli.ts setup dispatch -> setupLocal; missing interaction must prevent owner permissions config changes/native harness starts. Keeper: same declaration should table explicit JSON and plain interactive:false cases at setupLocal boundary; retain all zero side-effect assertions and terminal-required recovery (human text for nonJSON). local-tools.test.ts readonly installer checks own different mutation entry and cannot protect setupLocal guard. History: a32c262 (#160) introduced command and row; commit promises noninteractive/JSON no runtime/config changes and notes Node smoke, so test's missing fixture is material to that feature. Deletion unlocked: none; existing fixture can expose mutable Io interactive flag, no new production seam needed. Risk: deletion loses current JSON barrier; meaningful table repair adds cheapest existing-boundary proof. Focused validation: `bun test packages/cli/test/local-setup.test.ts packages/cli/test/local-tools.test.ts`.

**F — packages/cli/test/login.test.ts:142 — “ARMADA_API_KEY in the environment signs in with nothing stored, and wins over a stored session”.** Actual detected contract: environment-only API key yields named key whoami output; logout reports env key still set. No persisted session is set in fixture, so the promised conflicting-session precedence is not exercised. Non-test caller: cli.ts whoami/logout -> login.ts -> auth.loadCredentials -> core resolveCredentials. Stronger keeper: core/test/credentials.test.ts:52 (“the Armada API is built in unless ARMADA_API_URL or [api] url names another; ARMADA_API_KEY beats the stored sign-in”) supplies both `stored-session` and `armada_stored` plus env `armada_env`, asserts literal API-key/source, and owns precedence at cheapest boundary. Repair CLI test name to remove unsupported precedence claim; retain CLI env-key identity and logout text. No extra precedence test needed. History: 6951ace (#33) introduced login and this unchanged CLI row, with environment precedence an explicit release decision; core resolver is independent proof. Deletion unlocked: none (rename only); no helper/module/support deletion. Risk: false confidence from title, not current product bug; keep unique whoami/logout wiring. Focused validation: `bun test packages/cli/test/login.test.ts packages/core/test/credentials.test.ts`.

### Dashboard storage/API lane: layer plan

Pinned main: `4fb197721bc05993e07acd935c9697b40741daf4`. Scope: 24 full test files, 198 declarations (including all `test.each` parameter rows), 191 R / 7 F / 0 C / 0 D. Baseline supplied by the parent: 1,372 runtime tests pass, no failures, 135 Bun files. No tests, source, support, configuration, Git state or remote state changed in this lane.

All 24 test files were read in full. Owners read in full: `accounts`, `accounts-http`, `accounts-settings`, `auth`, `auth-http`, `attachment-http`, `attachments`, `activity-store`, `visits`, `cli-api`, `cli-version`, `live-http`, `github-app`, `github-install`, `workers`, `broker`, `fleet-store`, `fleet-data`, `snapshots`, `vault`, `owner-push`, `owner-cron`, `digest`, `digest-slots`, `webhooks`, `db`, `merge-queue`, and `requests` under `packages/dashboard/lib`, plus `test/support.ts`. Entry composition: `proxy.ts`, `lib/access.ts`, `lib/server.ts`, CLI fleet/API route, live fleet route, both signed webhook routes and owner cron route. Non-test callers were traced through imports and calls in server actions, organization pages, API routes and the core fleet API. Each file's recent Git history was read; candidate introduction lines were checked with blame.

CI routes every test in this lane through unconditional `bun test` in `.github/workflows/ci.yml`'s verify job, alongside lint/typecheck. Other jobs build the dashboard, scan accessibility and performance on a real Postgres demo, and install the packed CLI on Node22. The ordinary Bun baseline uses PGlite. `ARMADA_TEST_DATABASE_URL` optionally runs dashboard support on a throwaway real Postgres schema per file; real-Postgres multi-connection lock behavior is not demonstrated by the ordinary PGlite baseline.

Dependency checks: Better Auth's installed `dist/db/get-migration.mjs` introspects actual Postgres tables/indexes and compares plugin schema, making `accounts.test.ts:141` a useful compatibility proof. Installed device authorization `routes.mjs` enforces pending/slow-down/expiry and atomically consumes approved device codes; organization invitation routes enforce recipient email and membership before hooks/write; API-key plugin assigns organization `referenceId` and checks creation permissions. Armada's current-role lookup adds a distinct rule beyond that plugin. Kysely's `PgDialect` maps actual SQL rows/affected counts through the app's driver; installed node-postgres `lib/result.js` and PGlite query/transaction declarations corroborate those driver contracts. PGlite is a real SQL boundary but Armada serializes acquired connections; retain its constraints/transaction proofs without claiming that it establishes production multi-session contention.

| Contract and production path | Cheapest keeper layer and named keepers | Higher-layer proof retained / assertions carried |
| --- | --- | --- |
| Password/account admission: `proxy` → guards; actions → accounts | Pure configuration/cookie/redirect cases in `auth.test.ts` and `accounts.test.ts` guard cases; Better Auth plus PGlite account/invitation/OAuth cases in `accounts.test.ts` | CLI device authorization, session/key identity and broker role gating stay in `cli-api.test.ts`, `workers.test.ts` and `secrets.test.ts`; genuine dependency integration, not mocked Better Auth promises. |
| Worker credentials/provenance: CLI route → `handleCli` → `workers`/broker → SQL | `workers.test.ts:146,204,219,235,279,316,349,388,447,500`; `secrets.test.ts:121,175,202,215,247` | Preserve exact capability denials and revocation/replacement behavior. Repair filtered log/quota cases T1/S1 in place; carry secrecy assertions to an exercised operation. |
| Encrypted vault and migration compatibility: actions/broker → vault → SQL/crypto | `vault.test.ts:33,47,104,232,266,305`; `migrations.test.ts:6` (all three rows) | Keep cryptographic row binding, legacy ciphertext, role-scoped transport and immediate rotation at their separate owners. No plaintext fixture/source inspections substituted for actual encryption/decryption. |
| Named ownership, coordinator clocks and runtime generations: core fleet API → store | `coordinators.test.ts:28,70,93` and repaired `:173`; `dashboard-facts.test.ts:17,50,112`; `runtime-state.test.ts:8,67`; `fleet-store.test.ts` session/presence/ownership cases | SQL owns lock/unique/index and timestamp persistence; core fake API/worker logic does not replace it. Carry claim ordering in C1 and add genuine seven-day deletion evidence in C2. |
| Requests, inbox uniqueness, validation, lease, merge queue, jobs: `handleCli`/`requests` → store | PGlite `fleet-store.test.ts` behavior groups; full route/request composition in `cli-fleet.test.ts`; actual dashboard request orchestration in `fleet-data.test.ts` | Retain request atomics, superseding/decision records, leases, named queue claims, job storage and tenant-scoped transport; shared scenario names test different boundaries. |
| Shared resources and lifecycle cleanup: core `recordRelease`/`recordMerge` → store | `reservations.test.ts:20,60,98,109,139,200` | Retain concurrent allocation, bigint formatting, missing-claim cleanup and deterministic replacement interleavings. Wrappers schedule real SQL mutations; they do not fake the implementation being asserted. |
| Deploy observations and merge holds: core deploy API → store | `deploy-store.test.ts:31,81,105,140` and repaired `:49` | Keep newer-sequence/ancestry/target fencing and same-transaction notices; C3 carries pause=false notification assertions through failure → unrelated healthy → covered healthy. |
| Snapshot refresh/nonblocking data reads: server → `fleet-data`/`snapshots` → SQL | `fleet-data.test.ts` full and incremental/background/nonblocking/distributed cache cases; `webhooks.test.ts:109,130,145,175,198,220,236,269,282` plus repaired `:157` | Full reread periodic cadence is different from label-triggered full invalidation. W1 proves that a marked label changes the next persisted snapshot. Retain abandoned/stolen lease and unseen-mark protection. |
| Activity/insights/visits: scoped page/data loader → SQL projection → core derivations | `activity-store.test.ts` query/filter/cursor/catchup/visit cases; `insights-store.test.ts:144,160` | Fleet-data SQL-only loading remains; pure core derivations are complementary. Keep heartbeat compaction, old open waits and pagination rather than replacing them with canned rows. |
| Attachments: CLI upload/read routes → storage and snapshot membership | `attachments.test.ts` real bytes/dedupe/quotas/retention/read cases; `cli-fleet.test.ts` admission/tenant/project program-root and cache-miss cases | Storage constraints and authorization paths own different risks; preserve media/URL refusal, byte dedupe, quotas, source membership verification and safe download headers. |
| Owner alert/digest outbox: fleet/CLI/cron/actions → pulse/tick → SQL and injected POST | `owner-push.test.ts:148–480` behavior-specific cases; repair `:497` | Keep durable claims, bounded live-clock batches, retries/pauses, schedule windows, quiet-hour storage, DST/offset slots, signed minimal payload and server-only vault exclusion. O1 adds transport redirect proof without deleting admission predicates. |
| GitHub App and install callbacks: server/organization actions/setup → GitHub adapters/SQL | `github-app.test.ts` RSA/token/cache/pagination/access cases; `github-install.test.ts:69,77,91,116` | Keep signed browser/org/person state, expired/forged-state denials, actual persisted link/audit idempotence and GitHub-visible installation checks. |
| Conditional response/release publication: API routes → `live-http`/`cli-version` | `live-http.test.ts:11,29`; all four `cli-version.test.ts` cases; version headers in `cli-api.test.ts` | Keep semantic ETags, no-store304, timing wrappers and npm-confirmed publication headers; distinct contracts from UI rendering. |

Second pass conclusion: no whole files retire; no production seam, support fixture or dependency deletion has been proven safe in this lane. All seven F candidates keep their unique behavior and repair the boundary/proof in place. No runtime-saving deletion recommendation is supported merely because fake core tests cover the same business scenarios. THE-1146 may simplify local trace assertions and remove order coupling after adding the missing proof, but must preserve security and SQL ownership.

Candidate details, relevant introduction history, remaining proof, risk and focused commands appear below; the declaration ledger is exhaustive. Read-only focused verification: `bun test packages/dashboard/test/workers.test.ts -t "exchanges are limited"` fails at line492 because the ABC-12 exchange log is absent (0pass/1fail,10filtered). `bun test packages/dashboard/test/secrets.test.ts -t "no value is ever logged"` passes without executing any of its secret set/release/rotation cases (1pass,5filtered). These declarations were byte-compared with the pinned main after main advanced; they are unchanged. This selected-case failure is an audit finding, separate from the all-green full-suite baseline. Follow-up edits should run the focused files named by each candidate, then `bun run verify`.

### Dashboard UI layer plan

Keep pure view rules as their primary owners: `activity-view.test.ts` (address, kinds, zone, day/divider), `announce.test.ts` (polite changes), `coordinator-view.test.ts` (session precedence, six steps, owner scope, overview grouping), `fleet-view.test.ts` (navigation/runtime links), `insights-view.test.ts` and `jobs-view.test.ts` (display units and injected time), `overview-view.test.ts` (decision cards and request state), `project-view.test.ts` (launch/profile and project facts), `search.test.ts` (index, ranking and actions), and `notify.test.ts` (opt-in/dedupe/quiet hours). Core rules, CLI serialization, and Postgres lifecycle protect different boundaries; do not collapse them solely because fixtures resemble one another.

Keep `demo-world.test.ts` for deterministic showcase/performance fixtures, `landing.test.ts` for published claims, static imports, generated terminal/share artifacts and deterministic animation, `page-anatomy.test.ts` for discovery-backed architecture guards, `contrast.test.ts` for CSS contrast, and `clock-readings.test.ts` for reserved text width. Source scans remain only when they independently guard architecture/public bytes; exact JSX/private constant construction receives F.

The redundant layer is the dashboard reexports of core `owner-items.ts`. Carry the missing-field, decided, non-owner, multi-project, oldest-item and count assertions from `overview-view.test.ts:158/:239` into `core/test/owner-items.test.ts:41`; the existing core test covers composed ownerItems links/stable keys but is not yet an equivalent keeper. Only then remove those two declarations. Keep the rest of overview-view: no whole file is retired.

Consolidate `fleet-view.test.ts:69` into `demo-world.test.ts:88` after preserving an unknown-slug determinism fixture. The current same-input self-comparison does not exercise changing project membership. Consolidate landing MethodSteps navigation into `keyboard.test.ts:29/:35` after adding ArrowUp/Down and switching the real MethodSteps caller. `scripts/a11y.ts` keeps an independent rendered tab/focus proof; it must not replace pure helper edge cases it never reaches. The only potential production seam removal is the landing-specific `stepForKey` once its caller is migrated. `projectColor`, `pendingValidations`, `coordinatorAlerts`, `ownsKeys`, and search exports have real callers and are not test-only seams.

Repair F assertions before considering cuts: real open/closed/ARIA dialog selector behavior, help output independent of COMMAND_HELP spelling, semantic page header, phone bar effective reserved heights, search result membership before ordering, and calibrated 5,000-item benchmark. Existing CI INP on the large demo and axe at 320px are integration keepers, not exact substitutes for these helper/layout contracts. No whole UI suite is approved for retirement. THE-1146 must re-read changed main files and demonstrate keeper failures with controlled mutations during authorized cutover.

### Skills and tooling layer plan

Keep `core/test/skills.test.ts` for released bundle bytes and guide anchors, and `cli/test/skills.test.ts` for credential-free local update effects. Keep `cli/test/init.test.ts` as the actual temporary-Git setup/upgrade/merge owner, including rename, retarget and lock regressions; `doctor.test.ts` owns human diagnostics, secret-name-only output and environment applicability. These are separate contracts, not three copies of skill inventory.

The daily-release diagnostic layer has one definite deletion candidate: `doctor.test.ts:292` only calls globally quiet doctor, so cannot prove worker eligibility. Doctor quietness remains at :245, and real worker notice suppression is owned by `cli/test/release.test.ts:90`. Carry :300's no-extra-notice assertion into :219's minimum-version keeper before removing the duplicate. Repair :219's absent call-count assertion, :245's unexercised status promise, and :258's mock-implemented publication gate. `core/test/npm.test.ts` owns publication reads; a fake callback changing server.latest cannot establish the dashboard's real release-refresh gate. No support/helper deletion is established by these two declaration cuts.

Keep `fonts.test.ts` for artifact freshness, cmap/weight/notdef/features and written glyph coverage; repair construction-specific fallback registration assertions. Keep `icons.test.ts` for generated SVG and public gate paths; repair raster correctness because a matching tEXt hash is not decoded-pixel proof. Keep all `perf.test.ts` fixture cases for budget parsing, medians, reporting and hard/advisory thresholds; production CI provides separate real build/Lighthouse/INP execution.

Keep `review-runtime.test.ts` for CLI prerequisite dispatch and the fourteen Python tooling declarations for safe artifact placement, complete context inventory, OCR checksum/cache trust, read-only check, explicit denied commands and argument-vector dispatch. Python is not discovered by Bun and is not routed in current ci.yml; the baseline ran it explicitly. No test-only production seam is evidenced here: the generator/config/context/wrapper functions have executable command callers. No whole file is approved for retirement. Focused follow-up checks are the named Bun files, both Python unittest directories, then bun run verify and the actual CI gates.

## Candidate evidence and follow-up guard

Every F/C/D identity has its exact name/location and detected failure in the declaration ledger below. The keeper plans supply the stronger owner and carried assertions. The per-file history is the latest relevant change at the pinned baseline; it explains the represented contract, not a claim that a red pre-fix control was run. Candidate details below add callers, potential deletions, risks and focused commands. Missing equivalent keeper proof prevents an immediate deletion.

# Core candidate evidence at 4fb197721bc05993e07acd935c9697b40741daf4

These are read-only findings: 16 consolidation candidates and seven repairs, with no deletion recommendation. No test or production file has changed. A C requires carrying the named fixture/assertions before retiring its declaration; it does not claim the stronger keeper already covers all of them. An F keeps its contract and repairs its oracle or scheduling. All candidates ran green in the pinned suite baseline; none is a baseline product failure.

Shared routing: `.github/workflows/ci.yml` runs all these files through `bun run verify`; targeted commands below run the owner/keeper pair before the full verify. Neither the dashboard build/performance jobs nor Node bundle smoke owns these behavioral assertions. No production seam is safely unlocked by this list: helpers are used by production, and publicly exported helpers additionally need compatibility review. Shared FakeLinear/memoryFleet/recorded-fetch support stays because it enables the cheapest network-free owner boundaries.

## Consolidation candidates

| Candidate | Actual oracle and proposed keeper | Production callers / seam | History and reason | Deletion unlocked | Risk and focused validation |
|---|---|---|---|---|---|
| attachments.test.ts:21 | JPEG/GIF/WebP signatures and SVG rejection; add each to preceding byte-sniff/admission scenario. | checkAttachment calls attachmentImageType; fleet API uploads consume admission. No filename dependency. | d03b5cc attachments #103 introduced the security boundary. | Standalone type-helper declaration; no source cut. | Removing a format or allowing SVG must still fail; `bun test packages/core/test/attachments.test.ts packages/core/test/fleet-api.test.ts`. |
| attachments.test.ts:28 | Positive quota/retention 4/8/2 and zero rejection; move to config.test.ts default/invalid policy matrix. | parseConfig supplies attachment limits to upload/storage admission. | d03b5cc attachments #103; ownership is parser, not byte admission. | One parser declaration outside its owner. | Losing configurable limits; `bun test packages/core/test/config.test.ts packages/core/test/attachments.test.ts`. |
| catchup.test.ts:52 | First-visit null seen/since/backAt yields false; carry into preceding showSummary visibility table. | showSummary is called by dashboard visit/since routes; the removed screen does not make these routes dead. | 2450f9b dashboard v7 #188 changed consumption, not route contract. | One duplicate visibility invocation. | Phantom summary for a new viewer; `bun test packages/core/test/catchup.test.ts`. |
| ci.test.ts:336 | Invalid regex, missing/invalid ticket and unknown registry key TOML; carry full rows into config.test.ts. | parseConfig owns known_failure registry, explainCi uses the parsed policy. | daf007f tracked flake reruns #230 explains new registry validation. | One parser declaration outside config owner. | Invalid retry exceptions could become accepted; `bun test packages/core/test/config.test.ts packages/core/test/ci.test.ts`. |
| config.test.ts:83 | Custom parked label on-hold; add to config minimal/default override matrix. | fleet/status consume configured parked labels, with separate retained behavioral tests. | Config latest daf007f #230; parked behavior is still live. | One low-information parser declaration; retain custom-label consumer checks. | Default fallback may hide failed parsing; assert custom parsed value independently, `bun test packages/core/test/config.test.ts packages/core/test/fleet.test.ts packages/core/test/status.test.ts`. |
| deploy.test.ts:119 | Source exclusivity, duplicate names, timeout range and unknown TOML keys; move all to config.test.ts. | parseConfig supplies DeployTarget to CLI deployment/watch; watchDeploy assumes validated target. | 4fb1977 deploy #237 introduced the config contract. | One configuration declaration outside config owner. | Invalid deployment setup could reach live execution; `bun test packages/core/test/config.test.ts packages/core/test/deploy.test.ts`. |
| fleet-api.test.ts:249 | A claim uses server time despite a different terminal clock; carry divergent clocks into first claim/report lifecycle. | serveFleet snapshots deps.now; recordClaim/recordReport persist that server timestamp. | Latest fceaf43 secrets #239; separate clock contract remains important. | One single-assertion transport invocation, after carrying clocks. | Client time can corrupt ordering and liveness; `bun test packages/core/test/fleet-api.test.ts packages/core/test/heartbeat.test.ts`. |
| jobs.test.ts:30 | Job command requirements, positive thresholds, default 15 minutes and null max; carry all TOML rows into config.test.ts. | Config supplies runners to CLI jobs start/status and server job policy. | 141e2d7 job display #235; parser validation is separate from job lifecycle. | One configuration declaration outside owner. | Invalid runner commands/thresholds; `bun test packages/core/test/config.test.ts packages/core/test/jobs.test.ts`. |
| linear.test.ts:171 | Initial query never answers and names Linear in the error; add initial-query timeout row to retained later-page failure scenario. | Linear HTTP adapter propagates named failures; shared http owns deadline mechanics. | f5ff024 ticket readability #238; service context still matters. | One duplicate named-outage declaration. | First request might wrap errors differently from relations; only cut after the root-row assertion fails a lost-context change, `bun test packages/core/test/linear.test.ts packages/core/test/http.test.ts`. |
| plans.test.ts:68 | Injected polling wakes on a new plan kind; add plan-kind row to inbox.test.ts:700 polling table. | checkInbox polls fleet.inbox with ETags and entry keys; recordReport persists a plan. | 5f634f2 pre-approved plans #200; plan submission stays covered by retained first plan test. | One repeated polling orchestration declaration. | Plan and question keys differ; preserve exact new-plan wake/phase, `bun test packages/core/test/plans.test.ts packages/core/test/inbox.test.ts`. |
| plans.test.ts:140 | Pre-approved label permits implementing and leaves no approval item; add this label row to retained --plan implementing scenario. | planRule/config and reportPhase decide approval and resolve plans. | 5f634f2 #200 introduced explicit pre-approval. | Standalone empty-inbox check only after phase and label fixture move. | A wrong rule could bypass approval; `bun test packages/core/test/plans.test.ts packages/core/test/phases.test.ts`. |
| routing.test.ts:63 | Unmatched labels select docs default with explanation; add exact default/why row to first-rule Unicode routing matrix. | routeProfile/describeRoute feed brief, claim and status ready profile projection. | dc46b9c herdr launch #140; profiles are still active. | Repeated default-routing declaration. | Default explanation or source could be lost; `bun test packages/core/test/routing.test.ts packages/core/test/brief.test.ts`. |
| inbox.test.ts:297 | Release resolves a question-only open item; carry fixture into requests.test.ts direct-answer/release cleanup keeper. | releaseTicket → fleet release → recordRelease closes the generation and open questions; requests suite already covers lifecycle with owner requests. | a5823d8 named scope #243; question-only row differs from owner-request row. | One repeated release orchestration declaration. | Existing keeper alone is insufficient; retain question resolution exact id, `bun test packages/core/test/inbox.test.ts packages/core/test/requests.test.ts packages/core/test/worker.test.ts`. |
| inbox.test.ts:762 | No wait gives exactly one inbox call and null wait; carry default-mode row into :700 polling keeper. | checkInbox has explicit early return before wait loop. | a5823d8 #243; default mode is supported. | One tiny polling-mode declaration. | Accidental polling for a one-shot command; `bun test packages/core/test/inbox.test.ts`. |
| merge.test.ts:1102 | HAS_HOOKS merges like CLEAN; add independent CLEAN/HAS_HOOKS admission rows to assess checklist table. | MERGEABLE_STATES feeds assess; mergePull runs assess before pinned mutation. | 4fb1977 deploy #237 latest; HAS_HOOKS is documented accepted GitHub state. | One full orchestration repetition for a pure admission choice. | Ensure native success still has the ordinary CLEAN merge keeper; `bun test packages/core/test/merge.test.ts`. |
| merge.test.ts:1124 | Lease over one hour returns 400 with its diagnostic; add boundary row to fleet-api malformed-request/lease test. | serveFleet validates lease ttl against MAX_LEASE_TTL_MS before store acquisition. | 4fb1977 deploy #237 latest; limit bounds crash locks. | Parameter-validation declaration in merge suite. | Missing cap can permanently stall a fleet; `bun test packages/core/test/fleet-api.test.ts packages/core/test/merge.test.ts`. |

## Repairs

| Candidate | Actual gap and stronger keeper | Production callers / seam | History and reason | Deletion unlocked | Risk and focused validation |
|---|---|---|---|---|---|
| deploy.test.ts:73 | Descendant failure/error cases return includes=true; no unrelated failed SHA is supplied despite the name. Add unrelated failure followed by target success and assert no early deploy-failed. Keep existing pending smoke lease retry. | CLI deploy calls watchDeploy; its includes callback establishes target ancestry before failure/smoke. | 4fb1977 deploy #237: new safety behavior deserves the missing negative ancestry oracle. | None: repair owner test. | Wrong ancestry handling creates a false persistent merge hold; `bun test packages/core/test/deploy.test.ts`. |
| redact.test.ts:32 | Checks absence of synthetic- while ghp_synthetic/github_pat_synthetic/gho_synthetic contain underscores; those tokens can leak and pass. xoxa_synthetic is also outside supported xoxa- syntax. Use supported literal tokens and assert each full original absent and independent mask output. | redactor is used by CLI process output/worker prose and server fleet free-text redaction; KEY_PATTERNS has xox[abp]- support. | fceaf43 secrets #239 introduced worker redaction. | Remove ineffective substring assertions once stronger literals replace them; keep every format and PEM case. | A green suite can miss actual credential leakage; `bun test packages/core/test/redact.test.ts packages/core/test/fleet-api.test.ts`. |
| fleet-api.test.ts:139 | Claims/asks/releases succeed, coordinator operations and another claim fail, but report/validate are absent despite the title. Add own report/validation and foreign-ticket attempts; independent persisted effects must be checked. | WORKER_OPS and ticket guard in serveFleet admit scoped worker requests before dispatch to recordReport/recordValidation. | fceaf43 secrets #239 latest; allowlist spans distinct operation paths. | None: repair API authorization keeper. | Broken report admission or an unscoped operation could stay green; `bun test packages/core/test/fleet-api.test.ts packages/core/test/validations.test.ts`. |
| heartbeat.test.ts:88 | Released and merged rows are identical inactive fakes; transient retry checks call count without capturing claimedAt. Capture every ping input and assert the first returned claim stays pinned after transient failure; retain inactive and 401 paths. | heartbeatLoop sends claimedAt to API; generation guard is enforced by FleetStore adapter and worker session. | 1249b4c shipping stages #176 latest; heartbeat protects generation identity independently of phase. | Duplicate inactive labels/rows may collapse; no loop seam removed. | Retry could heartbeat a replacement worker; `bun test packages/core/test/heartbeat.test.ts packages/core/test/runtime-state.test.ts`. |
| setup.test.ts:115 | Installed pointers are compared with pointerText from the same renderer. Its output can be equally wrong on both sides. Keep literal discovery/read-command/version facts; check independent frontmatter/path requirements for each delivery kind and retain old MERGE.md removal and instruction-only update behavior. | planSetup/planSkills → deliveredSkillFiles → pointerText; CLI init and doctor consume these files. | 00e6f15 repository rules #236 latest; instruction pointers are real public agent entrypoints. | Same-renderer equality loops only, after independent assertions. | Invalid discovery metadata or stale annexes could make agent setup unusable; `bun test packages/core/test/setup.test.ts`. Bundle freshness elsewhere remains distinct. |
| merge.test.ts:579 | Serial timeline and both successful merges are valuable, but the injected sleep uses real setTimeout(0). Replace it with an explicit coordination barrier/microtask. | mergePull acquires/renews/releases the project lease through Fleet, and waits through injected sleep. | 4fb1977 deploy #237 latest; overlapping coordinator execution makes serialization a real contract. | Real timer use only; keep contention and first/second ordering assertions. | A simplistic resolved Promise may starve progress or fail to establish contention; `bun test packages/core/test/merge.test.ts` with deterministic barrier scheduling. |
| validations.test.ts:186 | Missing/pending approval refusal, Done status, note and merge event are asserted, but no active session is created and its end is not checked; the att-9 URL is never checked either. Create a claim, call closeValidated, assert that exact generation ends and the independent attachment URL appears in tracker content. | CLI done → closeValidated → fleet.done → recordDone; recordDone ends runtime handle and resolves questions after the approval gate. | 802ceb9 owner validations #108 introduced done-without-PR lifecycle. | None: repair the existing owner close keeper. | A design could close while a live worker and its questions remain active, or lose its approved artifact; `bun test packages/core/test/validations.test.ts packages/core/test/worker.test.ts`. |

Cross-lane carry agreed with the dashboard audit: dashboard overview-view helper assertions for `pendingValidations` and `coordinatorAlerts` belong beside `ownerItems` in core. The existing core composed test keeps decision URLs, decided filtering, stable coordinator-stop keys and suppression of ordinary worker alerts. It does **not** yet keep absent-validations fallback or multi-project coordinator oldest/count fixtures. Add those independent assertions before retiring the dashboard helper declarations. Browser notification suppression, quiet hours and notification title remain a distinct dashboard transport contract.

## Retained false positives corrected by independent review

`armada-api.test.ts:199` and `insights.test.ts:50` remain R. Both helpers are publicly reexported by core index/read and use independent literal API oracles at a cheaper scalar boundary. `newerRelease` consumes only comparator sign (>0), whereas the direct test independently expects literal -1/0/1 values plus numeric ordering and ignored suffix behavior. Its current numeric fixtures differ by one component unit, so no claim is made that removing Math.sign would fail this particular test. No equivalent redundant layer has been established. The quantile empty/singleton/unsorted-even/ten-value-p90 table independently owns nearest-rank semantics. Moving it into claim/merge metrics lacks a demonstrated redundant layer and provides no removable production seam. Retain both declarations and exports; no carry/cut is authorized.

### Dashboard storage/API candidates (all F, no authorized cuts)

These are static assertion findings on pinned main `4fb197721bc05993e07acd935c9697b40741daf4`, not baseline product failures. The main suite passes. Keep every unique contract. Non-test production paths and remaining proof are listed per candidate. No production or support seam deletion is unlocked by these fixes.

**C1 — `packages/dashboard/test/coordinators.test.ts:173`: exact SQL adjacency overspecifies the locking proof.** Failure detected now: adding a harmless statement inside the transaction, or formatting equivalent lock SQL, fails `write === lock + 1`, exact string matching, and neighbor `BEGIN`/`COMMIT` checks without changing behavior. Conversely the pending transfer is completed before the claim, so this fixture is not itself a two-connection lock-wait race. Production callers: CLI `handleCli` → core `serveFleet` claim → `fleetStore.saveRuntimeHandle`; handover reaches `transferTickets`. The owner takes a project `FOR UPDATE` lock in a separate statement before the authenticated launch-owner lookup/upsert so a fresh READ COMMITTED snapshot sees the transfer. Keeper: repair this declaration to preserve separate lock-before-owner-read/write within the same transaction and persisted coordinator=back. Prefer a deterministic two-connection handover/claim schedule on throwaway Postgres for the snapshot guarantee; otherwise retain a narrow ordered-statement assertion and explain PGlite limits. Remaining proof: `coordinators.test.ts:93` exercises authenticated launch ownership, guarded handover, phase preservation and stale resume; `workers.test.ts:235` denies request spoofing. Neither alone proves lock-wait snapshot ordering. History: `0dfebf3` (#228, THE-1109) introduced both the production ownership protocol and this traced regression case, with an explicit READ COMMITTED comment. Support/production deletion: none; removing broad exact adjacency may simplify local trace assertions, not the lock or adapter. Risk: stale launch owner can reacquire transferred tickets if the meaningful ordering proof is weakened. Focused validation after repair: `bun test packages/dashboard/test/coordinators.test.ts packages/dashboard/test/workers.test.ts`; run the deterministic contention case also with `ARMADA_TEST_DATABASE_URL` set to a throwaway schema-capable Postgres URL, then `bun run verify`.

**C2 — `packages/dashboard/test/dashboard-facts.test.ts:17`: seven-day retention is not asserted.** Failure the current test misses: deleting old-row pruning from `recordCoordinatorSeen` leaves the final25-hour `inboxReads` query empty because that SELECT only shows a24-hour timeline plus one-hour buffer. The latest action in this case is an ordinary command at51minutes, not a day-seven inbox read that invokes pruning. Production callers: core `serveInbox` records reads even on304; dashboard SQL `recordCoordinatorSeen` both updates presence and prunes per-project inbox events; `fleet-data.readLive` retrieves `inboxReads` for timeline/flow facts. Keeper: keep this declaration's separate activity/inbox clocks,304-read logging, silence reset and foreign-project absence, then trigger an injected inbox read beyond seven days and query persisted old/near-cutoff/foreign-project inbox-event rows directly. Remaining proof: `coordinators.test.ts:70` owns named multi-session presence and `dashboard-facts.test.ts:50` owns retained session launch/report facts; neither proves old event deletion. History: `21235b7` (#78) introduced seven-day title/storage retention; `01afa00` (#98) changed the terminal expectation to25hours for the24-hour dashboard timeline, leaving the retention wording. Support/production deletion: none. Risk: unbounded history storage or pruning the wrong project if only the visible window is checked. Focused validation: `bun test packages/dashboard/test/dashboard-facts.test.ts packages/dashboard/test/coordinators.test.ts`, then `bun run verify`.

**C3 — `packages/dashboard/test/deploy-store.test.ts:49`: pause=false alert existence and ancestry survival are invisible.** Failure the current test misses: skipping the no-pause failure notice entirely still satisfies all no-hold/state checks and the final single preview notice. Clearing that notice at unrelated healthy SHA c also leaves the final result unchanged. Production callers: core deploy recording through `serveFleet` → `fleetStore.recordDeploy` → deploy inbox/hold updates and ancestry-based healthy clearance; coordinator inbox and overview read those durable notices. Keeper: keep this declaration and assert the no-pause b notice immediately after failure, still open after unrelated healthy c, then resolved only after d covers b; preserve unrelated preview notice. Remaining proof: `deploy-store.test.ts:31` proves pausing failure coalescing/immutable retries, `:81` proves unrelated healthy does not suppress a held failure, `:105` proves ancestry enrichment and `:140` transaction rollback. None detects an omitted non-pausing notice. History: `4fb1977` (#237, THE-1101) introduced the store and all these fixtures; this is a new-contract coverage gap. Support/production deletion: none. Risk: lost coordinator alerts when a user chooses monitoring without merge pause. Focused validation: `bun test packages/dashboard/test/deploy-store.test.ts`, then `bun run verify`.

**O1 — `packages/dashboard/test/owner-push.test.ts:497`: redirect refusal has no transport proof.** Failure the current test misses: removing `redirect: "error"` from `post`, or adding redirect follow-up in `safeWebhookFetch`, does not touch any `webhookUrl`/`publicAddress` assertions. Production callers: fleet live route, CLI after-callback, owner cron and `app/notify-actions.ts` use `safeWebhookFetch`; that production transport validates DNS answers, pins the checked IP in HTTPS lookup and does not issue a second request. `post` also sends redirect:error to injected transport. Keeper: preserve the existing pure URL/address rejection matrix; add a no-network adapter-level case with controlled DNS/HTTPS modules at the existing boundary, return a3xx Location to a private target and assert only one outgoing request plus sanitized failure. The injected `sendOwnerTest`/`ownerTick` fetch can additionally assert redirect:error and no delivered item on3xx; that alone must not be claimed to prove the production DNS/HTTPS adapter. Remaining proof: `owner-push.test.ts:285` HMAC/minimal payload/durable sends; `:387` sanitizes failure and `:424` excludes webhook credentials from broker; none reaches production redirect handling. History: `47b62cf` (#212, THE-1097) introduced URL guards and HTTPS pinning with this test. Support/production deletion: none; no new public option or helper should be exported just to test transport. Risk: credential-bearing POST can reach a private redirected endpoint if redirect handling changes. Focused validation: `bun test packages/dashboard/test/owner-push.test.ts`, then `bun run verify`; all proposed transport activity must remain injected, no live DNS/network.

**W1 — `packages/dashboard/test/webhooks.test.ts:157`: deferred whole reread only proves absence of an incremental read.** Failure the current test misses: a background refresh that resolves without reading or saving remains one background promise with asks=[]; changing markEveryProject to affect only widgets cannot fail a single-project fixture. Production callers: signed Linear webhook route → `handleLinearWebhook` IssueLabel → `snapshots.markEveryProject`; next page/live read → `loadOverview` background refresh → `refreshProject` chooses `readSnapshot` from claim.full and saves a newer body. Keeper: repair this case to observe full-reader call count, inject visibly changed returned content, assert new persisted version/body, and include a second registered snapshot to prove every-project marking. Preserve no immediate refresh and zero incremental requests. Remaining proof: `fleet-data.test.ts` periodic whole-refresh coverage proves cadence, while `webhooks.test.ts:175,198,220` preserve marks/lease fencing; neither proves a label rename triggers a successful full read. History: `cb71f78` (#59, THE-853) introduced source snapshots/webhook refresh tests; `11ee2fa` later broadened GitHub push invalidation, leaving this original assertion unchanged. Support/production deletion: none. Risk: renamed/deleted labels permanently leave phase/routing stale while UI polls appear successful. Focused validation: `bun test packages/dashboard/test/webhooks.test.ts packages/dashboard/test/fleet-data.test.ts`, then `bun run verify`.

**S1 — `packages/dashboard/test/secrets.test.ts:279`: secrecy negatives consume earlier tests and can pass vacuously.** Failure the current test misses: filtering to this declaration skips the prior set/rotate/release/refusal sequence, so none of VALUES is exercised; the beforeAll fixture only creates accounts/worker credentials, not those secret values. `bun test packages/dashboard/test/secrets.test.ts -t "no value is ever logged"` confirms the isolated case passes (1pass,5filtered) without those earlier mutations; the test file is unchanged from pinned main. A disclosure in set/release after this case's fixture has not run. Production callers: CLI secrets/credentials paths → `handleCli` → `broker`/`vault` with current actor and audit writes; actions also call vault mutations. Keeper: make the case perform its own synthetic-secret set, release and rejected foreign-project release; prove those expected non-secret event/log records exist before checking the exercised values are absent. Keep all previous metadata/rate/scope assertions at their unique owners. Remaining proof: `vault.test.ts:104,305` checks actual stored ciphertext/audit/meta secrecy; `secrets.test.ts:121,175` owns transport role/audit correctness but neither inspects console disclosure independently of case order. History: `d916cf3` (#72, THE-859) introduced per-project CLI secrets and this final aggregate case. Support/production deletion: none; only dependence on prior tests can be removed. Risk: weakening the security contract to a vacuous no-value check or moving the assertion outside the leaking route. Focused validation: run `bun test packages/dashboard/test/secrets.test.ts -t "no value is ever logged"` and the entire secrets/vault files, then `bun run verify`.

**T1 — `packages/dashboard/test/workers.test.ts:477`: quota/log safety is order-dependent and misses address isolation.** Confirmed selected-case failure: `bun test packages/dashboard/test/workers.test.ts -t "exchanges are limited"` returns0pass/1fail (10filtered) at line492, missing the ABC-12 log. The test file is unchanged from pinned main. The case generates only a blocked valid launch plus guesses, yet requires a successful ABC-12 exchange log and >10 issued tokens from earlier cases; selected alone, it fails due to missing earlier activity instead of testing secrecy. A global quota instead of address-scoped quota would still pass the current same-address/window status checks because no second address is tried until the old window expires. Production callers: CLI launch/exchange route → `workers.exchangeLaunch` → persisted `armada_launch_attempt` count and hashed token/session rows; console notice logs safe launch metadata. Keeper: create/exchange a successful own-case token first; after exhausting address A, exchange a distinct valid own-case token at address B at the same injected time, then retest A after rollover. Assert own-case positive audit/log presence and absence of those exercised plaintext launch/session tokens in SQL/logs. Remaining proof: `workers.test.ts:146` proves one-time successful exchange; `:204` expiry; `:349` revocation; none owns exchange-address quota or isolated token absence. History: `99a15e2` (THE-841 worker launch/session introduction) added this aggregate safety case; `0239fbb` (#51) moved persisted checks to the unified Postgres tables. Support/production deletion: none; remove borrowed ABC-12/>10 assertions only after carrying real positive proof into the same case. Risk: accidental global lockout or plaintext credentials logged when broad absence checks stop exercising real exchanges. Focused validation: `bun test packages/dashboard/test/workers.test.ts -t "exchanges are limited"`, then full workers file and `bun run verify`.

### dashboard-ui candidate details

**C — `packages/dashboard/test/fleet-view.test.ts:69` — a project keeps its color whatever other projects exist**

- Detectable failure: Can catch palette membership or nondeterminism for same slug, but no cross-project membership change.
- Non-test callers: `components/ui.tsx` and `components/shell/Shell.tsx` call projectColor/navigation helpers.
- Remaining proof / keeper condition: Same-slug call equals itself and palette membership does not exercise other projects promised in name. Consolidate into demo-world.test.ts:88 literal color keeper; first carry unknown-slug deterministic fixture. projectColor is publicly used; do not remove helper.
- History and purpose: `df8f084 feat(fleet): check Conductor sessions before silence alarms (#213)` is the pinned file change, covering public fleet navigation and runtime reading.
- Production/support removal: No production or support deletion established; only the named declaration is a possible later consolidation/deletion.
- Risk and focused proof: preserve the unique edge cases before retiring duplication; run `bun test packages/dashboard/test/fleet-view.test.ts packages/dashboard/test/demo-world.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/keyboard.test.ts:17` — never reach the page behind an open dialog (⌘K, a screenshot)**

- Detectable failure: Can catch complete removal of any dialog-looking selector, but not open/ARIA selector semantics.
- Non-test callers: `components/shell/Shell.tsx` calls ownsKeys; `components/ui.tsx` calls tabStep.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `f01dcb1 feat(dashboard): make every page usable with a keyboard and a screen reader (#118)` is the pinned file change, covering keyboard/screen-reader ownership.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/keyboard.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/landing.test.ts:23` — lists every command of armada --help, in its order**

- Detectable failure: Can catch missing/help-order drift when COMMAND_HELP syntax remains identical; private rename also trips it.
- Non-test callers: `app/landing/page.tsx` renders command content; `components/landing/MethodSteps.tsx` calls stepForKey.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `975a8ae fix(dashboard): stop the landing's method section from hijacking the scroll (#192)` is the pinned file change, covering natural scrolling and landing step navigation; published help claims remain independent onboarding contracts.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/landing.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**C — `packages/dashboard/test/landing.test.ts:112` — moves between its steps with the arrow keys, Home and End, wrapping at both ends**

- Detectable failure: Can catch helper key/wrap changes, already same key mechanism as tabStep except vertical arrows.
- Non-test callers: `app/landing/page.tsx` renders command content; `components/landing/MethodSteps.tsx` calls stepForKey.
- Remaining proof / keeper condition: MethodSteps stepForKey duplicates shared tabStep behavior with extra ArrowUp/Down. Consolidate under keyboard.test.ts:29/:35 only after carrying vertical arrows and switching MethodSteps caller to shared helper; then remove landing-specific helper if no callers. No current cut.
- History and purpose: `975a8ae fix(dashboard): stop the landing's method section from hijacking the scroll (#192)` is the pinned file change, covering natural scrolling and landing step navigation; published help claims remain independent onboarding contracts.
- Production/support removal: Potential stepForKey helper removal only after MethodSteps switches to shared tabStep; public shared helper remains.
- Risk and focused proof: preserve the unique edge cases before retiring duplication; run `bun test packages/dashboard/test/landing.test.ts packages/dashboard/test/keyboard.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**C — `packages/dashboard/test/overview-view.test.ts:158` — holds only what the owner validates; the workers' questions, plans and hand-backs stay with the coordinator**

- Detectable failure: Can catch lost missing-field fallback and changed pending/decided/owner filtering through direct reexport.
- Non-test callers: `components/shell/Sidebar.tsx`, `screens/OverviewPreview.tsx`, `screens/DecisionCard.tsx` and `shell/Palette.tsx` consume these rules; pendingValidations/coordinatorAlerts originate in core owner-items.
- Remaining proof / keeper condition: pendingValidations is a direct core owner-items reexport. Move absent readings/decided/non-owner fixtures into core/test/owner-items.test.ts:41 keeper before removing wrapper-level rule repetition; core keeper currently misses absent-field fallback.
- History and purpose: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)` is the pinned file change, covering v7 action presentation and shared owner rule composition.
- Production/support removal: No production or support deletion established; only the named declaration is a possible later consolidation/deletion.
- Risk and focused proof: preserve the unique edge cases before retiring duplication; run `bun test packages/dashboard/test/overview-view.test.ts packages/core/test/owner-items.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**C — `packages/dashboard/test/overview-view.test.ts:239` — is one card per project whose coordinator is not active while items wait for it**

- Detectable failure: Can catch changed multiple-project alert selection, oldest/count and idle-coordinator suppression through direct reexport.
- Non-test callers: `components/shell/Sidebar.tsx`, `screens/OverviewPreview.tsx`, `screens/DecisionCard.tsx` and `shell/Palette.tsx` consume these rules; pendingValidations/coordinatorAlerts originate in core owner-items.
- Remaining proof / keeper condition: coordinatorAlerts is direct core owner-items reexport. Carry multi-project/oldest/count alert fixtures into core/test/owner-items.test.ts:41 before consolidation; its composed ownerItems test alone lacks these distinctions.
- History and purpose: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)` is the pinned file change, covering v7 action presentation and shared owner rule composition.
- Production/support removal: No production or support deletion established; only the named declaration is a possible later consolidation/deletion.
- Risk and focused proof: preserve the unique edge cases before retiring duplication; run `bun test packages/dashboard/test/overview-view.test.ts packages/core/test/owner-items.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/page-anatomy.test.ts:74` — have one h1, the header bar's, that the shell names**

- Detectable failure: Can catch literal header construction disappearing; cannot distinguish equivalent JSX spelling from lost semantic heading.
- Non-test callers: Fleet/auth/landing route modules render the shared PageHeader/AuthCard and global CSS; `components/shell/Shell.tsx` hosts the shell bars.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)` is the pinned file change, covering v7 shared page anatomy and layout conventions.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/page-anatomy.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/page-anatomy.test.ts:176` — gives the phone's bars a height of their own**

- Detectable failure: Can catch removed/missing height declaration or none/auto at exact source breakpoint; not effective stable height.
- Non-test callers: Fleet/auth/landing route modules render the shared PageHeader/AuthCard and global CSS; `components/shell/Shell.tsx` hosts the shell bars.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)` is the pinned file change, covering v7 shared page anatomy and layout conventions.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/page-anatomy.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/search.test.ts:276` — an id or name starting with the query beats a word, a word beats a substring, a substring beats letters in order**

- Detectable failure: Can catch reversed present result order, but absence of preferred item may still satisfy comparison.
- Non-test callers: `components/shell/Palette.tsx` calls search/rank/action rules; `app/api/fleet/search/route.ts` serves the index.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `5cedf6e feat(dashboard): rebuild the shell and overview on the sober v7 design (#186)` is the pinned file change, covering v7 command palette and current shell.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/search.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/search.test.ts:360` — a query over 5 000 items answers well under 50 ms**

- Detectable failure: Can catch slow run on current host; result correctness and calibrated cross-runner threshold are not established.
- Non-test callers: `components/shell/Palette.tsx` calls search/rank/action rules; `app/api/fleet/search/route.ts` serves the index.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `5cedf6e feat(dashboard): rebuild the shell and overview on the sober v7 design (#186)` is the pinned file change, covering v7 command palette and current shell.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/search.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

### skills-tooling candidate details

**F — `packages/cli/test/doctor.test.ts:219` — older than Armada expects, it is an error whose fix installs the latest; the sign-in is not checked twice**

- Detectable failure: Can catch missing/incorrect minimum-version output; no assertion detects duplicate sign-in request.
- Non-test callers: `packages/cli/src/cli.ts` dispatches doctor and inbox/status; publication helpers also serve release/version flows.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)` is the pinned file change, covering setup compatibility diagnostics; these release notices predate the latest branch-rules addition.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/cli/test/doctor.test.ts packages/cli/test/release.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/cli/test/doctor.test.ts:245` — only inbox/status carry the daily notice; doctor stays quiet**

- Detectable failure: Can catch doctor notice noise and repeated inbox notice; no actual status invocation.
- Non-test callers: `packages/cli/src/cli.ts` dispatches doctor and inbox/status; publication helpers also serve release/version flows.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)` is the pinned file change, covering setup compatibility diagnostics; these release notices predate the latest branch-rules addition.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/cli/test/doctor.test.ts packages/cli/test/release.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/cli/test/doctor.test.ts:258` — a listed release stays quiet until the server verifies its tarball**

- Detectable failure: Can catch CLI announcing old fake-server latest; publication admission itself is performed by fixture callback.
- Non-test callers: `packages/cli/src/cli.ts` dispatches doctor and inbox/status; publication helpers also serve release/version flows.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)` is the pinned file change, covering setup compatibility diagnostics; these release notices predate the latest branch-rules addition.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/cli/test/doctor.test.ts packages/cli/test/release.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**D — `packages/cli/test/doctor.test.ts:292` — a worker is never told: it installs the version its brief names**

- Detectable failure: Can catch doctor noise, regardless of worker eligibility; never calls noticeRelease worker path.
- Non-test callers: `packages/cli/src/cli.ts` dispatches doctor and inbox/status; publication helpers also serve release/version flows.
- Remaining proof / keeper condition: Calls universally quiet doctor under worker sign-in and only asserts no notice: no worker-specific production notice branch is reached. doctor.test.ts:245 already owns doctor silence; retain worker-notice eligibility at actual status/inbox owner before broad cuts. This redundant negative doctor case alone can be deleted. Actual worker notice suppression remains in cli/test/release.test.ts:90.
- History and purpose: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)` is the pinned file change, covering setup compatibility diagnostics; these release notices predate the latest branch-rules addition.
- Production/support removal: No production or support deletion established; only the named declaration is a possible later consolidation/deletion.
- Risk and focused proof: preserve doctor silence and actual worker suppression at their respective owners; run `bun test packages/cli/test/doctor.test.ts packages/cli/test/release.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**C — `packages/cli/test/doctor.test.ts:300` — a CLI older than the server's minimum gets the upgrade line only**

- Detectable failure: Can catch extra release notice in outdated doctor output; not positive minimum-version guidance by itself.
- Non-test callers: `packages/cli/src/cli.ts` dispatches doctor and inbox/status; publication helpers also serve release/version flows.
- Remaining proof / keeper condition: Only asserts outdated doctor output lacks daily notice. Consolidate this assertion into minimum-version doctor.test.ts:219 keeper; carry no-extra-notice assertion there before dropping duplicate setup.
- History and purpose: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)` is the pinned file change, covering setup compatibility diagnostics; these release notices predate the latest branch-rules addition.
- Production/support removal: No production or support deletion established; only the named declaration is a possible later consolidation/deletion.
- Risk and focused proof: preserve the unique edge cases before retiring duplication; run `bun test packages/cli/test/doctor.test.ts packages/cli/test/release.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/fonts.test.ts:85` — every page lists each full font before its Latin cut**

- Detectable failure: Can catch exact registration/fallback construction changing; equivalent variable array refactor also trips it.
- Non-test callers: `scripts/fonts.ts` generates artifacts; root layout imports `app/fonts/geist.ts` and uses font variables; global CSS selects them.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `377f7ae feat(dashboard): preload only the Latin cut of Geist and Geist Mono (#109)` is the pinned file change, covering Latin/full-font cut deployment and fallback registration.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/fonts.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

**F — `packages/dashboard/test/icons.test.ts:9` — are the ones `bun run icons` builds from the shell's mark today**

- Detectable failure: Can catch stale SVG and mismatched PNG mark metadata/dimensions; wrong image payload retaining metadata can pass.
- Non-test callers: `scripts/icons.ts` generates mark assets; Next metadata/manifest and browser icon paths serve them.
- Remaining proof / keeper condition: Retain and repair this owner assertion. No equivalent stronger proof has been established; related browser/transport tests are complementary and are not authorization to drop it.
- History and purpose: `dc2e74a feat(dashboard): show the Armada mark as the browser's tab icon (#94)` is the pinned file change, covering browser tab mark generated from the shell.
- Production/support removal: No deletion unlocked; repair assertion only.
- Risk and focused proof: preserve the public contract while repairing its oracle; run `bun test packages/dashboard/test/icons.test.ts`, then `bun run verify`. During authorized cutover, demonstrate the intended keeper fails under a controlled owner mutation.

## Complete declaration ledger

R = retain; F = repair assertion while retaining contract; C = consolidate only after named keeper absorbs proof; D = delete with remaining proof. Links and declaration locations target the pinned checkout, so later main changes do not silently reinterpret the audit.

### core

#### [`packages/core/test/activity.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/activity.test.ts)

History: `c6298b1 feat(dashboard): show every agent and each agent's page (#86)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L55 — a run from launch to hand-back, newest first, each report once | R | Ordered kind/time matrix and report deduplication preserve one chronological agent history; duplicate Linear/live reports or missing PR/claim facts fail. |
| L109 — a question and a plan show with their answers, and the owner's requests with their state | R | Question answer text, resolution timestamps and request PR numbers distinguish unanswered plans from delivered answers; merging answer/request kinds fails. |
| L134 — a claim without live data comes from its comment; release and merge events show | R | Comment-derived runtime plus release text and merge order protect fallback when live claims are absent; dropping legacy claims fails. |

#### [`packages/core/test/armada-api.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/armada-api.test.ts)

History: `4322b3a feat(jobs): track long jobs on project runners (#219)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L13 — Armada retries only safe reads, including fleet reads; token consumption and fleet writes are sent once | R | Timeout call counts are 2 for safe reads and 1 for token consumption/writes, exercising operation retry classification; replaying consumed tokens fails. |
| L70 — login polls at the server's interval, 5 s slower at each slow_down, until the person approves | R | Approval token and waits [5000,5000,10000,10000] protect device slow_down protocol; ignoring increased server polling interval fails. |
| L80 — a denied or expired code ends the wait with armada login as the next step; the network going away only slows it | R | Denied/expired next steps and network-backoff waits distinguish terminal authorization failures from transient transport outages; endless denied polling fails. |
| L113 — a revoked credential is signed out with the server's next step; an address that is not an Armada says so | R | signedOut/next, preserved self-hosted path and HTTPS rejection protect credential transport; leaking credentials to nonlocal HTTP fails. |
| L139 — specific launch cleanup never falls back to ticket-wide revocation on an older server | R | Only revoke-pending URL is called after 404; falling back to broad ticket revocation can revoke a replacement launch and fails. |
| L157 — a CLI older than the server expects gets one upgrade line instead of an answer it cannot read | R | Minimum-version error, sent version and serverCli observer distinguish incompatible replies from legacy servers; parsing an unreadable response fails. |
| L186 — a newer release names setup only when behind, plus the upgrade command and notes | R | Release selection excludes equal/newer/development builds and setup hint changes with setupBehind; nagging current coordinators or hiding setup repair fails. |
| L199 — versions compare by number | R | Public compareVersions API uses independent numeric-order, prerelease-suffix and literal -1/0/1 oracles. Release orchestration consumes only sign (>0) and is not equivalent proof of returned API values. Retain this cheap primary owner test; no redundant stronger layer proven. |
| L205 — Armada retries temporary read statuses while broker 429, inbox polls and writes keep their own rules | R | Call/wait/error matrix for 502/503/429 proves credential rate-limit and write exceptions are applied at Armada transport boundary; broad safe-read retry fails. |

#### [`packages/core/test/attachments.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/attachments.test.ts)

History: `d03b5cc feat(attachments): let agents privately attach screenshots and links (#103)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — images are byte-sniffed and limited; links require HTTPS | R | PNG magic, MIME mismatch, byte cap and HTTPS/credentials/control rejection guard attachment admission; trusting filename/content type or unsafe URL fails. |
| L21 — all four supported image types are recognized from bytes, never filenames | C | JPEG/GIF/WebP/SVG magic cases belong in images are byte-sniffed and limited; carry all cases before collapsing this duplicate helper invocation. Removing a format or admitting SVG must remain caught. |
| L28 — attachment quotas and retention are configurable positive integers | C | Quota/retention parsing is config.ts behavior: carry positive 4/8/2 and zero rejection into config.test.ts minimal/default and invalid-policy tables; do not retire admission/security cases. |

#### [`packages/core/test/brief.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/brief.test.ts)

History: `5f634f2 feat(cli): pre-approve plans at launch (#200)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L5 — the Plan line includes the explicit launch reason while needs-approval keeps precedence | R | Exact launch Plan instruction includes the reason and stronger needs-plan-approval still wins; omitting approval provenance or bypassing approval label fails. |

#### [`packages/core/test/catchup.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/catchup.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L29 — starts a new one after more than 30 minutes away, from when they were last seen | R | 89/91-minute visits select prior since versus last seen; moving the more-than-30-minute boundary fails. |
| L35 — was away from the previous visit's end to when they came back | R | Away window ends at backAt and first visit returns null; counting events watched after returning fails. |
| L44 — shows its summary until it is dismissed, and again on the next visit | R | Dismissed since suppresses one visit and next absence restores summary; permanently suppressing catch-up fails. |
| L52 — has no summary on the first visit | C | First-visit false is one row of shows its summary until it is dismissed; carry null seen/since/backAt there so first-time phantom catch-up stays caught. |
| L58 — counts each ticket merged or started since then once, newest first, across projects | R | Exact merged/started lists deduplicate ticket claims and order across projects; counting repeat claims or old merges fails. |
| L86 — names a silence longer than the project's threshold that ended or lasts since then, the longest per ticket | R | Exact stuck records retain longest qualifying gap and ongoing state, excluding pre-window and threshold-equal gaps; overstating silence fails. |
| L112 — counts only what happened while the viewer was away, and no silence in a phase that waits on someone | R | Until cuts off later merges and waiting phases contribute no gaps; counting human waits as worker silence fails. |
| L139 — names a ticket that got blocked; a silence going on wins over it | R | Ongoing silence outranks blocked reason while ended gaps yield to later blocks; stale reason selection fails. |
| L163 — lists what waits for the owner now, however old | R | Owner-wait ids remain despite old creation dates and quiet=false; filtering actionable owner work by away window fails. |
| L180 — is quiet when nothing happened | R | Exact empty summary with quiet=true protects no-news response; fabricating activity on empty records fails. |
| L187 — pages on a cursor it reads back, and refuses one it did not write | R | Cursor roundtrip plus malformed date/key/null rejection protects feed pagination syntax; accepting invalid SQL-like key fails. |

#### [`packages/core/test/ci.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/ci.test.ts)

History: `daf007f feat(ci): rerun tracked flaky failures once per workflow (#230)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L21 — bun failure names tests and first error; disk-full is a runner problem | R | Bun test/error extraction and disk-full class protect readable cause attribution; showing only exit status fails. |
| L46 — extracts common runner-neutral output: %s | R | Independent expected names across Jest/pytest/Go/Rust/Mocha output preserve runner-neutral parsing; one runner-specific regex fails. |
| L60 — annotations come first, project patterns work, and output is bounded | R | Annotation precedence, 20-test/40-error caps and custom-regex config validation protect bounded useful diagnostics; unbounded logs or bad capture patterns fail. |
| L87 — external checks show summaries; unavailable logs use annotations; superseded cancellation is informational | R | External summary, annotation fallback and superseded informational error distinguish third-party and replaced failures; classifying external as retryable runner fails. |
| L102 — runner signature: %s | R | Runner shutdown/lost-host/exit137 signature table guards machine-failure classification; misclassifying test bugs is checked by later mixed-failure case. |
| L112 — recorded failed-check read follows log redirect without sharing authorization | R | Redirect request strips authorization while original API request authenticates and sha reaches GraphQL; forwarding GitHub token to log host fails. |
| L175 — logs keep their last 3000 lines, stop at 5 MB and warn on Actions read or expired logs | R | 3000-line tail, 5MB bound and 403/404/410 warnings protect bounded expired Actions logs; allocating full oversized log or implying no failure fails. |
| L193 — a redirected log retry discards its error body without buffering it or forwarding authorization | R | 503 download cancels body with <=1 pull before retry, strips authorization and returns final log; buffering error stream or forwarding token fails. |
| L229 — historical cancellation uses the suite branch head, and each matrix leg is retained once | R | Branch-head supersession and matrix-id dedup retain mac failure beside cancelled linux; collapsing distinct matrix legs fails. |
| L273 — a final exit-code annotation cannot hide an earlier causal test error | R | Earlier causal Expected/Received text survives 80 successful lines and final exit-code annotation; last-line-only cause selection fails. |
| L290 — known failures match exact check names and test names or error blocks, keeping external checks external | R | Exact check+pattern maps known root cause while mac and external remain failure/external; loose registry matching fails. |
| L310 — rerun decision %j at attempt %s | R | Class/attempt table gates rerun and root-cause tickets, refusing second attempt or unavailable evidence; repeated or unknown reruns fail. |
| L336 — known failure config rejects invalid registry entry | C | Known-failure registry syntax validation belongs in config.test.ts invalid values: move regex, missing/invalid ticket and unknown-key rows there before retiring declaration. |
| L345 — a known test or runner signature cannot hide an unknown failure in the same job, even beyond display limits | R | Unknown failure after 20 known names or runner signature forces failure and refuses rerun; display truncation hiding an unknown root cause fails. |
| L363 — every matched root-cause ticket is included when multiple known failures share a job | R | Two matching known failure patterns return both ticket ids; reporting only first root cause fails. |

#### [`packages/core/test/config.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/config.test.ts)

History: `daf007f feat(ci): rerun tracked flaky failures once per workflow (#230)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L16 — spec title styles default to N, accept totals explicitly, and reject other values | R | N default, explicit N/M and rejected styles plus template key guard spec naming configuration; accidentally restoring legacy totals by default fails. |
| L29 — silence and quiet thresholds are independently configurable positive minutes | R | Independent12/50 silence/quiet values and zero rejection guard separate liveness policy; reusing silence threshold for quiet fails. |
| L36 — a minimal file gets the protocol defaults | R | Literal complete minimal-config default object independently fixes public defaults, including no implicit runtime/profile; changing default approval or job state fails, despite inventory-like shape. |
| L83 — the parked label is configurable | C | Parked on-hold parsing duplicates configurable-label use in fleet/status plus defaults object; carry custom key row into config minimal/default table before removing standalone invocation. |
| L88 — every missing key is named at once | R | Exact four missing-table/key diagnostics guard aggregate validation; first-error-only parsing fails. |
| L97 — invalid values name the key and the expected shape | R | Wrong slug/repo/runtime list/threshold/check-command types produce named shape errors; accepting malformed project gates fails. |
| L115 — a misspelled key in a known table is reported; unknown tables are left for newer readers | R | Known-table typo errors while future unknown table is tolerated guard forward compatibility; rejecting extension tables or ignoring typo fails. |
| L122 — the secrets a project's workers expect: names only, upper snake case | R | Secret names trim/dedupe and reject Armada credentials/lowercase/values guard names-only worker contract; storing secret values in config fails. |
| L134 — the plan policy, its two labels and the brief's conventions file | R | Plan labels/preapproval and conventions path values plus collision/traversal rejection guard policy configuration; ambiguous labels or outside-repo file fails. |
| L158 — which merges and which kinds of tickets need the owner, in plain words | R | Plain language merge/validation rules trim correctly and reject empty/unknown then-key; silently dropping owner requirement fails. |
| L177 — the template init writes is a valid file for the project it names | R | Generated TOML parses to independent profile/routing defaults with commented policy examples; unusable init template or accidental runtime/model default fails. |
| L232 — native Conductor project and base overrides are optional and reject invalid ids or branches | R | Project id/base branch overrides accept safe names and reject hidden/lock/path forms; unsafe native launch base reaches runtime if broken. |
| L250 — Conductor profiles need an agent, a model and an effort, and the default must exist | R | Missing effort/nonbool fastMode/default unknown/typo diagnostics guard profiles before launch; invalid profile accepted fails. |
| L262 — profile when rules are optional nonempty strings and replace the need for a routing default | R | Semantic when strings trim/reject empty/types and permit route without default; forcing mechanical fallback against plain-language policy fails. |
| L275 — a profile runs on conductor or claude-code, and a claude-code profile runs claude | R | claude-code runtime maps to Claude and rejects Codex/cloud; impossible harness/runtime profile fails. |
| L295 — Herdr profiles require a supported harness and default extra arguments to an empty list | R | Herdr explicit extraArgs preserve spaces and omitted list defaults empty with harness-specific profile shape; mutating argv silently fails. |
| L332 — Herdr permissions are optional, validated, and cannot claim ask with a bypass flag | R | Ask/full enum and ask+legacy-bypass conflict guard honest authorization mode; claiming ask while bypassing native permissions fails. |
| L380 — DeepSeek profiles accept DeepSeek models across providers | R | DeepSeek-provider model strings, no overriding argv and optional OpenCode/DeepSeek model guard interactive preflight contract; admitting argv model override fails. |
| L407 — Herdr profile and routing values name their invalid keys | R | Invalid Herdr harness/argv/missing route/default produce exact key problems; unknown profile launch selection fails. |
| L428 — routing rules need labels and a profile, and a default_profile for the tickets they miss | R | Routing labels/profile/default and typo error table guards deterministic routing; rule silently dropped or unmatched tickets stranded fails. |
| L444 — broken TOML reports where it broke | R | Broken TOML has line/column diagnostic; exposing opaque parser exception fails. |
| L449 — declared reservation keys are optional, descriptive and unique | R | Reservation descriptive/unique/numbered shape rejects duplicate key and wrong boolean; ambiguous shared allocation rule fails. |
| L460 — tracker lint is opt-in with configurable defaults and rejects invalid rules | R | Opt-in lint severity/custom fields and invalid heading/parts/size/unknown checks guard ticket authoring rules; ignored opted-in error mode fails. |

#### [`packages/core/test/credentials.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/credentials.test.ts)

History: `69a60ab feat(cli)!: reach the fleet's live data only through the Armada API (#55)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L5 — GitHub falls back from GITHUB_TOKEN to GH_TOKEN to the gh login, which is asked only when needed | R | Resolved value/source matrix and zero gh calls under env tokens protect precedence and lazy fallback; unnecessary gh invocation or GH_TOKEN overriding GITHUB_TOKEN fails. |
| L20 — the Linear key: the environment, then Armada, then the credentials file; retired keys are never read | R | Linear env/Armada/store matrix plus retired-token absence protects one resolver and retired database-secret removal; reading obsolete Turso credentials fails. |
| L43 — a missing key is reported by the variable to set, never by a value | R | Missing-key name and auth-login guidance guard actionable secret-free errors; emitting a secret rather than variable name fails. |
| L51 — the Armada API is built in unless ARMADA_API_URL or [api] url names another; ARMADA_API_KEY beats the stored sign-in | R | Default/config/env URL and env-key/store-session matrix preserve self-hosting and sign-in precedence; selecting wrong API or weaker key fails. |
| L81 — a stored sign-in is used only for the Armada that issued it; the environment's key goes anywhere | R | Issuer-bound stored token returns null elsewhere while explicit env key works; reusing stored token at another Armada fails. |

#### [`packages/core/test/dashboard-facts.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/dashboard-facts.test.ts)

History: `01afa00 feat(dashboard): a clear overview and a live fleet that scrolls back 24 h (#98)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L9 — one recorded forge call carries files, exact totals, mergeability and completeness | R | Single recorded forge request carries 150/12 totals, per-file 8/3 counts, incomplete warning and status progress; substituting page totals for PR totals fails. |
| L57 — a capped checks connection preserves aggregate failure even when failing names are outside the page | R | Aggregate failure and checksComplete=false survive truncated check-name page; reporting green because failed check was outside first 50 fails. |
| L75 — health prioritizes failures, then overdue coordinator work, then silence | R | Health matrix prioritizes CI/conflict/blocked over silence and includes strict overdue boundary with idle/unknown coordinator; masking blocked work as on-track fails. |
| L91 — unknown legacy facts stay explicit in the overview | R | Exact null progress/health/PR facts and unknown coordinator on missing report protect honest legacy answers; replacing unknown with empty/success fails. |

#### [`packages/core/test/deferred-launch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/deferred-launch.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L38 — deferred launches wait for every blocker in the stored reading, wake with a stable id and clear on claim | R | Hidden in-flight id, stable awakened inbox id/ETag and claim cleanup through two blockers and parked label prove deferred lifecycle; premature launch or duplicate wake fails. |
| L97 — deferred requests refuse unblocked tickets with an ordinary launch command, missing readings and false --after assertions | R | False after assertion, missing snapshot and already-unblocked errors leave store empty; accepting unverifiable deferred request fails. |
| L110 — fleet checks deferred requests against server facts and reports ownership without accepting a supplied author | R | Authenticated user/api-key identity owns request despite rename, coordinator filtering and worker403 guard server authority; spoofing author or owner fails. |
| L156 — deferred requests refuse held work and the inbox withholds it after blockers close | R | Held-by-label/report/PR scenarios refuse second request and suppress wake after blocker completion; duplicate workers launched onto held tickets fail. |
| L187 — guided deferred profiles advertise usable commands in summaries and external-close wakes | R | Guided brief --prompt command survives summaries and external-close inbox wake; emitting unusable armada launch command for claude-code fails. |

#### [`packages/core/test/deploy.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/deploy.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L20 — old, old, new deploy runs smoke once and records failure with last output | R | Old/old/new readings cause one smoke at descendant SHA and final smoke-failed output; smoke at old revision or repeated health command fails. |
| L49 — deadline records timeout without wall time, retaining last output | R | Injected deadline reaches 60 seconds without smoke and retains last pending output; hanging deploy or lost failure detail fails. |
| L73 — failed descendants fail immediately; unrelated failures keep waiting; leases can be pending | F | Failure/error descendant cases assert immediate fail and pending smoke retries, but no unrelated failed SHA is supplied despite name. Add explicit unrelated failure followed by target success, asserting no early failure; current includes=true cases cannot detect wrong ancestry rejection. |
| L114 — deploy detail keeps only 30 lines and 4 KiB of valid UTF-8 | R | 30-line/4096-byte accented output guards user-facing bounded UTF-8 detail; byte slicing that exceeds cap fails (add astral boundary separately only if defect shown). |
| L119 — deploy targets validate live source, unique names, range and unknown keys | C | Deploy source exclusivity, duplicate names and timeout validation are config owner contracts: carry this full TOML table into config.test.ts before removing declaration. |
| L147 — fleet failure creates one deploy hold and inbox item; worker deploy calls are forbidden | R | Repeated timeout record yields one hold/inbox and worker deploy calls403; duplicate incident alerts or worker deployment mutations fail. |
| L166 — GitHub deploy adapter reads exact environment and SHA comparison distinguishes ancestry | R | Exact environment GraphQL argument and ahead/diverged comparison responses guard hosting-independent deployment adapter; wrong environment or accepting divergent SHA fails. |
| L209 — overlapping watcher finishes from a newer healthy deploy without polling or rerunning smoke | R | Healthy shared descendant bypasses live read/smoke/wait and records healthy; concurrent watcher repeating smoke fails. |
| L235 — transient shared-state and smoke lease errors retry until healthy or deadline | R | Lease/shared-state outage scenarios recover at 30 seconds or times out at 120 seconds with final state; turning transient failure into immediate terminal error fails. |

#### [`packages/core/test/digest.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/digest.test.ts)

History: `c42c298 feat(dashboard): send scheduled owner fleet digests (#225)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L5 — digest reads and sends reject worker sessions; sends without a configured channel explain the next step | R | Worker read/send rejection and missing-channel Notifications error protect coordinator-only digest access; workers sending organization notifications fail. |
| L13 — owner digest preserves titles, durations and links, translates fixed text and qualifies sampled estimates | R | Literal English/French snapshots plus sampled 30-minute estimate, insufficient samples/null medians and Slack escaping protect digest output; untranslated fixed text or confident under-sampled ETA fails. |

#### [`packages/core/test/dotenv.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/dotenv.test.ts)

History: `69a60ab feat(cli)!: reach the fleet's live data only through the Armada API (#55)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L4 — reads shell-style assignments; the last duplicate wins; broken lines are reported by number only | R | Literal parsed assignments include export/quote/duplicate behavior and only invalid line numbers; shell expansion or leaked invalid secret text fails. |
| L30 — updates keep comments, unknown keys and export, drop later duplicates, and append new keys | R | Exact updated file retains comments/unknown/export and removes duplicate/unset keys; damaging unrelated machine credentials fails. |
| L38 — any value round-trips through the parser, and values a shell would expand are single-quoted | R | Roundtrip and independent single-quote assertions protect shell-safe value serialization, newline rejection; expanding HOME when sourcing fails. |

#### [`packages/core/test/fleet-api.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/fleet-api.test.ts)

History: `fceaf43 feat(secrets): mask worker output and messages (#239)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L30 — masks prose from older clients, using injected project values plus patterns | R | Persisted events/inbox/validations redact known and patterned secrets despite old client; trusting client-only masking leaks and fails. |
| L92 — release validates guards and always checks a worker caller's session identity | R | Malformed release guard400, old worker/replaced handle released=false, no event and valid generation release prove fencing; stale worker releasing new claim fails. |
| L139 — a worker session claims, reports, asks, validates and releases its own ticket, and nothing else | F | Own-worker case actually claims/asks/releases and rejects coordinator operations/foreign claim; it never reports or validates despite name. Add allowed report and own validation plus foreign-ticket denials here or narrow claim; wrong allowlist for report can currently pass. |
| L164 — shipping detail crosses the API without changing the legacy timestamp response | R | Shipping stage persisted but lastEventTimes shape unchanged; invalid phase/stage leaves event count unchanged. Incorrect payload widening legacy read or accepting stage outside shipping fails. |
| L198 — a repeated shipping report and same-session reclaim preserve explicit review; new work clears it | R | Review survives repeated report/same generation but clears implementing/replacement handle/session; carrying previous generation review into new work fails. |
| L249 — times are the server's, whatever the terminal's clock says | C | Claim server-time assertion should join claim/report lifecycle in first transport scenario, alongside heartbeat server-time keeper. Carry explicit different client/server clock row before removing single-assertion invocation. |
| L256 — a malformed request is refused, and nothing is written | R | Bad ticket/phase/SHA/inbox threshold/unknown op return400/404 with no events and parseProject validates/canonicalizes; malformed authenticated writes persisted fail. |
| L280 — worker ownership is authenticated, legacy workers stay unowned, and resume preserves a handover | R | Authenticated coordinator overrides spoofed request, transfer survives resume and legacy stays null; worker choosing its own ownership fails. |
| L305 — names validate before writes; an older organization claim belongs to default | R | Invalid coordinator names fail before event writes and absent org-name defaults; accepting wrong case/oversize roles fails. |
| L332 — take refuses the whole batch on missing or stale owners, then records handover without changing phase | R | Whole-batch take conflict leaves owner, valid transfer yieldsthree handovers but unchanged latest phase/liveness; partial transfer or fake heartbeat fails. |
| L376 — inbox filters owners with active null taking precedence, and retains unowned and legacy reads | R | Active handle ownership wins stale item/launch owner, unowned and projectwide entries retained, legacy read sees all; filtering useful unowned work away fails. |
| L458 — expired launch notifications are scoped and named presence keeps distinct sessions | R | Expired notifications affect only front launches and two named sessions remain distinct; one coordinator ending another launch fails. |
| L498 — scoped event reads exclude other owners before pagination, include unowned events and validate scope | R | Owner scope excludes rows before limit 1 pagination, unowned remains and invalid scope400; pagination starving own coordinator fails. |
| L562 — fleet client resolves the coordinator preference for each request | R | Resolved name changes front->back between requests; caching machine coordinator preference inside client fails. |
| L582 — inbox ETag refreshes ownership when an unowned ticket is taken without changing visible entries | R | Ownership-only transfer produces fresh200 not304 and item.owner updates; stale ETag hiding handover fails. |
| L620 — queue operations round trip through Armada and remain coordinator-only | R | Queue client/state/lease/retry/finish/remove roundtrip, worker403 and malformed entries400 guard API-level transport/admission; bypassing lease or wrong noTicket combination fails (database atomicity owned dashboard). |
| L681 — workers reserve, list project holders and unreserve only their own ticket; malformed allocations are refused | R | Worker can list holders but reserve/unreserve own ticket only; malformed allocation400 and own removal1 protect resource scope; freeing another worker's number fails. |
| L716 — events/since is a scoped safe read with bounded pages, filters, look-back and 304 | R | Event ids/pages/filter/lookback and304 plus malformed/worker refusal protect streaming endpoint; heartbeat inclusion or unbounded limit fails. |
| L767 — a worker's declared paths appear in the plan with overlaps from the stored reading | R | Declared paths persist in plan and stored PR incomplete overlaps appear, unsafe-path matrix400 and foreign worker403; traversal or false certainty warnings fail. |
| L861 — merge cleanup keeps paths declared by a replacement claim when the generation guard refuses release | R | Injected replacement during release leaves new paths/claim intact and returns no old handle; merge cleanup deleting new worker provenance fails. |
| L897 — hold API is organization-only, validates reasons and refs, and preserves the clearer | R | Holds organization-only, malformed kinds/ref/reasons400, nondismissable ordinary answer and idempotent clear preserve audit; bypassing durable hold via answer fails. |
| L936 — a coordinator whose CLI does not read holds cannot acquire or renew the merge lease | R | Old CLI merge acquire/renew refuses active hold409, explicit throughHold permits and other-operation unaffected; legacy coordinator bypassing shared pause fails. |

#### [`packages/core/test/fleet.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/fleet.test.ts)

History: `11ee2fa feat(fleet): show when main is red and which merge broke it (#204)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L17 — a closed blocker reveals ready, unspecified, parked and still-blocked dependents | R | Exact ready/unlabelled/parked/stillblocked sets exclude held/completed/PR work after blocker closes; announcing unsafe launch candidates fails. |
| L43 — a ticket is ready when it is not started and every blocked-by ticket is closed | R | Frontier matrix handles started/completed/canceled/triage and all closed blockers; launch with live blocker fails. |
| L61 — a blocker outside the program counts by the state recorded on the relation | R | External relation state controls frontier membership; ignoring nonprogram blocker fails. |
| L69 — tickets held by an agent, with an open PR, or with sub-issues are not on the frontier | R | Held/PR/parent excluded while child remains; launching duplicate or aggregate ticket fails. |
| L79 — a ticket carrying the configured parked label is off the frontier, ready label or not | R | Configured parked label toggles frontier and ready label cannot override; hardcoded parked name fails. |
| L90 — ranking puts the ready label first, then what a ticket unlocks | R | Ready-first/unlocks ordering with triage nonready guards coordinator priority; selecting low-value unrelated leaf first fails. |
| L121 — shipping stages prefer the current report, survive snapshot refresh, and fall back to PR checks | R | Explicit shipping review survives snapshot refresh while PR checks infer CI and replacement generation ignores old report; stage reset or stale review fails. |
| L188 — the phase label wins over the latest status line, which wins over inference | R | Label/status/inferred precedence matrix protects mixed tracker facts; using older status comment over current label fails. |
| L201 — a merged PR on an open ticket shows as merged unless the label says work restarted | R | Merged PR implies merged except explicit restarted implementing; losing continuing work or endlessly showing handed-back merged ticket fails. |
| L209 — silence counts from the last report, never while the worker waits on a human | R | Chatter/edit excluded from reports, heartbeat/new report renew silence, human wait suppresses and stale fallback flags; false stuck alerts after answer/report fail. |
| L260 — two claims since the last release flag a double claim; a release clears older claims | R | Two claims flag double-claim, release resets and new session selected; treating same ticket historical run as current collision fails. |
| L273 — time in phase starts at the first report of the current phase, not at the latest repeat | R | Since uses first contiguous implementing report rather than latest repeat or older run; understated phase time fails. |
| L286 — a live report newer than the tracker read wins the phase, the time in phase and the status | R | Live phase/since/status wins only when newer than snapshot; stale live event overriding refreshed label fails. |
| L310 — a claim after the tracker read puts a ticket in flight; a release or a merge takes one out | R | Post-snapshot claim enters flight and release/merge remove only older generations, exact flags/runtime shape; running stale ended worker fails. |
| L338 — main health tracks checked commits, required gates and the first red merge | R | Required check names/completeness, first red chain, skipped release commits and running fix matrix protect main health; aggregate optional failure hiding required green or missing gate marked green fails. |

#### [`packages/core/test/github.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/github.test.ts)

History: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L42 — combines classic and active requirements without duplicate checks or weakening approvals | R | Classic and active rules union checks, strongest review count and encoded branch URL guard merge safety; ruleset weakening existing protection fails. |
| L66 — \`classic ${status} falls back to active rules\` | R | Classic403/404 preserves active rules and unavailable marker; missing classic permissions disabling all protection fails. |
| L75 — empty active rules still retain classic-only requirements | R | Empty active rules preserve classic checks/reviews; empty ruleset mistaken unprotected repository fails. |
| L82 — reads paginated rules and respects a ruleset's allowed squash method | R | 100-row pagination preserves later three reviews and excludes squash when ruleset allows only rebase; reading first page only fails. |
| L106 — unreadable active rules fail rather than claiming compatibility | R | Active rules403 rejects rather than claims compatibility; inaccessible protection treated permissive fails. |
| L114 — ruleset and classic independent approval flags survive a zero review count | R | Independent code-owner/last-push flags survive zero approval count; conflating review count with all review requirements fails. |
| L134 — finds a known ticket id with any team key, in any case and position | R | Known branch id handles case/position/digit team key; miss-associating nonconventional branch fails. |
| L140 — ignores ids that are not in the program or glued to other words | R | Unknown/glued identifiers rejected; linking foreign ticket or incidental substring fails. |
| L147 — a timed-out GitHub query retries once with the same request | R | Timed-out forge query recoverstwo calls with actual PR output; adapter accidentally disables shared safe retry fails. |
| L162 — reads open and recent pull requests with their CI rollup and mergeability | R | Authorization/owner-name variables and literal PR/draft/CI/mergeable matrix guard GitHub mapping; wrong rollup/status interpretation fails. |
| L175 — an unknown repository is an error, not an empty list | R | Null repository is named error; showing empty healthy PR list for missing repository fails. |
| L183 — GitHub reads recover from a temporary HTTP status | R | HTTP502 adapter recovers with1,000 ms backoff and PR output; omission of retryStatus wiring fails independently of shared http unit contract. |
| L201 — reads default-branch history in the forge snapshot and focused health adapter | R | Default branch history maps CheckRun/StatusContext/no rollup and focused health sees red first PR #17; wrong branch or dropped history/completeness fails. |

#### [`packages/core/test/heartbeat.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/heartbeat.test.ts)

History: `1249b4c feat(fleet): distinguish code review from CI while shipping (#176)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L21 — the API uses server time and current worker identity, rejects other tickets and stale claims | R | Server-time heartbeat, session/ticket/claimedAt fences and single event protect authenticated liveness; stale generation renewing replacement fails. |
| L65 — pings immediately and on schedule, pins the claim, and stops with its parent | R | Immediate/scheduled0/300k/600k pings pin returned claim and stop after parent exits at 11 minutes; wrong parent/lost generation heartbeat loop fails. |
| L88 — stops on session end or auth refusal; transient failure retries without losing the pinned claim | F | Released and merged rows return identical inactive mock and only3-call count, with no observed claimedAt on retries despite name. Carry an explicit input capture asserting pinned timestamp after transient error; consolidate released/merged duplicate row labels or narrow them. |
| L114 — server liveness does not change reports, phases or inbox items; silent and quiet are distinct | R | Fresh heartbeat suppresses silent, laterquiet differs, report timestamps/phases/inbox unchanged and released claim inactive; heartbeat faking progress fails. |
| L150 — %s tolerates a stopped heartbeat while waiting and grants a fresh silence window on resume | R | Waiting-phase answer/resume grant precise 15-minute silence windows even with stale heartbeat and distinct quiet threshold of 5; stopped background heartbeat falsely alarmed while waiting fails. |
| L209 — quiet respects configured thresholds and suppresses human-waiting phases without resolving anything | R | Awaiting approval plan preserved, working quiet threshold configurable and coordinator self excluded; liveness polling resolving pending human work fails. |

#### [`packages/core/test/herdr-profile.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/herdr-profile.test.ts)

History: `a32c262 feat(cli): set up local harnesses and explain first-run questions (#160)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L19 — adds each native full-permission flag once and keeps unrelated arguments | R | Native permission argv deduplicates bypass flags and retains unrelated args for four harnesses; invoking wrong native permission mode fails. |
| L34 — omitted permissions preserve legacy explicit flags | R | Omitted permissions preserve existing Claude/Codex bypass flags; silently changing legacy launch authorization fails. |
| L45 — sets ask, removes the known legacy bypass, and leaves other profiles and comments alone | R | Selected TOML profile loses bypass while others/comments persist and parser reads ask; permission repair corrupting other profile fails. |
| L75 — replaces only named existing permissions and handles a CRLF profile | R | CRLF insertion and named-only replacement preserve other explicit ask choice; reserializing newline format or changing unselected permissions fails. |

#### [`packages/core/test/http.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/http.test.ts)

History: `527a4ee fix(core): retry temporary Linear, GitHub and Armada failures (#210)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L7 — caller cancellation inside a transport wrapper is not retried as a deadline | R | Caller AbortError identity and one fetch guard cancellation versus deadline; retrying cancelled requests fails. |
| L26 — a safe read retries once with a fresh deadline, then returns the answer | R | Answer, fresh signals, deadlines5000/10000 and aborted first signal prove per-attempt safe read budget; reusing spent deadline fails. |
| L54 — exhausted safe reads name the deadline and retry, preserving shorter configured limits | R | 400ms limits on both attempts plus exhausted diagnostic guard configured short deadline; hardcoded10s retry fails. |
| L77 — the deadline covers an unresponsive fetch and response body, even with an injected transport | R | Unresponsive fetch and unresponsive body both fail two attempts with correct reads; deadline limited to headers fails. |
| L111 — connection failures retry safe reads; unsafe requests and semantic errors are not replayed | R | Connection retry count plus semantic/status no-replay matrix protects unknown writes and parser failures; retrying unsafe POST fails. |
| L166 — status retries wait twice, drain failed responses, and leave exhaustion and unsafe POSTs to the reader | R | Waits1000/3000, used failed bodies and bounded notices plus unsafePOST once guard status policy; leaking bodies or retrying every POST fails. |
| L223 — Retry-After honors seconds and dates, caps waits, refuses long 429s, and cancellation stops retries | R | Retry-After seconds/date/jitter/cap and long429 refusal plus cancellation during sleep protect provider cooldown; exceeding accepted delay or ignoring cancellation fails. |
| L295 — repeated Retry-After headers stay within the call's 14 s wait budget | R | Repeated10s headers spend only14s on503 and refuse excess429; per-attempt cooldown resetting total budget fails. |

#### [`packages/core/test/inbox.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/inbox.test.ts)

History: `a5823d8 feat(cli): scope named coordinators to their own work (#243)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L48 — mine resolves ticket ownership before filtering entries, flight and ETags | R | Mine resolves active claims, latest launches and item ownership before filtering flight/items and ETags; reassignment removes an unowned alarm. Protects role routing from stale owners and unrelated wake-ups. |
| L129 — answering steering requests closes only the request, never approves the plan or acts on Linear | R | Answering merge, release and plan-change steering requests closes only their items, leaves the plan open and performs no Linear writes; protects acknowledgement from approving or acting on work. |
| L157 — a question blocks the worker, reaches the inbox and the ticket; the answer closes it in both | R | Checks blocking labels, full question/options, exact answered item, tracker answer and resumed implementing phase; protects the question/answer handoff from losing content or advancing before an answer. |
| L210 — answering a ticket resolves its open questions; a note is recorded, never left open | R | Ticket answers clear both open questions; a note is stored resolved, and answering a hand-back is refused. Protects notes from creating unanswered questions and answers from dismissing merge gates. |
| L242 — answer resolves only a confirmed stale hand-back (%s) | R | Table distinguishes merged, closed, completed and canceled from open or unknown hand-backs, with zero Linear writes; protects open merges from being dismissed as stale. |
| L287 — without Armada a question still blocks the ticket; an item id cannot be answered, a ticket can | R | With Armada unavailable, asking still blocks Linear, item-id answers are refused and ticket answers post with a warning; protects authoritative tracker progress during optional API outages. |
| L297 — releasing a ticket resolves its open questions | C | Release cleanup duplicates the requests.test.ts direct-answer/release lifecycle. Carry this question-only release fixture into that keeper before removing this declaration; the owner-request fixture alone is insufficient. |
| L309 — inbox and status ignore a completed merge's stale handle and agree on live work | R | Checks exact agreement between inbox and status flight: replacement/uncached claims remain, completed/canceled/released/merged work does not, and the ETag is stable. Protects watch termination despite stale handles. |
| L384 — closed tickets cannot return through pending launches; fresh launches and uncached claims stay followed | R | Closed-ticket launches are excluded while fresh launches and uncached claims remain followed; protects Done work from returning through stale launch tokens. |
| L436 — watch finishes after the last ticket closes even when its handle remains open | R | Watch returns nothing after the final ticket closes and does not read idle events or answer history; protects termination and avoids unnecessary history queries with a stale open handle. |
| L484 — an inbox read heals merged and completed hand-backs using only its project snapshot | R | Snapshot cleanup resolves this project’s merged/completed hand-backs while leaving another repository/project untouched; protects completion repair from crossing project scope. |
| L521 — only the reading coordinator's exact nonempty handle is excluded from silence, not open items | R | Only the coordinator’s exact nonempty handle suppresses its silence alarm, while its open questions remain; protects another worker sharing the workspace prefix from being hidden. |
| L563 — open items and silent workers, oldest first; waiting and released workers are not silent | R | Checks oldest-first hand-back/silence/question ordering, exclusions for waiting/released workers and other scopes, and a fresh alarm window after an answer; protects liveness routing from duplicate or premature alarms. |
| L639 — a worker launched that never claimed is in flight at once, and not started after not_started_minutes | R | Launch-state table distinguishes unused/used tokens, claimed/revoked/latest/expired launches and the configured not-started threshold; protects startup alarms from following obsolete launch generations. |
| L700 — --wait asks Armada every 15 s, answered 304 while nothing changed, until a new question or the timeout | R | Checks 304 polling, the 45-second wake-up, 40-second timeout, 15-second scheduling and coordinator presence; protects polling from repeated old-question wake-ups or an unbounded long poll. |
| L762 — without --wait the inbox is read once | C | The single inbox call with null wait is the default-mode row of the preceding polling contract. Carry that row into the polling keeper before retiring this declaration. |

#### [`packages/core/test/insights.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/insights.test.ts)

History: `8466d22 feat(dashboard): build the Night watch look across the dashboard (#128)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L50 — is the nearest rank: always one of the values | R | Public quantile API uses four independent literal nearest-rank oracles (empty, singleton, unsorted even-size median, ten-value p90). This pure scalar boundary is cheaper than claim/merge aggregation and survives implementation changes; no redundant stronger layer proven. |
| L71 — counts merges per UTC day of the range, and the previous period's | R | Literal current/previous UTC dates/daily counts/unique ticket ordering guard throughput windows; counting out-of-range merge fails. |
| L91 — groups them by ISO week, named by its Monday | R | ISO weeks named Monday and ticket allocation guard weekly trend semantics; grouping Sunday/current day rather than Monday fails. |
| L100 — is the same stretch of time a period earlier: a steady pace reads flat early in the day | R | Early-day current six / previous six plus zero change guard equal elapsed windows; full previous day comparisons falsely imply slowdown fails. |
| L112 — runs from the first claim since the previous merge, even before the range | R | Claim-release-reclaim/repeatedmerge cycles and independent p50/p90/daily arrays guard cycle definition; reset on reclaims or counting unclaimed cycle fails. |
| L150 — adds up each merged ticket's stretches between its reports | R | Independent phase durations exclude overnight unheld time and unfinished work; accumulating release gaps as implementation fails. |
| L185 — the coordinator's: a question, plan or hand-back to its resolution; the open ones apart | R | Coordinator count/p50/p90/open and old open wait durations guard actionable delay reporting; mixing open waits into completed percentile fails. |
| L208 — the owner's: a validation to its decision; a superseded one is no wait | R | Owner approved/superseded/open results exclude superseded validation; treating replaced design as owner latency fails. |
| L236 — a merged ticket handed back on one head; each new head after the hand-back is a redo | R | Repeated same SHA vs new SHA first pass rate/redo count protects review iteration metrics; repeat report as redo fails. |
| L262 — a gap longer than the threshold while working, not while waiting, and the one going on now | R | Working gaps and ongoing silence count two, workerHours 28 and rate anchor observation metrics; human-approval hour counted silent fails. |
| L287 — a released ticket has no silence going on, and a gap after a release is none | R | Release gap excluded and workerHours two guard no-worker time; orphan ended session contributing ongoing silence fails. |
| L336 — compare cycle time, re-plans, new heads and silences per profile | R | Per-profile exact cycles/replans/new head/gaps and denominators protect comparative fleet metrics; runtime profile facts mixed across workers fail. |
| L364 — and per harness, from the session's runtime | R | Harness keys normalize Conductor/Codex/claude-code with independent hours/counts; putting local Claude into Conductor fails. |
| L374 — ranks the stretches in a phase that waits on someone, the one going on included | R | Ranked wait durations include current validation and exclude released blocked worker; stale wait shown ongoing fails. |
| L404 — tickets are told apart by project, and percentiles take every project's | R | Same ticket id across two projects remains separate and percentile three hours; project-unqualified identity collapse fails. |
| L415 — this week's merges, their median, the change from last week | R | Summary three versus two / change 0.5 / median 100 minutes and empty previous period null protect headline metrics; denominator zero or merge without a claim counted cycle fails. |

#### [`packages/core/test/jobs.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/jobs.test.ts)

History: `141e2d7 feat(dashboard): show a ticket's long jobs on its session page and the overview (#235)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L11 — parses the last status line and estimates completion from elapsed progress | R | Literal ETA from 37/120 and last-line 2/4 plus no-estimate/invalid-state table protect external job protocol; parsing noise or dividing zero fails. |
| L30 — validates configured commands and positive job thresholds | C | Job start/stop/status/threshold TOML checks belong in config.test.ts; carry default 15 minutes / null maximum and all invalid rows before removal. |
| L42 — worker jobs are limited to their own persisted ticket, including reads and forged observations | R | Own-job list/start/observe with forged author, foreign id and immutable runner ref guard worker scope; modifying another ticket job fails. |
| L75 — the client preserves durable jobs across sessions and project boundaries | R | Client start/observe/list roundtrip, other-project null and terminal stopped state protect durable job lifecycle; reopening finished job fails. |
| L98 — an overdue job stays visible when its ticket is Done; status only reads stored job observations | R | Stored running job on Done ticket has overdue=true, max 0.5/ref/progress and remains unchanged; hiding orphan external job or polling mutatively fails. |

#### [`packages/core/test/labels.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/labels.test.ts)

History: `374bf6a fix(core): create configured plan labels during init (#233)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L21 — the program's team group wins over a shared one, another team's is ignored, and gaps are named | R | Team group wins shared/foreign ignored and literal missing phase/runtime/policy errors; creating labels in wrong team or trusting foreign group fails. |
| L51 — creating the missing labels puts new groups in the program's team and values under their group | R | Created mutation input places team group/values correctly, full re-read passes; grouped label payload wrong scope fails (literal names are protocol defaults, not arbitrary inventory). |
| L85 — policy plan labels are checked, created as plain team labels, and left unchanged when present | R | Default/custom/disabled policy label table checks plain team labels, idempotence/shared case variants; duplicate label creation or accepting groups as values fails. |
| L130 — label-group reads retry temporary failures while label creation is sent only once | R | 503 label reads retry3 withone/three seconds but creation once; replaying nonidempotent label mutation fails. |

#### [`packages/core/test/linear-write.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/linear-write.test.ts)

History: `5f634f2 feat(cli): pre-approve plans at launch (#200)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L26 — looks up an ungrouped label by name in the ticket's team, then the workspace | R | Ungrouped label filter and own team then shared fallback exclude foreign; worker approvallabel drawn from another team fails. |
| L53 — creates a child issue and updates its title through the only write adapter | R | Child creation result maps uuid/id/url and exact create/title mutation variables; misparented spec or dropped title update fails. |
| L77 — a create refused or timed out is never replayed | R | Create refusal and timeout with1call guard nonidempotent Linear writes; duplicate issue creation fails. |
| L93 — a timed-out query retries once; comments fail closed when reconciliation cannot be read | R | Viewer timeout retries and comment reconciliation failure stops after bounded read; posting again without confirming first comment fails. |
| L110 — reads a ticket with its labels (phase names in any case), team workflow, claim and linked pull request | R | Ticket labels/workflow sorted, claim/runtime/PR mapped from GraphQL; wrong phase group or lost comment ownership fails. |
| L168 — reads every label and comment past the first page, so a claim routes on all labels and sees every claim | R | Later label/comment page cursors and partial warning flags guard complete claim/routing facts; first page hiding claim or silently accepting incomplete pages fails. |
| L233 — writes state, assignee and label changes in one issueUpdate; team labels shadow workspace ones | R | Single update maps added/removed/state/assignee GraphQL keys, team shadows workspace and not-found null; replacing all labels incorrectly fails. |
| L269 — comment retries reconcile a lost response before posting again | R | Lost comment response reconciles one new id, safe absent retries and old-only matches refuse; duplicate comment or old matching record falsely confirming new fails. |

#### [`packages/core/test/linear.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/linear.test.ts)

History: `f5ff024 feat(cli): check ticket readability before launch (#238)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L18 — status lines accept any dash and markdown, map legacy words, and reject unknown phases | R | Literal markdown/legacy dash parser accepts shipping and ignores answer/note as status; coordinator reply moving worker phase fails. |
| L32 — claims read runtime, session, branch and start | R | Claim fields/emphasis/escapedunderscore values preserve opaque handles; underscore normalization targeting wrong session fails. |
| L52 — walks every page and level under the root, then reads comments of in-flight tickets only | R | Full paginatedtree auth/cursors and in-flight-only comments yield 13 issues and correct PR/label/relation facts; lost leaf/frontier or excessive comment read fails. |
| L81 — retries without the delegate field when the schema rejects it | R | Delegate schema fallback removes delegate thereafter but yields 13 issues; unsupported field breaking older Linear schema fails. |
| L99 — relations longer than one page are read to the end, so a blocker on the last page still counts | R | Two extra relation pages keep 121 blockers incl last started #499 and no warnings; hidden final page blocker permitting unsafe launch fails. |
| L137 — a failed read of a later page is a warning that keeps what was read | R | Semantic laterpage failure preserves known blocker with explicit warning; losing known data or hiding incompleteness fails. |
| L154 — Linear unreachable on a later page fails the read instead of warning once per issue | R | Unreachable relation page propagates bounded named failure; masking network outage as per-issue completeness warning fails. |
| L171 — a request with no answer before the timeout fails naming Linear | C | Initial timeout duplicates named transport propagation of preceding laterpage outage. Carry root-query timeout row there before removing separate declaration; shared http owns exact deadline mechanics. |
| L181 — a missing program root is an error naming it | R | Missing root names DEMO-404 instead of empty program; coordinator sees missing tracker program as idle if broken. |
| L192 — phase and runtime labels are read only inside the configured groups | R | Configured foreign label group yields no phase/runtime; plain identical label name outside group taking authority fails. |
| L232 — reads only what changed since, what a webhook named and new subtrees, then merges it into the last reading | R | Changed/touched/new subtree queries preserve unchanged tickets/comments, exclude foreign, update timestamp and deduplicate ids; incremental refresh dropping unchanged fleet or foreign ingestion fails. |
| L366 — one lookup verifies the current parent chain, including a fresh intermediate parent | R | One current ancestry lookup finds fresh intermediate parent with correct auth/vars; cached tree falsely rejecting new ticket fails. |
| L374 — foreign, parentless and missing tickets are refused | R | Foreign/parentless/missing ticket returnsnull; claiming outside program fails. |
| L380 — deep ancestry continues without rereading the ticket, and cycles are refused | R | Deep ancestry continues via ancestor lookup and cyclic tail refused; fixed-depth membership truncation or loop fails. |
| L402 — Linear failures propagate instead of becoming a membership refusal | R | ProgramIssue API errors propagate rather than membership null; incorrectly telling worker foreign ticket on service outage fails. |
| L414 — CLI description batches paginate flat reads and refuse missing tickets or a stalled cursor | R | Description batch id deduplication, cursor advancement, missing ticket and empty input behavior protect completeness; partial lint pass or stalled pagination fails. |

#### [`packages/core/test/lint.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/lint.test.ts)

History: `f5ff024 feat(cli): check ticket readability before launch (#238)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L16 — readable tickets and both spec formats pass; only the spec name counts toward the limit | R | Readable accented/spec/OAuth titles and markdown variants pass with name-only limit; restricting user language or counting spec prefix against 60 fails. |
| L27 — reports missing section and each missing part with an actionable fix and chosen severity | R | Missing section / four parts actionablefix and severity error guard ticket design admission; technical detail satisfying summary requirements fails. |
| L40 — extracts the configured section and ignores headings and parts in fenced examples | R | Fence exclusions, custom French summary and CRLF boundary guard markdown extraction; example heading counted actual requirement fails. |
| L52 — flags code tokens in titles, overlong names and malformed spec numbering | R | Code-token/length/spec number matrix rejects unreadable title and unsafe numbering; accepting path/camelcase as plain English fails. |

#### [`packages/core/test/machine.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/machine.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L25 — release reservations serialize commands, remember time, and recover a dead holder | R | Concurrent release notices serialize to one, dead holder recovers and competing cleanup retains lock; duplicate daily notices or stealing cleaning lock fails. |
| L65 — the store lives under an absolute XDG_CONFIG_HOME, else ~/.config, else nowhere | R | Absolute XDG then HOME then null path matrix protects machine store placement; writing relative credential path fails. |
| L71 — the credentials file is created 0600 in a 0700 directory and updated without losing lines | R | Filesystem0600/0700, open-file repair and exact preserved unrelated lines guard credential isolation; publicly readable keys or truncation fails. |
| L94 — config.toml is created once from a commented template and parsed with the unknown-key rule | R | Create-once template, existing French config preservation and exact unknown-key problems protect personal configuration upgrade; overwriting user choices fails. |
| L123 — one watch per project: a live lock is refused, a stale one taken over, the state kept between runs | R | Live/stale project lock ownership and persisted merged state plus corrupt JSON fallback protect watch recovery; old owner deleting replacement lock fails. |
| L159 — named coordinators keep independent watch locks, state and checkout preferences | R | Distinct named-role locks/state/checkout preferences and legacy default filename equivalence protect multiple coordinators; sharing front/back lock fails. |

#### [`packages/core/test/merge.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/merge.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L274 — name | R | Twelve independent checklist rows assert specific rejection, zero forge merges and zero Linear writes: wrong hand-back/head/PR/title/state/check/review/base must refuse before mutation; no mock supplies the rejection itself. |
| L284 — a head behind its base is test-merged with the local commands; a failure names the command | R | Behind-base local test merge uses pinned BASE/HEAD and declared commands, names failing verify and permits proven dry-run; merging untested divergence fails. |
| L299 — a dry run checks everything, reports hints and writes nothing | R | Dry-run reports removed-export hints but leaves forge/tracker untouched and skips after-close reads; accidentally performing merge or archival fails. |
| L325 — a failed post-close read warns without turning a confirmed merge into a failure | R | After-close tracker outage leaves merged=true with warning and no worker list; successful irreversible merge mislabeled failed and retried fails. |
| L341 — merges pinned to the handed-back SHA, closes the ticket and lists who to tell | R | Pinned merge SHA, Done/label cleanup, PR link, worker list, guarded archive and one live event/inbox cleanup protect complete merge handoff; accepting wrong head or leaving worker active fails. |
| L398 — post-merge clean-up failing %i times retries, then resolves or prints recovery | R | One/three cleanup outages retry 2/3 times with 2/4-second waits without second native merge, then resolve or show recovery; replaying merge on optional cleanup fails. |
| L421 — an inbox write failing after the merge event landed retries without recording a second merge | R | Failure after event write retries inbox cleanup with exactly one merge event and released handle; duplicate committed lifecycle event fails. |
| L449 — a GitHub 5xx is retried only after re-reading an unchanged open pull request | R | Transient GitHub rejection retries after unchanged open read and returns merged with two attempts; missing guarded retry or immediate false failure fails. |
| L458 — merge removes the configured ready label %s only | R | Custom ready-label table dry-run preserves all labels and successful merge removes only configured ready plus agent labels; hardcoded cleanup deleting unrelated category fails. |
| L481 — a 5xx after which the head moved stops without retrying or touching the ticket | R | 503 then moved head stops with one native call and no tracker write; unsafe retry against a changed revision fails. |
| L493 — success is only reported once GitHub shows the pull request as merged | R | Accepted auto-merge response remains open and tracker unchanged; marking accepted request as completed merge fails. |
| L503 — a pull request whose base moves while it is checked is not merged | R | Base SHA changed during repeated comparison prevents all native/tracker writes; merge checklist pinned to stale base fails. |
| L516 — a merge lock lost during the checklist stops before merging | R | Lease stolen during checklist refuses before forge.merge; obsolete coordinator mutating under expired ownership fails. |
| L529 — a pull request merged at another head is reported, and the ticket left open | R | Native merged response at different head refuses and leaves tracker open; claiming reviewed head shipped when another revision merged fails. |
| L540 — when GitHub cannot be read back after the merge, the output says it may have landed | R | Unreadable post-merge state reports may-have-landed and leaves tracker; unknown native outcome repeated or misreported fails. |
| L553 — signed in but Armada down refuses the merge; --no-lock merges and says so on the ticket | R | Signed-in Armada outage refuses before write while explicit noLock merges with durable comment/warning; silent unlocked fallback fails. |
| L570 — not signed in to Armada, the merge runs unlocked with a warning | R | Unsigned terminal can merge but emits exact unlocked warning; legacy offline behavior broken or implied lock taken fails. |
| L579 — two coordinators merging at once merge one after the other | F | Concurrent merges prove serialized timeline and both success, but fixture uses real setTimeout(0). Replace that scheduling yield with an explicit microtask/barrier; keep lease contention and first/second ordering assertions, so lock removal still fails without wall-clock dependence. |
| L644 — with a rule, the coordinator says why it merges on its own, and the ticket records it | R | Configured merge policy needs judgment reason and records it in tracker/event; unchecked implicit owner-policy override fails. |
| L663 — --ask-owner holds the pull request for the owner; merge waits for their approval of that exact head | R | Owner request stores exact head/files/preview, pending/changes refuse and later approved merge records author/time and closes decisions; ignoring requested changes fails. |
| L720 — unreadable approvals refuse a merge the rule covers; an approval asked holds a pull request no ticket owns too | R | Unreadable approvals refuse policy-covered merge and asked approval also gates no-ticket release; no-ticket path bypassing owner's pending decision fails. |
| L743 — a new head needs a new approval | R | Fresh head after approved request demands new approval and no merge; approval carrying across changed code fails. |
| L765 — updates a head behind main, waits for its checks without the lock, then merges the new head as the hand-back | R | Behind update uses original pinned SHA, releases lock while CI waits, lets second coordinator merge, verifies clean base-only tree then merges UPDATED; monopolizing lease or merging unreviewed code fails. |
| L836 — a required check not reported yet keeps GitHub BLOCKED with nothing running: that is waited for | R | Required check absent under BLOCKED waits until named check appears green; treating temporarily absent CI as terminal or green fails. |
| L848 — a head behind a base that does not require it up to date is test-merged, not updated | R | Behind non-strict base uses local test merge once and never native update; unwanted mutation of worker branch fails. |
| L856 — signed in with Armada down, it refuses before updating the branch or waiting | R | Signed-in Armada outage prevents update/wait entirely; branch mutation before taking required merge lease fails. |
| L865 — with --no-ticket, a head this run updated waits for its checks instead of passing with none | R | No-ticket branch updated by this run must wait for new check even if initial list empty; release exception incorrectly bypassing newly-triggered CI fails. |
| L881 — \`stops on ${name}, naming it, and merges nothing\` | R | Five wait-stop rows cover failed CI, conflict, denied/no-effect update and timeout, asserting intended diagnostics with no merges/Linear writes; waiting forever or treating update acceptance as completed fails. |
| L899 — counts as the hand-back when it only merges main in, as GitHub's update branch does | R | Clean merge-tree and parent ancestry allow only main merged into original hand-back; harmless base update incorrectly invalidating approved worker head fails. |
| L937 — \`is refused for ${name}\` | R | Five moved-head rows reject modified clean tree, off-base parent, extra commit, plain commit and unavailable Git proof with zero merge; unchecked new code riding on base-update exception fails. |
| L956 — merges a pull request no ticket owns with every other check, and writes nothing to Linear | R | True unticketed PR merges pinned head and leaves Linear/archive null but still rejects red checks; no-ticket bypass of ordinary safety gates fails. |
| L971 — merges a release pull request on which no CI ran, with a note, once GitHub had time to start one | R | Release no-CI exception waits one minute then explains required checks absent and UNSTABLE without failure; immediately accepting not-yet-started CI fails. |
| L993 — refuses a ticket-named branch without a nonblank reason (%j) | R | Undefined/empty/blank no-ticket reason on ticket branch refuses; worker work secretly merged without audit reason fails. |
| L1003 — a reason permits a pinned, locked merge while leaving the ticket and worker untouched | R | No-ticket reason audit occurs under lease before pinned native merge, leaves tracker/session/events unchanged and releases lock; accidental worker closure or missing durable explanation fails. |
| L1046 — dry-run with a reason checks the override without posting or merging | R | Reasoned dry-run leaves comment/merge/Linear empty; audit preview becoming irreversible write fails. |
| L1055 — a failed reason comment refuses the merge and releases the lock | R | Audit comment outage prevents native merge and releases lease; shipping override without durable evidence fails. |
| L1069 — a reason preserves the CI and review gates (%j) | R | Reason override still rejects failed/missing checks or open review before audit comment; no-ticket reason acting as unrestricted force merge fails. |
| L1082 — a reason cannot bypass an unavailable required lock | R | Reason cannot bypass unavailable required Armada lock, no comment/native call; unsafe unlocked fallback fails. |
| L1091 — a reason does not permit a head to move while checked | R | Head moved during reasoned checklist refuses before comment/native call; override bypassing revision fence fails. |
| L1102 — GitHub's HAS_HOOKS (mergeable, with pre-receive hooks) merges like CLEAN | C | HAS_HOOKS acceptable state is one row of merge state's ordinary admission contract. Add CLEAN/HAS_HOOKS positive rows to checklist table before removing standalone full orchestration invocation; native success must remain caught. |
| L1109 — an expired lease is taken over and its old holder can no longer renew it | R | Lease expiry takeover and old-holder renewal=false protect cross-terminal serialization at API boundary; stale holder extending replacement lease fails. |
| L1124 — Armada refuses a lease longer than an hour | C | Lease >1h status400 and diagnostic are fleet API validation. Move row into fleet-api malformed-request/lease gate keeper; no need to invoke merge-specific suite for parameter admission. |
| L1134 — a waiter gives up after the wait limit, naming the holder | R | Contended withLease times out with holder and expiry named and never runs callback; coordinator hanging indefinitely on held lock fails. |
| L1146 — an Armada that never answers refuses the lock instead of hanging | R | Never-answering acquire bounded at0ms refuses and callback never ran; transport ignoring AbortSignal hangs merge if broken (retain platform lifecycle risk). |
| L1166 — an unticketed fix requires a durable override audit (%s) | R | Unticketed through-hold success/comment-failure/retry table requires one durable comment with every hold id and no Linear changes; retry duplicating audit or failing open fails. |
| L1197 — both coordinators refuse until every hold is cleared; a fix records every override | R | Both coordinators refuse before forge reads under two holds; override records all ids and clears only explicitly; one coordinator bypassing durable shared pause fails. |
| L1222 — a hold opened while waiting stops the next poll; unavailable holds fail closed | R | Hold opened during wait stops next poll and unreadable hold read fails closed; work continuing into paused merge fails. |
| L1240 — a pause opened during checks, preflight or retry stops merging or joins the audit | R | Checklist/preflight/retry timing matrix rechecks new hold and either refuses before native effect or records override; pause arriving between checks and mutation missed fails. |
| L1275 — slow preflight guards must retain lease ownership before the initial merge or a retry | R | Lease expires during initial/retry preflight and replacement owns it; original stays open with exact attempt count and no Linear writes; late lease renewal after native mutation fails. |
| L1296 — main red is an informative merge note and health read failures do not block | R | Red-main diagnostic and health-read outage are informative dry-run notes; unrelated health service preventing valid PR merge fails. |
| L1316 — queue intent accepts readiness waits but refuses broken rules and records the hand-back | R | Queue intent carries pinned hand-back, reason, keepOpen, throughHold without merge/update/testMerge, rejects unknown comparison/redCI/missing hand-back; queuing unreviewed or unsafe work fails. |
| L1347 — queuing preserves the merge judgement and pending owner decision without accepting requested changes | R | Queue judgment requires reason, accepts undecided owner hold but rejects requested changes; queue admission bypassing owner veto fails. |
| L1364 — after merge selects declared deploy targets by base branch, including no-ticket merges | R | Post-merge deploy targets filter actual base for ticket/no-ticket, carry confirmed squash SHA, no-config null and dry-run absent; deployment of wrong target or preview dry-run fails. |

#### [`packages/core/test/npm.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/npm.test.ts)

History: `61d5b8d fix(api): announce CLI releases only after npm serves their tarballs (#113)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L12 — uses abbreviated metadata and verifies the newest stable tarball no higher than the build | R | Abbreviated metadata accept, stable<=build selection and shared timeoutHEAD prove published package availability; trusting newer/prerelease or metadata alone fails. |
| L27 — a moved latest tag is not published until its tarball answers 200 | R | Moved latest tag404 keeps older fallback until tarball200; declaring unready release published fails. |
| L38 — skips missing tarball URLs and multiple unavailable tarballs | R | Missing tarball URL and unavailable candidates fall through to0.2.6; choosing absent dist or first missing tarball fails. |
| L52 — none is available when all candidates are missing or newer | R | Only newer or all404 metadata returns missing/null; claiming unusable downgrade fails. |
| L64 — registry and tarball outages are unknown, never published | R | Transport and non200 tarball failures return unknown, malformed registry bodies never published; treating outage as missing or ready fails. |
| L85 — a tarball abort shares the metadata timeout budget and never throws | R | Timeout in tarball phase returns unknown deadline message under metadata budget; uncaught abort or renewed timeout fails. |

#### [`packages/core/test/overlap.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/overlap.test.ts)

History: `ccc3133 feat(cli): warn workers when planned paths overlap files in flight (#223)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L4 — declared paths compare files and globs conservatively, and never hide incomplete readings | R | Overlap results for exact files/globs, incomplete pages and escaped regex punctuation protect conservative conflict warnings; hiding incomplete overlap or matching nested path under* fails. |

#### [`packages/core/test/overview.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/overview.test.ts)

History: `783cc8d feat(dashboard): show which coordinator owns each session (#241)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L69 — an approval shows the full plan, its actionable inbox id and any pending answer request | R | Checks the full approval plan, actionable inbox id and pending answer request; protects the owner action from losing content or confusing an already submitted answer with a new approval. |
| L98 — a live worker without a report is not an owner item; silence starts at its newest heartbeat or report | R | Checks silence begins at the newest heartbeat/report and an active worker without a report is absent from owner waiting; protects owner alerts from false silence and invented owner decisions. |
| L120 — one waiting list across projects, one reason per ticket, most urgent kind first | R | Checks cross-project urgency, one reason per ticket, pending-launch diagnostics and coordinator counts/state; protects the waiting list from duplicate rows and incorrect priority. |
| L169 — an item open in the coordinator's inbox longer than policy.coordinator_minutes waits for the coordinator | R | Checks the configured 25/10-minute coordinator thresholds against independently old/new requests; protects each request’s overdue state from using another request’s timestamp. |
| L216 — the owner's requests show as pending on their question and their ready ticket, never as waiting for the owner | R | Checks pending answers on questions and pending launches on ready tickets with routing/profile/attribution; protects submitted owner actions from still appearing to await the owner. |
| L265 — each coordinator's CLI version, and whether a newer one is released | R | Current, behind and unknown CLI-version rows control release availability; protects unknown versions from generating a false upgrade warning. |
| L281 — each named coordinator with its state and tickets in flight, and an owner no role lists | R | Checks named coordinator facts and ticket ownership, including an unlisted owner with unknown state; protects role visibility and prevents sessions being attributed to another coordinator. |
| L320 — without the live data the waiting list comes from the tracker and the coordinator is unknown | R | Unavailable live data retains tracker hand-backs, gives the coordinator unknown state and an empty track; protects incomplete data from appearing idle or losing waiting work. |
| L336 — each row carries its timeline, drawn from its own comments and events only | R | Checks each row’s timeline from its own comments/events, excluding its sibling’s history; protects selected-worker reports and phase intervals from cross-ticket contamination. |
| L369 — the pipeline places each phase on its step and marks what needs someone | R | The independent phase/CI/conflict matrix owns the emitted pipeline field and row ordering. Retain: overview.ts still sorts by pipeline.step even though the older screen was removed. |
| L387 — the board's flow places each session in its step, a waiting one in the step it left | R | Checks shipping stages and prior working-phase fallbacks in flowStep; protects the six-step board from moving blocked rows to planning or ignoring explicit review state. |
| L417 — a blocked row keeps the step its timeline left, and each project carries its last merges | R | Composed history keeps a blocked row at implementing and carries actual project merge facts; protects the overview projection from losing the step or recent merges. |
| L450 — the overview carries each project's default-branch health | R | Checks each project’s default-branch health and null for older readings; protects the overview from dropping red main health or inventing a green state. |

#### [`packages/core/test/owner-items.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/owner-items.test.ts)

History: `47b62cf feat(dashboard): send owner alerts to a chat webhook (#212)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L41 — fire for a validation to decide, a question escalated to the owner and a stopped coordinator with items waiting | R | Validation/question hrefs, stable per-coordinator-stop keys and empty ordinary question/approval/handback output guard owner-only alerts; notifying owner for routine coordinator work fails. |

#### [`packages/core/test/phases.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/phases.test.ts)

History: `802ceb9 feat: ask the owner to validate only what they want, on one Validations page (#108)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — [policy] plans decides, a ticket label overrides it, and asking for approval wins over pre-approval | R | Config and label precedence including both-label approval wins protect plan policy; pre-approval bypassing explicit review fails. |
| L29 — the whole table: forward moves, going back where review sends the work, blocked from anywhere | R | Independent transition matrix plus null-owner and implementing->ready rejection protects fleet protocol; direct hand-back bypassing shipping fails. |
| L72 — an open pull request, its full head SHA and green checks pass | R | Green full-head openPR and named required check pass protect admissible hand-back; rejecting valid worker completion fails. |
| L77 — each malformed hand-back says why | R | Literal malformed SHA/head/draft/conflict/repo errors protect precise hand-back gates; unrelated PR or stale head passing fails. |
| L96 — CI: required checks by name, otherwise every check and at least one | R | Missing/duplicate/failing named check and no-check table guard CI readiness policy; duplicate green hiding red or ignoring missing required gate fails. |

#### [`packages/core/test/plans.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/plans.test.ts)

History: `5f634f2 feat(cli): pre-approve plans at launch (#200)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L33 — a plan reaches the coordinator with its full text and handle, once per approval transition | R | Full plan/handle stored once per approval transition and new id on revision protect inbox lifecycle; duplicate plans per repeated waiting report fail. |
| L47 — --plan posts the plan as its own block under a one-line status; awaiting-approval still sends it in full | R | Exact Linear plan block and parsed one-line status plus full approval inbox text protect human-readable plan transport; truncating multiline approval fails. |
| L68 — inbox --wait wakes when a worker posts a plan | C | Plan wake duplicates checkInbox --wait orchestration proven by inbox.test.ts --wait question table. Carry one plan-kind wake row into that keeper before removal; report persistence stays in plans first declaration. |
| L85 — %s answers resolve the plan and record it on Linear | R | Item/ticket/note target matrix asserts resolved plan and Linear answer plus fresh-silence window; leaving approved plan open or never resuming liveness fails. |
| L108 — Approve uses an answer request, closed together with its plan and attributed on the ticket | R | Owner Approve request attributed on Linear and closed with plan protects dashboard approval delivery; recording delivery without owner provenance fails. |
| L123 — %s closes obsolete plan answer requests | R | Phase/release/answer/note closure matrix guards stale plan answer requests; orphan approval after work moves on fails. |
| L140 — pre-approved plans enter implementing without an approval inbox item | C | Empty inbox on pre-approved implementing duplicates --plan implementing case. Carry plan-approved label row into --plan block keeper, including phase assertion before removing this low-information standalone case. |
| L147 — an older CLI's plain plan is annotated from the stored snapshot and one answer resolves it | R | Stored snapshot annotates old plain plan and needs-approval removes annotation, one answer closes it; legacy workers stranded on pre-approved plan fail. |
| L179 — closing a plan leaves another project's plan and approval request untouched | R | Other-project plan/request persist after same-id local phase change; unscoped approval cleanup fails. |
| L206 — losing Armada still posts the full plan and awaiting-approval phase on Linear | R | Armada outage still posts literal full plan to Linear and returns warning/null inbox; optional live failure losing authoritative tracker update fails. |

#### [`packages/core/test/redact.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/redact.test.ts)

History: `fceaf43 feat(secrets): mask worker output and messages (#239)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L18 — names exact values, prefers known values over patterns, merges overlaps and skips short values | R | Exact named/pattern masks, overlap union, short-token skip and callback identities guard secret redaction; leaking overlapping suffix or remasking markers fails. |
| L32 — built-in patterns mask complete key formats and private blocks | F | The forbidden substring synthetic- does not occur in ghp_synthetic/github_pat_synthetic/gho_synthetic, so those complete tokens can leak unnoticed. The xoxa_synthetic fixture also misses supported xoxa- syntax. Use supported literal tokens, assert each original absent and independently expected masks; retain PEM coverage. |
| L44 — every split and single-character chunks match whole-text masking, including long tokens and PEM | R | Every split and character-chunk output equals whole-text mask for known/long/PEM input, guarding streaming chunk boundaries; partial-token leak fails although expected oracle is separately anchored by first test. |
| L58 — streams normal output promptly, preserves exact-value matches across flushes, and supports custom patterns | R | Prompt120-character flush, cross-flush exact value and custom token delayed-mask expectations protect stream responsiveness and unknown-token boundaries; flushing secret prefix fails. |
| L71 — output flushes keep astral characters together for UTF-8 sinks | R | UTF8 roundtrip of separate output chunks preserves astral glyph; splitting surrogate pair into replacement characters fails. |
| L77 — masks nested prose while leaving routing and binary payloads unchanged | R | Exact nested prose replacement leaves ticket/handle/data and original input unchanged; masking routing/binary fields or missing caption/shippedWith leaks fail. |

#### [`packages/core/test/requests.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/requests.test.ts)

History: `ba22466 feat(dashboard): show every project and each project's page (#83)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L52 — the answer waits in the coordinator's inbox until it is delivered; then the question and the request close | R | Refusal code matrix, request attribution and delivery closing question+request with literal Linear body protect queued owner answers; closing before runtime-delivery record fails. |
| L84 — an answer the coordinator records itself, or a release, closes the owner's pending answer | R | Coordinator direct answer and release both clear pending owner request; stale duplicate dashboard answer remains actionable if broken. |
| L119 — a ready ticket gets one launch request, on its routed profile or the one chosen; the claim resolves it | R | Ready/inflight/profile refusal, exact shell-escaped body, claim attribution and resolution guard dashboard launch request lifecycle; duplicate launch or command injection through author fails. |
| L164 — the coordinator declines a launch with armada answer: closed, nothing posted on the ticket | R | Decline closes launch without Linear post and permits new id; decline treated as worker answer or permanently blocking relaunch fails. |

#### [`packages/core/test/routing.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/routing.test.ts)

History: `dc46b9c feat(cli): launch local workers through herdr (#140)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L17 — plain-language rules defer unmatched tickets to the coordinator, even with a default or only profile | R | Semantic unmatched ticket requires explicit reason even with default/only profile and normalizes multiline reason; silently routing plain-language choices fails. |
| L40 — the first rule in file order wins, whatever the order of the ticket's labels; labels ignore case | R | First rule wins independent label order, Unicode matching respects accents/script and reason source is exact; ASCII folding or ticket-order routing fails. |
| L63 — a ticket no rule matches gets default_profile | C | Routed unmatched default_profile already appears in first-rule Unicode matrix. Add explicit docs default/why row to that keeper before removing standalone duplicated default case. |
| L72 — --profile wins over the route, and an override of the route needs a reason | R | Explicit routed override needs reason and requested identical profile keeps rule, unknown rejected; unaudited override fails. |
| L90 — without routing: default_profile, else the only profile; several and no default must be named | R | No-routing default/only/multiple/prototype-name/null matrix protects profile fallback rules; prototype property selected as profile fails. |
| L114 — Herdr uses the same label routing and reason rules, with Herdr-specific descriptions | R | Herdr output names native harness/profile and errors while same routing chooses actual configured family; adapter selecting Conductor profiles for Herdr fails (shared-policy repetitions alone are insufficient deletion proof). |
| L157 — Herdr when rules require a reason for an unmatched ticket | R | Herdr semantic choices require reason and Herdr launch command; coordinator given unusable Conductor remediation fails. |

#### [`packages/core/test/runtime-state.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/runtime-state.test.ts)

History: `df8f084 feat(fleet): check Conductor sessions before silence alarms (#213)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L21 — organization operations target an exact claim, use server time, and allow archiving an already released claim | R | Checks exact claimedAt targeting, server observation time, worker denial, released-claim archive and new-generation reset; protects runtime authority from canceling a replacement generation. |
| L87 — a new runtime sequence resurfaces the next approval even when both readings say blocked | R | Answered blocked sequence 4 stays suppressed, sequence 6 alarms again, and invalid sequence values return 400; protects later native approvals from being lost behind the same blocked state. |
| L132 — an open persisted claim puts a stale unstarted tracker leaf in flight and newer end events still remove it | R | An open persisted claim puts a stale unstarted leaf in flight; newer release/merge events remove it, while a later replacement survives. Protects stale snapshots from hiding active work. |
| L168 — status uses persisted handles and expires their state without replacing the last report | R | Checks observation freshness at the 15/16-minute boundary without replacing the last report, plus unknown/null state; protects the status view from stale runtime state and fabricated progress. |
| L198 — blocked runtime enters the inbox before a report, clears when stale or answered, and avoids question and plan duplicates | R | Checks question/plan alarm deduplication, answered-state suppression and a new working-to-blocked alarm; protects polling from repeating a native prompt already handled. |
| L236 — working doubles silence in both inbox and status, then explains the fresh reading | R | Fresh working state extends the 15-minute silence threshold to 30, then expires consistently in status and inbox; protects both readers from contradicting each other about liveness. |
| L291 — idle stops active work after report grace, ignores heartbeats, and re-alarms each idle period | R | Idle’s five-minute report grace ignores heartbeats, keeps a stable response key, and rearms after working or a fresh answer; protects heartbeats from keeping an ended turn falsely active. |
| L353 — archived Conductor claims stay out of flight even after a tracker snapshot refresh | R | An archived Conductor claim remains absent from flight after a tracker refresh and inbox agrees; protects tracker phase data from resurrecting archived work. |

#### [`packages/core/test/setup.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/setup.test.ts)

History: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L24 — matching gates, signatures, linear history and up-to-date rules allow squash merges | R | Compatible checks, signatures and strict linear-history settings pass the squash-merge gate; protects doctor from blocking a supported project. |
| L31 — one check line names both differences and errors when GitHub can block a hand-back | R | Check differences name deploy/lint/required_checks with actionable fixes, and weaker GitHub settings warn; protects apparently green hand-backs from later failing repository gates. |
| L42 — squash, external approvals and GitHub queue block merges; branch deletion warns | R | Checks squash, external review and GitHub queue error levels plus branch-deletion warning; protects doctor from approving a merge workflow the adapter cannot satisfy. |
| L55 — code-owner and last-push review rules block even with a zero approving count | R | Code-owner and last-push review rules block even with zero required approvals; protects policy evaluation from considering only the approval count. |
| L115 — Armada pointers retain discovery metadata, migrate old files and ignore instruction-only releases | F | Pointer migration and discovery assertions are valuable, but comparing installed text with pointerText uses the same renderer. Keep literal descriptions, read command, version links and instruction-only release checks; add independent frontmatter/path assertions and remove that identity-copy loop, preserving old MERGE.md removal. |
| L157 — skills update vendors nested dependencies, detects their drift and leaves project settings alone | R | Checks nested scripts/licenses are vendored, drift is detected/repaired for the selected skill and project settings survive; protects updates from shallow copying or overwriting configuration. |
| L180 — an empty repository gets one error per missing piece, each with its fix | R | Missing repository pieces produce separate diagnostics and fixes; protects doctor from accepting an uninitialized project. The BUNDLED-derived count supplements these concrete assertions. |
| L196 — the plan for an empty repository makes every check pass | R | Applying the plan makes every check pass, records the correct setup command/lock source/ref, then yields an empty plan; protects init from unusable or non-idempotent output. |
| L218 — an outdated skill is a warning, and the plan replaces only that skill and its lock entry | R | Only the outdated worker warns and is replaced, its obsolete annex is removed, and upgrade guidance names the right version; protects unrelated skills from being overwritten. |
| L258 — files the repository already has are kept: armada.toml, other lock entries, Conductor scripts, ignores | R | Checks existing config, other lock entries, Conductor run scripts and ignores survive while required entries are added; protects init from destroying user settings. |
| L282 — the stop hook joins the repository's Claude settings, keeps theirs, and is opt-in | R | Checks opt-out, install-once behavior, custom permissions/hooks preservation and invalid-JSON refusal; protects stop-hook setup from duplication or loss of existing settings. |
| L340 — a routing rule naming an unknown profile is a doctor error | R | Unknown routing profiles produce a config diagnostic and fix; protects doctor from a raw exception or accepting an inaccessible launch profile. |
| L357 — the [brief] extra file is checked: a missing one is a warning | R | Missing brief-extra files warn and existing files pass; protects worker conventions from being silently omitted. |
| L371 — a .claude/skills that links to .agents/skills as a whole counts as linked | R | A whole-directory .claude/skills symlink counts as linked and requires no new links; protects setup from nesting links beneath an existing directory symlink. |
| L379 — a Conductor setup Armada cannot add safely is left to a person | R | Unsafe existing Conductor setup is left for a person; protects automatic text patching from corrupting unsupported settings. |
| L386 — a broken skills-lock.json is reported and never overwritten | R | A malformed lock yields an error and planSetup refuses; protects user lock data from being overwritten during repair. |
| L398 — GitHub HTTPS and SSH forms normalize owner/name without credentials | R | Checks HTTPS/SSH case, .git and credentials normalization, plus invalid host/path/query rejection; protects repository identification from including credentials or accepting a different host. |

#### [`packages/core/test/specs.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/specs.test.ts)

History: `6f544bb feat(cli): add specs without renaming every other spec (#206)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L17 — append in N style leaves every legacy title alone and includes the In short template | R | N-style append leaves legacy titles untouched and emits Spec 3 with the required In short fields; protects old numbering and the design template. |
| L29 — insertion shifts only the suffix and does not bump legacy totals in N style | R | Insertion shifts only the suffix in descending order and leaves legacy totals alone; protects earlier titles and safe rename ordering. |
| L41 — N/M explicitly bumps every total, including titles before an insert | R | Explicit N/M updates all totals, including the title before insertion and the newly created title; protects spec counts from becoming stale. |
| L51 — append uses the largest ordinal, including gaps, and empty programs start at one | R | Appending after ordinal 7 creates 8 despite gaps, while an empty N/M program starts at 1/1; protects numbering from using array length. |
| L58 — renumber fixes gaps, duplicates and stale totals in stable order | R | Renumbering uses stable UUID order and repairs gaps, duplicates and stale totals; empty and already-correct inputs remain stable. Protects deterministic write plans. |
| L75 — invalid positions, names and unsafe ordinals fail before producing a write plan | R | Invalid positions, names, newlines and unsafe ordinals are refused before a write plan exists; protects spec edits from invalid or overflowing numbering. |
| L82 — mixed spec titles give status and overview their spec labels and preserve frontier ordinal order | R | Mixed new/legacy titles expose the correct spec facts in status/overview and ordinal frontier order; protects program order from lexicographic ticket sorting. |

#### [`packages/core/test/status.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/status.test.ts)

History: `a5823d8 feat(cli): scope named coordinators to their own work (#243)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — mine filters owned work after full derivation and retains the whole frontier with launch owners | R | Mine filters owned flight and launches after full derivation while retaining the whole frontier and other roles’ launchingBy; protects blocker derivation from premature owner filtering. |
| L56 — a persisted stage survives a later tracker read in status JSON | R | Persisted review stage survives a later tracker reading and reaches the PR ticket despite failed CI; protects status from discarding an explicit shipping stage. |
| L84 — reports tickets in flight, the frontier and waiting pull requests from Linear and GitHub | R | Recorded Linear/GitHub responses produce the expected ticket, phase, flag, spec, frontier, PR, branch and comment-link matrix; protects source joins and complete status projection. |
| L141 — a GitHub failure keeps the tickets and says why pull requests are missing | R | GitHub credential failure retains three tickets, marks pulls unknown and names the cause; protects a forge outage from appearing as an empty green fleet. |
| L149 — without a GitHub token the tickets are still reported and pull requests are unknown | R | Without a GitHub token no forge read occurs, tickets and PR references remain, and CI is null; protects optional forge access from failing the entire fleet or inventing check results. |
| L159 — each ready ticket carries the profile its labels route it to, for the dashboard's launch picker | R | Frontier labels project the chosen profile and reason for ready/unlabelled tickets; protects the dashboard launch picker from choosing the wrong profile. |
| L185 — Herdr status explicitly names DeepSeek's OpenCode fallback, without confusing the assignee | R | DeepSeek fallback is explicitly labelled OpenCode and remains distinct from the assignee; protects runtime facts from being confused with the worker’s identity. |
| L229 — the claim's profile reason reaches status and unmatched semantic tickets have no ready route | R | Checks claim profile reason, a null route for unmatched semantic frontier tickets, and backend routing for an API-labelled row; protects plain-language profile policy from an implicit default choice. |
| L266 — each ready ticket keeps its own labels, without the ready label, for a project's page | R | Each ready row loses only the ready label and retains web/Bug labels; protects profile and project views from losing classification. |
| L290 — a parked ticket is listed neither as ready to start nor as unblocked but not marked ready | R | Custom parked labels and the old-config fallback exclude parked work from both ready and unmarked-ready lists; protects held work from being launched after a configuration refresh. |
| L319 — lists the last ten tickets merged, newest first, from the reading and Armada's merges since | R | Checks the newest ten merges using PR time, close-time fallback and live events, excluding canceled/manual-Done work; protects recent merges from missing post-snapshot events or including unmerged tickets. |
| L376 — reads only what it is asked: the pull requests alone keep the program as read, without a Linear call | R | Forge-only refresh preserves the program and performs no Linear call; no-refresh performs no calls. Protects incremental refresh from becoming a synchronous full read. |
| L410 — default-branch health reaches status JSON and old forge snapshots remain readable | R | Older forge snapshots yield null health; current snapshots project required-check failure to main health. Protects compatibility and default-branch health visibility. |

#### [`packages/core/test/timeline.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/timeline.test.ts)

History: `9ced0b7 fix(core): renew worker liveness after waiting turns (#161)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L46 — heartbeats keep the session line alive without adding report dots or advancing phases | R | Eleven heartbeats keep liveness but one report/phase and no silences; heartbeat events inflating work progress fails. |
| L63 — a resumed report renews liveness after heartbeats stop during a waiting turn | R | Resume report renews after old heartbeat, ongoing silence starts at11:40; stale heartbeat overriding fresh report fails. |
| L83 — phases from status comments and events, each report once, the row's phase last | R | Literal phase intervals/reports deduplicate live/status source and row summary wins; same report twice or wrong current phase fails. |
| L105 — the row's reading wins: a live phase newer than the last comment runs from its since | R | Current row shipping since11:30 appended beyond last tracker comment; stale history overriding current state fails. |
| L117 — only the current run: what came before the last release is dropped | R | Release drops prior run phases/reports and new claim planning retained; historical worker contaminating current step fails. |
| L127 — silences: gaps longer than the threshold while the worker had to move, and the one going on now | R | Working gaps produce45/60min plus ongoing, approval gap excluded; human waits misreported silence fails. |
| L145 — only the last 24 hours: older phases, reports and silences are left out | R | 24h clip excludes old report/dots while crossing gap and original startedAt remain; arbitrarily clipping ongoing interval fails. |
| L166 — THE-742's shape: status lines left on the ticket before its claim are not part of the run | R | Preclaim status comments ignored, exact THE742-derived phases/reports and no silence; lead-agent planning notes misread current run fail. |
| L190 — an old run, a release, then a new claim: the history starts at the new claim | R | Old run then release/new claim starts11:00 with no old silence; previous generation history persists if broken. |
| L204 — a worker that claims again to resume keeps its run's history | R | Same-session resumed claim preserves original start10:00 and40min gap; restart splitting one run fails. |
| L221 — a silence going on now starts at the claim at the earliest | R | Current silence earliest is fresh11:00 claim despite yesterday report/heartbeat; falsely alarming from old turn fails. |
| L236 — the pull request's opening, long summaries cut short | R | PR opening and140-character displayed summary guard public timeline facts; oversized tracker text or missing opening marker fails. |
| L251 — reads closer than a minute are one span; a lone read is a span of its own | R | 15s inbox reads become one6-count span but isolated read own span; coarse span merging incorrectly implies continuous coordinator activity fails. |
| L262 — a gap longer than the silence threshold is idle; a shorter one is not | R | 50min coordinator gap idle while10min not; liveness threshold interpretation changes fail. |
| L267 — only the last 24 hours, a gap crossing its start kept | R | 24h coordinator reads exclude old but crossing interval retained; absence window disappears at clipping boundary fails. |

#### [`packages/core/test/validations.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/validations.test.ts)

History: `802ceb9 feat: ask the owner to validate only what they want, on one Validations page (#108)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L40 — a worker submits its design: awaiting-validation with the link, on the owner's page; a resubmission replaces it | R | Checks the owner URL, awaiting-validation phase/comment, worker attribution and superseded old submission; protects the worker-to-owner handoff from leaving two open decisions. |
| L82 — a worker session validates its own ticket only, and never a merge | R | Refuses another ticket and a non-work validation kind, leaves the store empty, and strips forged PR/reason from the permitted submission; protects worker-session scope at the fake API boundary. |
| L110 — reaches the coordinator's inbox as a decision item, which wakes armada watch | R | Checks invalid choices, changed inbox ETag, exact decision payload/author and second-click refusal; protects owner decisions waking the coordinator exactly once. |
| L159 — records what the coordinator did with the owner's decision, and closes it | R | Checks armada answer records the coordinator resolution and closes the decision inbox item; protects the acknowledgement lifecycle after an owner asks for changes. |
| L186 — closes a design ticket once the owner approved it: the design on the ticket, Done, the session ended | F | Missing/pending approval is refused and approved work records Done, the owner note and a merge event, but the promised session end is untested: no active claim is created and no release is asserted. Add a claimed session and verify closeValidated ends that generation and links att-9; retain this approval-to-close boundary. |
| L239 — is asked of every brief when the project has rules; none needs no reason, a rule does | R | Checks no-rules bypass, explicit none, required reason, selected rule and invalid-index remediation commands; protects launch judgement from silently skipping configured owner validation. |
| L257 — records the validation rules the coordinator judged apply, with its reason | R | Checks the claim comment carries the selected rule and coordinator reason; protects the durable validation instructions a worker sees after launch. |
| L299 — counts for the head the owner saw, or that head with only the base merged in | R | Checks approval is valid for the reviewed head or a base-only update, stale for other code, absent for another PR and pending before decision; protects merging code the owner never approved. |

#### [`packages/core/test/watch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/watch.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L58 — the coordinator's own session is not a worker, and a new worker changes the etag | R | Own coordinator handle excluded, initial and added-worker flight alter ETag and unchanged read null; watch ignoring newly launched worker fails. |
| L82 — waits through unchanged reads, a 5xx and a network failure, and returns on a new hand-back | R | 503/network outages back off15/30s, preserve old reading, then return new hand-back after90s with status sequence; transient outage ending watch fails. |
| L122 — an item already shown to the coordinator does not wake it; a new one does | R | Seen old hand-back waits while new question wakes after60s, marking correct new flags; waking forever on handled items fails. |
| L153 — a hand-back already shown wakes the watch again when handed back on a new head, not on the same one | R | Same head repeated stays seen/304 but new SHA same inbox id wakes; hiding fresh worker hand-back behind old id fails. |
| L185 — a required upgrade ends the watch, after the open items | R | Required release arrives after old open item and exits with version key/install/upgrade/notes without setup hint; mandatory upgrade ignored fails. |
| L216 — with no worker in flight and nothing open, there is nothing to watch | R | Empty fleet excluding own handle returns nothing after one200; coordinator watching itself forever fails. |
| L223 — when the last worker is merged, the next read says so and the watch ends | R | Released final worker changes ETag and watch returns nothing after200/304/200; stale watch persistence fails. |
| L237 — open items with no worker in flight are watched, slowly | R | Seen open item without flight waits60s twice until resolved; busy15s polling idle project or stopping with actionable item fails. |
| L262 — a refusal ends the watch | R | 401 revoked sign-in immediately rejects; endless retry of cut-off worker/coordinator fails. |
| L271 — Armada unreachable or failing, not a refusal or an answer it cannot read | R | Transient classifier distinguishes 5xx/429/network from401/403/bad200shape/TypeError; retrying programming/incompatible-response bugs fails. |
| L290 — says whether to start watching again | R | Literal re-arm messages for worker/open/running/empty/unknown states protect coordinator guidance; silently dropping keep-watch instruction fails. |
| L324 — blocks the coordinator's checkout while a worker is in flight and no watch runs | R | Stop hook blocks owning checkout with in-flight work/no watch and names remediation/opt-out; abandoned active fleet allowed fails. |
| L334 — allows otherwise | R | Running/empty/null/other-worktree/stopped/off cases pass hook with precise reason; worker checkout accidentally blocked by coordinator hook fails. |
| L351 — question then hand-back keep the stream running, acknowledge after print and restart without repeats | R | Follow yields question then hand-back, checkpoint only after print, bounded60s and resume no repeat/304; cursor advancing before output loses event fails. |
| L383 — look-back finds a late commit once, pages forward and respects ticket/kind filters | R | 205-page burst plus late event filters sibling/heartbeat and yields206unique ids with cursor not rewound; pagination skipping late commit fails. |
| L426 — follow state alarms can recur after clearing and idle never ends an unbounded follow | R | Cleared state alarm recurs and unbounded idle follow stays alive until abort,60s idle; permanently suppressing repeat incident or terminating monitor fails. |
| L471 — handover filters ordinary reports on the server and returns304 between handovers | R | Handover-only filter ignores implementing then emits ready handover with2successful reads; fetching ordinary reports into specialized follow fails. |
| L505 — follow retains the highest500 identities through late commits and further bursts | R | 1000+late+251 burst yields1252unique and late exactly once with304tail; bounded seen-id eviction losing/doubling late events fails. |
| L551 — cross-machine resume recovers higher IDs with older timestamps and later commits without a cache | R | Cross-machine resume cursor catches larger ids with older timestamps before/after reconnect without local cache; timestamp-only cursor loses committed events fails. |
| L594 — a kill during historical baseline seeding resumes the seed without replaying old lines | R | Checkpoint interrupted while seeding historical205events persists baselinePending; restart emits no old lines; crash replaying historical baseline fails. |
| L631 — follow includes a stopped session by default and when filtered, without repeating it | R | Stopped runtime alarm appears once both default/filtered after5min grace; filter forgetting synthesized stopped state fails. |
| L658 — follow shows initial and new holds until cleared, by default and when filtered | R | Initial/new hold emitted false/true once, with ids/reasons and cleared persistent state; hold filters or dedupe hiding renewed pause fails. |
| L687 — follow sees coalesced deploy notice updates through inbox ETags, by default and filtered | R | Coalesced deploy inbox id changes SHA/body and emits fresh second event under both filters; id-only ETag suppressing updated incident fails. |

#### [`packages/core/test/worker.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/worker.test.ts)

History: `0ab9035 feat(ci): explain failed checks and runner problems (#208)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L39 — claims the ticket in Linear and records the handle and the event through Armada | R | Checks claim status, assignee, labels and literal tracker comment plus live handle/project/event facts; protects a worker claim from being recorded under the wrong runtime or omitted. |
| L65 — a ticket another worker holds is refused and left untouched | R | A foreign active claim produces a precise refusal and zero writes; protects a ticket from being owned by two workers. |
| L79 — a ticket whose comments could not all be read is refused, since an older claim may be hidden | R | Incomplete comment history refuses with zero writes because an older claim may be hidden; protects claiming from first-page-only race checks. |
| L88 — when two claims race, the older one wins and the loser withdraws its comment | R | The older concurrent claim wins and the loser withdraws its comment without label writes; protects a worker from continuing after losing the claim race. |
| L100 — claiming again from the same session repairs labels without a second claim | R | Same-session reclaim repairs labels, preserves underscores in identity and keeps one comment; protects resumption from creating a duplicate claim. |
| L111 — a Claude Code subagent claims with --runtime claude-code and its name as the handle | R | Claude-code alias becomes the Claude Code label and named handle; protects runtime normalization at claim time. |
| L127 — overriding the routed profile without a reason is refused before any write | R | Overriding the routed profile without a reason refuses before writes; protects coordinator routing policy from undocumented overrides. |
| L137 — semantic choices require a reason and record it in the claim and existing live profile | R | Semantic selection requires a reason before writes and records normalized comment/profile provenance; protects profile choices from losing their explanation. |
| L155 — the claim comment and the live data record the profile, and an override's reason | R | Checks literal profile claim text, persisted override, resumption preserving the original profile and release forgetting it; protects a running worker from being rerouted mid-session. |
| L195 — an unknown runtime names the labels that exist | R | Unknown runtime diagnostics name available group values and remediation; protects unsupported runtime errors from leaving workers unable to repair the claim. |
| L212 — shipping stages record Armada data and reject invalid input before writes | R | Invalid stage input leaves Linear unchanged; valid review/CI reports store stage and phase labels; protects the shipping stage contract from unsupported values. |
| L234 — a valid move swaps the phase label, posts the status line and lists the worker's inbox | R | A valid move changes the phase label/status line and returns the worker inbox body; protects reporting from dropping coordinator instructions. |
| L257 — an invalid move is refused with the reason and writes nothing | R | Planning-to-shipping refusal explains the invalid transition with no extra writes; protects Linear from an invalid phase advance. |
| L266 — ready-to-merge is checked against the pull request head and the required checks | R | Red head refuses before writes; an uppercase SHA is normalized for a green hand-back, PR link and deduplicated inbox item. Protects ready-to-merge from unverified or duplicate hand-backs. |
| L306 — hand-back refuses unresolved review threads before writing, allows resolved threads and warns on unreadable threads | R | Unresolved threads stop tracker/live hand-back; resolved threads pass and unreadable/incomplete reads warn. Protects completion from silently ignoring review gaps. |
| L355 — losing Armada still writes Linear and warns | R | Optional Armada failure still writes Linear status and returns a warning/null inbox; protects authoritative progress during live API outages. |
| L369 — a failed coordinator snapshot never falls back to an unguarded release | R | A failed runtime-handle snapshot warns without a release event or handle closure; protects fallback cleanup from releasing a replacement generation. |
| L390 — a release can retry after Linear fails (worker session: %s) | R | After Linear fails following live release, organization and worker sessions can retry and remove labels; protects split-system release from becoming irrecoverable. |
| L412 — a current worker releases a Linear-only claim when optional live recording failed | R | The current worker can release a Linear-only claim when optional live recording failed; protects cleanup from requiring a nonexistent live handle. |
| L425 — a replaced worker refuses before changing Linear's replacement claim | R | A replaced worker refuses before changing tracker/live state, while the current worker can release; protects replacement ownership from late generation cleanup. |
| L442 — removes the agent labels, moves the ticket back and closes the handle | R | Release retains ready labels, sets unstarted state/comment and ends the live handle, after which a new session can claim; protects clean release without destroying unrelated labels. |

### cli

#### [`packages/cli/test/attach.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/attach.test.ts)

History: `d03b5cc feat(attachments): let agents privately attach screenshots and links (#103)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L43 — attach sends an image and HTTPS link with caption and free validation reference | R | Checks base64 bytes and caption/reference in two attachment requests; catches argv metadata loss or image encoding corruption. |
| L72 — CLI refuses type and size limits without uploading | R | Checks exit 2, type/size diagnostics and zero uploads for HTTP/oversized/SVG inputs; catches uploading invalid files before local rejection. |

#### [`packages/cli/test/auth.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/auth.test.ts)

History: `527a4ee fix(core): retry temporary Linear, GitHub and Armada failures (#210)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L70 — asks only for the missing Linear key, hidden, stores it 0600, and asks nothing the second time | R | Checks hidden missing-key prompt, persisted bytes/mode 0600 and no repeat prompt; catches exposed input or insecure credential storage. |
| L87 — a key set in the environment is not asked, and the file keeps its other lines | R | Checks environment avoids prompt/write and unrelated stored lines survive; catches overwriting the owner credential file. |
| L106 — without a terminal it asks nothing, writes nothing and names the variable to set | R | Checks noninteractive exit 2 and absent file/prompt; catches hanging headless workers on input. |
| L117 — cancelling a prompt saves nothing | R | Checks cancel exit 130 and absent credential file; catches saving cancelled input. |
| L127 — says where each key comes from, the environment first, and never prints a value | R | Checks source precedence, JSON presence flags and both secret canaries absent; catches printing credential values instead of their sources. |
| L161 — removes Armada's keys and the retired fleet database keys, keeps every other line, and says which ones the environment still sets | R | Checks malformed/retired secret lines removed while OTHER_TOOL survives and environment-use notice remains; catches retaining a leaked legacy key. |
| L181 — uses the stored Linear key, and an environment key wins over it | R | Checks actual Linear Authorization uses stored key then environment override; catches loading the correct display source but wrong request credential. |
| L194 — with no key anywhere, the error names the variable and the login command | C | Same run(status) missing-credential refusal as cli.test.ts:382; carry auth-login hint into cli.test.ts:358/382 table before removing this invocation. |
| L201 — prompt input keeps typed and pasted characters, honours backspace, skips arrow keys and cancels | R | Checks raw pasted text, backspace, escape filtering, cancellation and echo bytes; catches arrow sequences entering hidden credentials. |

#### [`packages/cli/test/brief.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/brief.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L143 — semantic rules ask without a launch or watch write; prompt refuses until a reasoned choice | R | Checks human/JSON selection and reasoned prompt acceptance plus refusal output; catches silently selecting an undecided model. |
| L184 — prints the launch settings, then the prompt: claim first, blockers' hand-backs, decisions, workers in flight | R | Checks ordered install/claim/handback/decision prompt bytes and worker/watch facts; catches launching workers with missing lifecycle instructions. |
| L223 — the plan rule is one line of the prompt, and [brief] extra ends it under Project conventions | R | Checks configured plan rule and conventions bytes at prompt end, with missing-file warning; catches omitting repository-specific instructions. |
| L252 — --prompt prints only the prompt and --json the whole brief with the chosen profile | R | Checks JSON routing/profile and shell-quoted claim reason against prompt stdout; catches serializing flags or metadata differently by output mode. |
| L285 — the brief pins a version npm serves: else the newest published one, with a warning; offline it only warns | R | Checks served stable version and fallback install commands, unavailable tarball fallback and offline warnings; catches launching with unpublished package bytes. |
| L345 — a claude-code profile names its guide, and the prompt puts the subagent in its own worktree first | R | Checks worktree instruction precedes install/claim and subagent handle/heartbeat flags; catches Claude workers modifying coordinator checkout. |
| L374 — no secret value from the environment appears in any output | R | Checks canary absence in all output modes while Authorization remains correct; catches credential leak through prompt JSON. |
| L385 — warns about a blocker still open, not about a canceled one | R | Checks canceled blocker produces no warning and open blocker does; catches treating cancellation as unsatisfied dependency. |
| L400 — relations and comments longer than one page are read to the end | R | Checks subsequent relation/comment requests and later handback text; catches truncating launch context at the first API page. |
| L436 — a key only in the credentials file is marked to load into the shell, and never shown | R | Checks stored-key provenance output and no secret bytes; catches falsely telling a worker its key is in the shell. |
| L448 — a brief counts its ticket in flight at once, for the stop hook, even with --prompt | R | Checks prompt adds ticket to persisted inFlight state; catches stop hook ending while a just-launched worker runs. |
| L459 — overriding the routed profile without a reason is a usage error | R | Checks missing override reason returns exact recovery and no stdout; catches unreasoned routing overrides. |
| L468 — an unknown profile is a usage error, before any request | R | Checks unknown profile fails before fetch; catches reading/minting for invalid settings. |
| L505 — brief passes the named coordinator into plain and pre-approved launch tokens | R | Checks named coordinator in token payload and server launch record with both approval modes; catches launch ownership reverting to default. |
| L524 — pre-approval writes the configured label only for a prompt and names the reason | R | Checks only --prompt mutates approval label/token and preview prints intent; catches read-only brief approving plans. |
| L547 — pre-approval refuses needs-approval, missing labels and missing reasons without writes or a token | R | Checks refusal reason and no Linear/token writes for approval conflict/truncation/missing label/reason; catches minting before policy checks. |
| L574 — an undecided or invalid semantic brief never mints a token, even when signed in | R | Checks undecided/invalid semantic routes create no token or watch state and reasoned choice creates one; catches orphan pending launches. |
| L594 — [[policy.validation]] rules: the coordinator judges each launch; the refusal gives the command to copy and mints nothing | R | Checks validation refusal command, no token, explicit-none and chosen-rule prompt/claim flags; catches bypassing owner validation judgement. |
| L630 — human and JSON briefs mint nothing and leave watch state unchanged | R | Checks human/JSON have zero tokens, null launch and unchanged persisted watch state; catches preview changing lifecycle state. |
| L648 — --prompt mints exactly one token and --profile-line keeps stdout unchanged | R | Checks exactly one token request and identical stdout under --profile-line with sanitized stderr; catches double minting or profile chatter corrupting launch stdin. |
| L666 — an Armada that refuses (no vault) leaves the prompt as before, with a warning; not signed in, the launch line says why | R | Checks vault refusal degrades to key-based prompt with warning; catches unnecessary hard failure on older/offline broker. |
| L682 — briefs describe declared shared keys and show the project's current holders | R | Checks holder id and declared key text in prompt/JSON plus offline warning; catches launch context omitting reserved schema numbers. |
| L713 — a brief uses Armada's stored file inventory and declared paths, truncating PR files at 15 | R | Checks actual core loadBrief prompt truncation at file 14, +3, plans and incomplete notice; catches unbounded or incomplete overlap context. R, relocate to core brief owner without dropping assertions. |
| L747 — the initial brief ticket read retries temporary failures and preserves nonempty output | R | Checks 503 retries yield three reads, two waits/notices and usable JSON; catches CLI failing launch context on transient Linear errors. |

#### [`packages/cli/test/ci.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/ci.test.ts)

History: `daf007f feat(ci): rerun tracked flaky failures once per workflow (#230)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L115 — ci why retries temporary Actions failures through injected waits and stderr notices | R | Checks Actions retry waits/notices and recovered parsed test/attempt; catches hiding transient log-read recovery from the coordinator. |
| L126 — ci why accepts %s with only GitHub credentials | R | Checks PR/url/SHA/branch argv selectors work with GitHub-only credentials and bounded output; catches unnecessarily requiring Linear sign-in. |
| L140 — ci why rejects invalid selection %s | R | Checks invalid selector table exits 2 and no requests; catches interpreting foreign repository URLs as local PRs. |
| L156 — JSON includes warnings, annotations fallback and the pinned SHA | R | Checks JSON pinned SHA and annotation fallback with permission warning; catches losing diagnostics when Actions logs are forbidden. |
| L165 — newer push marks a cancelled head superseded and avoids Actions log reads | R | Checks superseded cancellation skips log reads, current cancellation lacks marker; catches diagnosing old CI as current head failure. |
| L175 — no failures reports no failing checks without claiming green CI | R | Checks no-failure output avoids claiming green; catches treating an empty check reading as success. |
| L181 — CI project selection uses the watched repository outside its checkout with GitHub credentials alone | R | Checks selected watched repository GraphQL variables outside checkout; catches explaining CI of the nearest unrelated project. |
| L310 — ci why --rerun names the root-cause ticket and writes once, scoped to the configured repository | R | Checks root-cause ticket/output and exact one repo-scoped gh rerun; catches rerunning unrelated repo or losing flake attribution. |
| L318 — ci rerun refusal never writes | R | Checks varied evidence/attempt/race refusals perform zero gh writes and name reason; catches unauthorized or repeat CI reruns. |
| L338 — JSON rerun output remains one document and uncertain writes are never retried or printed | R | Checks one JSON document, uncertain status, one write and no raw diagnostic canary; catches replaying unknown-outcome reruns. |
| L347 — successful first-attempt workflows do not turn a permitted rerun into a refusal | R | Checks successful companion run does not veto one failing eligible run; catches blocking recovery because another workflow passed. |
| L354 — two requests on the same GitHub run rerun only its first attempt | R | Checks second invocation sees GitHub attempt 2 and total one rerun; catches resetting retry allowance per terminal invocation. |

#### [`packages/cli/test/cli.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/cli.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L53 — --config overrides ARMADA_CONFIG, --project and the upward search | R | Checks --config precedence over env/project/upward config through status JSON; catches wrong-project operations. |
| L65 — ARMADA_CONFIG resolves absolute and relative paths from /tmp before --project | R | Checks absolute/relative environment config wins from unrelated cwd; catches resolving relative path against checkout instead of caller. |
| L79 — ARMADA_CONFIG selects the inbox project from /tmp | R | Checks inbox project chosen through ARMADA_CONFIG and fake API; catches applying selector only to status. |
| L101 — --project finds a previously watched checkout from /tmp before upward search | R | Checks --project selects persisted checkout over nearest invalid config; catches accidental fallback into another repository. |
| L114 — spec renumber honors environment and project selectors from /tmp | R | Checks spec preview selection via env/project with zero writes; catches spec dispatch bypassing shared config resolver. |
| L137 — --project uses the most recent named coordinator's watch root | R | Checks latest named coordinator watch root chosen; catches choosing stale default checkout. |
| L153 — unknown projects list valid known slugs and suggest --config without falling back | R | Checks unknown slug lists valid deduplicated projects and refuses fallback; catches silently operating on wrong project. |
| L172 — explicit missing files and removed watched checkouts fail without upward fallback | R | Checks explicit missing env/config/project targets fail with selected path; catches fallback masking removed checkout. |
| L191 — hook stop ignores external selectors and keeps the hook's cwd | R | Checks hook uses stdin cwd despite external selectors and only coordinator cwd blocks; catches worker stop hook using coordinator state. |
| L213 — status mine uses the selected coordinator and annotates other launches | R | Checks named status inFlight count and other launch attribution; catches ownership filtering dropping shared launch facts. |
| L258 — human status shows the recorded profile and reason | R | Checks profile reason and shipping-stage strings from renderer; catches losing worker model provenance in terminal output. |
| L271 — --json prints the report found from the nearest armada.toml | R | Checks JSON project/inFlight/frontier from nearest config; catches wrong root search or status serialization. |
| L280 — prints a readable summary by default | R | Checks full terminal summary, warnings and grouping against independent literal; catches terminal formatting omitting action-relevant state. |
| L322 — reads that failed part way are listed as warnings | R | Checks incomplete relation warning appears at output end; catches presenting partial tracker reads without notice. |
| L337 — project skills that differ from the CLI's are named with the release the lock records | R | Checks drift warning identifies locked skill release and recovery command; catches outdated instructions going unnoticed. |
| L358 — a missing armada.toml or a missing key is a configuration error naming what is missing | R | Checks missing config/required TOML key and claim-specific recovery; catches generic errors that cannot guide setup. |
| L373 — a rejected Linear key fails with exit code 1 and a clear message | R | Checks HTTP 401 maps to exit 1 and explicit rejected-key recovery; catches reporting authentication errors as empty fleet. |
| L382 — LINEAR_API_KEY is required | C | Duplicate status-with-no-key refusal with auth.test.ts:194; consolidate into cli.test.ts:358 table, preserving exit 2, LINEAR_API_KEY and Next: armada auth login. |
| L391 — <command> --help prints that command only; --help and no command print every command | R | Checks command help isolation and no-command/full-help behavior without config; catches command-specific help exposing wrong options. |
| L415 — an unknown command or option names the help to read | R | Checks unknown command/option yields usage exit and command-scoped help; catches misleading parser recovery. |
| L430 — lists every project of the organization on Armada, each read with the armada.toml of its default branch | R | Checks registry/default-branch configs, per-project partial errors, jobs and sanitized output; catches status --all dropping healthy projects after one fails. |
| L487 — a project that keeps its own Linear key is read with it; the others with the organization's | R | Checks actual per-project/org key Authorization and credential-purpose request; catches reading one project's Linear through another key. |
| L529 — an organization with no project yet says how to register one | R | Checks empty registry prints registration action; catches empty success without onboarding guidance. |
| L537 — not signed in, it refuses and names armada login | R | Checks unsigned registry read refuses before network with login hint; catches unauthenticated org enumeration. |
| L550 — prints the installed bundle and linked files without config, credentials, filesystem or network | R | Checks bundled skill bytes plus throwing IO/network fixtures; catches skill command requiring checkout/sign-in. Exact bytes are installed-version contract. |
| L570 — rejects missing, unknown and extra arguments and paths outside the bundled skill | R | Checks traversal/absolute/unknown/extra skill args refused with empty stdout; catches reading outside bundled skill namespace. |
| L587 — Linear status retries print wait notices; exhausted reads still fail with an error and next step | R | Checks injected jittered retry waits/notices and recovered/exhausted exit/output; catches retry wiring dropping final error or corrupting JSON. |

#### [`packages/cli/test/codex-models.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/codex-models.test.ts)

History: `82518f4 fix(cli): verify local profile models in doctor (#156)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L36 — Codex catalog initializes, follows pages, returns exact model IDs and kills the child without a thread | R | Checks initialize/model-list protocol, pagination, exact model IDs, ignored diagnostics, deadline cancellation and child kill; catches thread creation or leaked catalog subprocess. |
| L62 — Codex catalog discards incomplete, malformed, looping, failed and oversized results | R | Checks error/malformed/loop/oversize/timeout tables return null and kill child; catches partial or unbounded catalog accepted as complete. |
| L106 — a successful empty Codex catalog remains distinguishable from an unavailable catalog | R | Checks empty successful catalog returns [] rather than null; catches treating known no-model account as unavailable service. |
| L113 — Codex catalog preserves control-safe custom model identifiers | R | Checks control-safe provider/unicode/long identifiers returned unchanged; catches overrestrictive identifier normalization rejecting valid models. |

#### [`packages/cli/test/conductor-launch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/conductor-launch.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L221 — Conductor launch briefs include shared keys and holders from the same brief input as herdr | R | Checks reservation text in create stdin; catches Conductor launcher failing to forward shared brief context even when brief command works. |
| L241 — native launch routes the profile, sends the token and coordinator notes only on stdin, binds and prints ids | R | Checks exact native argv/base/profile, token/notes on stdin, order, bind id and sanitized JSON; catches tokens in process args or misbound worker ownership. |
| L303 — notes and profile refusals mint no token | R | Checks missing/empty/byte-oversize notes and unknown profiles mint nothing; catches side effects before launch input validation. |
| L317 — known create failure revokes the exact launch and never leaks native output | R | Checks known failure revokes exact id, binds none and prints sanitized recovery; catches orphan launch token on definitive failure. |
| L326 — lost create answer recovers and binds one worker without creating twice | R | Checks lost-answer search scoped by repo/time, one create and one bind/no revoke; catches double launch after timeout. |
| L348 — lost create with no recoverable worker revokes its token | R | Checks empty recovery revokes token and surfaces timeout; catches stranded launch with proved absent runtime. |
| L356 — dry run defaults to the profile runtime, reports settings and preflight and creates nothing | R | Checks preview JSON settings, no token/create/lease and no notes output; catches dry-run mutating launch state. |
| L372 — preflight auth failure and completed tickets are refused before a token exists | R | Checks native auth and completed ticket refusals before token; catches starting unreachable/completed work. |
| L383 — guided Claude Code profile points to the Agent tool without minting a token | R | Checks guided-runtime recovery references Agent tool and zero tokens; catches attempting native Claude Code launch. |
| L390 — an undeployed bind route warns and keeps the running worker | R | Checks bind-route 404 warning preserves running worker; catches revoking a live session because server upgrade lags. |
| L398 — a pending launch, an active claim and an occupied lease all refuse before minting | R | Checks pending/claim/lease conflicts mint nothing with distinct reasons; catches parallel duplicate workers. |
| L440 — pending launch is rechecked after acquiring the lease | R | Checks pending launch created during lease acquisition blocks minting and releases lease; catches race between preflight and guarded create. |
| L461 — ambiguous recovery retains the pending token and gives the candidate ids without launching again | R | Checks ambiguous search retains token, names candidates and creates once; catches choosing an arbitrary recovered worker. |
| L470 — configured Conductor project and base branch are passed explicitly | R | Checks configured project/base sent and no remote-base probe; catches ignored Conductor routing config. |
| L483 — create runtime error recovers a possibly created workspace before cleanup | R | Checks native code 1 recovers/binds before cleanup with one create; catches revoking a possibly started worker. |
| L492 — recovery retains unmatched workspace and session names for inspection instead of guessing the ticket | R | Checks renamed candidates remain unbound/unrevoked for inspection; catches matching by only repo/time. |
| L502 — truncated workspace or session recovery keeps the pending token and prints actionable ids | R | Checks truncated workspace/session search retains token with ids; catches interpreting partial absence as definitive failure. |
| L513 — an unavailable or malformed recovery search retains the pending launch for manual inspection | R | Checks malformed/unavailable search retains pending state and one create; catches unsafe automatic cleanup after recovery outage. |
| L525 — Conductor pre-approval is read-only in preview and reaches the launched brief | R | Checks preview no writes vs actual label/owner and prompt preapproval; catches mismatch between launch label and worker plan instruction. |
| L547 — Conductor needs-approval labels refuse pre-approval before any token or native launch | R | Checks approval-conflict diagnostic with no token/runtime/label writes; catches validating policy after creating native workspace. |

#### [`packages/cli/test/coordinator.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/coordinator.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L15 — use persists the project checkout role without sign-in; environment takes precedence and invalid names refuse | R | Checks persisted checkout-specific role, env precedence and invalid-name refusal without network; catches one checkout changing another coordinator's default. |
| L45 — list shows sessions and tickets; take refuses another owner without matching from | R | Checks JSON session/ticket listing and --from transfer guard with server ownership; catches taking another owner's ticket without explicit origin. |

#### [`packages/cli/test/deferred-launch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/deferred-launch.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L21 — launch --when-unblocked and --after store server-checked requests, print blockers and show parked state in status | R | Checks deferred server request, no token, blockers/parked output, selector errors and notes refusal; catches accidentally launching instead of storing intent. |
| L104 — post-merge launches only ready requests owned by this coordinator with stored facts, and preserves failed requests | R | Checks only owned ready stored requests dispatched, failures retained/sanitized and guided fallback command preserved; catches launching parked/unowned follow-ups after merge. |

#### [`packages/cli/test/deploy.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/deploy.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L43 — watch commands are bounded, run at repo root with deploy environment, and coalesce smoke | R | Checks repo-root bounded process-group commands/env, one smoke across two watchers and healthy persisted state; catches duplicate deploy smoke or command targeting wrong cwd. |
| L66 — failing smoke pauses merges and a healthy newer deploy recovers | R | Checks failed smoke creates hold and later healthy deploy clears hold/inbox; catches retaining stale merge pause after recovery. |
| L82 — merge startup emits exact watch line or safe fallback without blocking on deploy | R | Checks background args/log path and manual fallback result without waiting; catches merge blocked by synchronous deploy watcher startup. |
| L116 — lease cleanup failure preserves the recorded smoke result and healthy merge state | R | Checks lease-release outage preserves healthy state/exit and warning; catches cleanup failure turning successful smoke into failed deploy. |
| L134 — failed smoke diagnostics mask credentials and declared project secrets before persistence | R | Checks credential/project secret absence in persisted rows/inbox/holds/output while diagnostic remains; catches saving raw smoke stderr secrets. |

#### [`packages/cli/test/digest.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/digest.test.ts)

History: `c42c298 feat(dashboard): send scheduled owner fleet digests (#225)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — digest JSON, French default, duration override and send use only the signed-in fleet API | R | Checks duration-derived since, French default/override, send route and invalid argv through fleet-only API; catches digest calling tracker or wrong send language/window. |

#### [`packages/cli/test/first-run.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/first-run.test.ts)

History: `a32c262 feat(cli): set up local harnesses and explain first-run questions (#160)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — recognises the owner's recorded Claude and Codex first-run screens without echoing their contents | R | Checks recorded harness screens map to fixed issue kind without private/path bytes; catches first-run parser exposing pane transcript in diagnostics. |
| L24 — checks each native harness and only recognises its own known screens | R | Checks harness-specific recognition, OpenCode fallback/signin and benign null; catches falsely blocking a ready harness due to another runtime's prompt. |

#### [`packages/cli/test/heartbeat.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/heartbeat.test.ts)

History: `17aff17 feat(cli): run coordinator commands from any folder (#205)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L59 — only fleet pings on schedule, no Linear/key calls or secret output; exits with parent and cleans the PID file | R | Checks scheduled heartbeat request/event timestamps, no Linear calls/output and PID cleanup; catches liveness updates stopping early or leaking worker keys. |
| L70 — background startup waits for readiness, passes no secret arguments, and falls back to manual reports | R | Checks detached argv strips background/secret args and failed/throwing startup yields manual-report recovery; catches recursive background spawning or silent failed heartbeat. |
| L92 — a detached heartbeat keeps the project selected from an unrelated folder | R | Checks child dispatch retains watched-project selection from unrelated cwd; catches detached child using a different checkout. |
| L107 — unsafe interval or transient shell PID is refused before any API call | R | Checks invalid interval/shell-parent rejected before requests; catches runaway pings or heartbeat dying with transient shell. |

#### [`packages/cli/test/herdr-first-run.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/herdr-first-run.test.ts)

History: `89d50e8 fix(cli): restore herdr worker names lost during startup (#173)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L49 — startup diagnoses recorded questions even when herdr returns agent_not_ready | R | Checks agent_not_ready still yields trust recovery and no terminal answers; catches ignoring owner trust screen when native startup fails. |
| L59 — questions missed by native idle detection are inspected before brief delivery | R | Checks native idle MCP prompt diagnosed without brief prompt call; catches delivering token into first-run choice. |
| L67 — never reads pane text after the runtime returns a different worker identity | R | Checks wrong pane identity rejected before transcript read; catches reading another worker's private terminal. |
| L73 — unknown blocked and timed-out startup screens retain actionable attach commands | R | Checks blocked/unknown startup attaches actionable pane command with bounded calls; catches infinite startup wait without recovery. |

#### [`packages/cli/test/herdr.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/herdr.test.ts)

History: `89d50e8 fix(cli): restore herdr worker names lost during startup (#173)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L34 — recorded Codex name loss is repaired by pane at start and readiness checks before delivering the brief | R | Checks unnamed Codex pane renamed/rechecked before prompt and correct target; catches herdr name-loss making worker unreachable. |
| L73 — launch never renames, reads or prompts an empty pane or mismatched worker | R | Checks every mismatched occupant at start/prompt causes exactly one read and no writes; catches delivering token to wrong harness or worker. |
| L99 — failed or invalid name recovery fails closed without sending a brief | R | Checks invalid/failed rename response fails after exactly rename/read; catches accepting unverified repaired identity. |
| L144 — starts an absent server, uses returned topology and sends a long brief verbatim | R | Checks server bootstrap, returned topology, scrubbed inherited env, initial-shell close and verbatim long prompt argv; catches token leaks or guessed pane IDs. |
| L220 — a running server is preserved; an incompatible server is refused | R | Checks existing server not restarted and incompatible server refusal; catches destructively replacing native owner session. |
| L229 — malformed topology and unsafe names stop before an agent is started | R | Checks malformed topology and unsafe ticket name stop before start; catches creating agent in unidentified pane. |
| L240 — failures never echo a prompt or arbitrary herdr diagnostics | F | Generic rejects.toThrow substrings prove refusal but do not exclude canary/prompt in full error.message; capture both errors and assert forbidden bytes absent at Herdr.prompt owner. |
| L251 — harnesses receive explicit model and effort arguments | R | Checks literal Claude/OpenCode model/effort argv; catches dropping declared launch settings. Keep native protocol contract despite helper boundary. |
| L264 — server readiness has one deadline and short probes | R | Checks fake-clock single deadline and bounded probes; catches readiness loop exceeding owner startup budget. |
| L284 — failure to close the initial inherited shell prevents launch | R | Checks initial shell close refusal yields zero agent calls; catches credential-bearing inherited shell kept alongside worker. |
| L307 — rediscovers a claimed agent by pane and validates every identity field | R | Checks blocked/unknown state and identity mismatch with pane-specific get; catches querying stale worker name instead of pane. |
| L319 — answers blocked panes atomically; idle agents use prompt without waiting for a turn | R | Checks blocked pane run is atomic and idle prompt has no wait; catches queued follow-up deadlock or shell splitting text. |
| L328 — archive verifies linked worktree provenance and passes no force or branch deletion | R | Checks linked-worktree provenance, safe remove argv and refusal for unlinked workspace; catches forced/destructive cleanup of ordinary checkout. |
| L350 — real herdr terminal-write acknowledgments are empty on success, while reads remain strict | R | Checks empty write acknowledgement accepted while read/failed-write replies remain strict; catches treating real successful native writes as errors. |
| L370 — DeepSeek fallback starts OpenCode with its provider and delivers follow-up prompts | R | Checks DeepSeek starts native OpenCode and verbatim followup prompts; catches unsupported dsh transport or noninteractive fallback. |
| L398 — Codex and DeepSeek preserve their model IDs and extra arguments | R | Checks literal Codex/deepseek argv including effort/update settings and passthrough extras; catches malformed quoting/model variant arguments. |
| L440 — OpenCode verifies its recorded footer before a brief, including older UI layout | R | Checks recorded/older OpenCode footer before native prompt and metadata/config reads; catches token delivery before verifying actual model. |
| L457 — OpenCode fallback or model-not-found closes only the new pane and sends no brief | R | Checks wrong model/load error closes new pane only and sends no prompt; catches using fallback model with worker credential. |
| L469 — unverifiable and ambiguous panes fail closed with bounded injected polling | R | Checks unverifiable/ambiguous footer never verifies, bounded clock, pane close; catches accepting command echoes as actual model. |
| L509 — pane and metadata failures are sanitized, even when pane cleanup also fails | F | Sanitization claim only asserts generic rejection substrings; append-only canary leaks still pass. Assert full thrown error.message excludes provider/pane canaries in both failure cases. |

#### [`packages/cli/test/http.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/http.test.ts)

History: `757d17d fix(cli): avoid stale HTTP connections and retry safe reads (#181)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L4 — the CLI closes connections after each response so idle polls cannot reuse a stale socket | R | Checks Connection: close replaces keepalive while Authorization/body and caller headers survive; catches stale NAT socket reuse or mutating shared caller headers. |

#### [`packages/cli/test/job.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/job.test.ts)

History: `4322b3a feat(jobs): track long jobs on project runners (#219)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L73 — dispatches with a durable id at the repository root, then a fresh terminal polls progress and stops | R | Checks durable runner ref/id, repo-root dispatch/env, fresh-terminal progress/ETA/stop and no jobs after end; catches local-only job state or wrong runner target. |
| L112 — project and environment selectors dispatch from outside the checkout at the selected repository root | R | Checks env/project selects repo root outside checkout; catches jobs executing under caller cwd. |
| L134 — a worker defaults to its own ticket and reads only its jobs without requesting keys | R | Checks worker own-ticket list/dispatch, foreign stop/recover refusal, no key call and cutoff preventing exec; catches worker touching another job. |
| L155 — an empty start reference remains recorded, visible, and refuses status/stop before executing | R | Checks absent ref persisted and status/stop refused before exec, recover fills ref without native call; catches redispatching uncertain start. |
| L172 — missing status commands and list read the durable state without shell execution | R | Checks list/status without configured probe use durable state and one exec only; catches needless shell execution during listing. |
| L183 — failed or uncertain starts are recorded once; command output is never exposed | R | Checks failed/timeout states differ, dispatch once and raw canary absent; catches retrying ambiguous external job creation. |
| L197 — a failed status preserves the latest observation; an unavailable recording never repeats dispatch | R | Checks malformed status preserves state, recording outage preserves starting/ref recovery hints and idempotent recover; catches repeating native start after lost persistence. |
| L238 — recovery finalizes failed or uncertain dispatch reservations after recording outages without shell execution | R | Checks lost/failed reservations finalized via recover with total one native exec; catches recovery launching a second external job. |

#### [`packages/cli/test/keys.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/keys.test.ts)

History: `527a4ee fix(core): retry temporary Linear, GitHub and Armada failures (#210)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L96 — a credential timeout retries, and exhaustion reports Armada's failure before any Linear call | R | Checks credential timeout retry count and exhaustion error before any new Linear read; catches misleading missing-key error during broker outage. |
| L123 — on a machine with no local keys, armada login then armada status works with the organization's keys | R | Checks login-to-status Authorization, purpose/session payload, no Linear persistence and mode 0600; catches storing server-issued project keys on machine. |
| L148 — Armada is asked on every command: a key replaced in the app takes effect on the next one, with its warnings | R | Checks key rotation/warnings on next command and two broker calls; catches caching revoked key indefinitely. |
| L163 — Armada unreachable: one warning an hour, no keys requests for five minutes, recovery clears the failure | R | Checks failure backoff, hourly notice, fallback, doctor provenance and recovery reset with fake time; catches hammering broker or retaining stale failures. |
| L209 — a revoked sign-in warns once and a new %s login retries immediately | R | Checks revoked-session notice suppression and fresh session/API login immediately retries; catches cache preventing repaired sign-in from obtaining keys. |
| L240 — HTTP %s with a local key backs off for an API-key sign-in | R | Checks 429/server-error attempt rules and no-key exhaustion bypasses remembered fallback; catches hiding current broker error behind cached local success. |
| L268 — a CLI older than Armada expects stops on one line that upgrades it, whatever keys the machine has | R | Checks minimum-version upgrade line independent of stored keys and transmitted client version; catches continuing with incompatible fleet API. |
| L281 — an Armada without a vault, or keys in the environment, leave the terminal as it was | R | Checks no-vault quiet degradation and environment credentials skip broker; catches needless warnings or requests on configured terminals. |
| L297 — workers always ask Armada despite a remembered fallback and stop on a refusal | R | Checks worker always probes broker and stops on explicit revoke despite cached fallback; catches released worker continuing with local keys. |
| L320 — a worker session of another project is refused before any key is asked or anything is written | R | Checks cross-project worker rejects before keys/fleet requests; catches credential exfiltration through wrong checkout. |
| L335 — armada login removes ARMADA_TURSO_URL, ARMADA_TURSO_TOKEN and ARMADA_TURSO_LEASE, without printing them | R | Checks retired database values removed while other lines/session remain and no canary output; catches propagating obsolete terminal database secrets. |

#### [`packages/cli/test/launch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/launch.test.ts)

History: `fa0bdfc fix(cli): mint worker launches only when printing prompts (#101)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L72 — launch revoke sends the project and ticket through the API and clears only that ticket from watch state | R | Checks revoke payload/auth, JSON response and only selected ticket removed from watch; catches clearing every inFlight launch. |
| L102 — with only the launch message, it signs in, claims, reports and hands the ticket back | R | Checks token-to-session storage permissions, lifecycle/credential purpose, release invalidation and file cleanup; catches worker credentials lasting beyond ticket release. |
| L142 — the masked token of the brief's human view is named at once, without asking Armada | R | Checks masked token rejected without API request; catches sending human redaction placeholder to exchange endpoint. |
| L151 — the token signs in once, naming its Conductor session; another ticket gets no key from the session | R | Checks native session handle in exchange, token one-use and foreign-ticket key refusal; catches launch losing runtime provenance or broadening session scope. |
| L169 — revoked, its next report fails with Armada's reason, even with keys in its environment | R | Checks revoked worker report fails despite env key with zero implementing comments; catches broker denial falling back to powerful environment credentials. |
| L185 — login refuses --api-url without a token, and a token with --api-key | R | Checks incompatible token/url/API-key argv combinations fail with recovery; catches ambiguous sign-in target. |
| L195 — a signed-in coordinator releasing a ticket ends its worker session on Armada | R | Checks coordinator release ends worker sessions with project/ticket authenticated payload; catches stale worker authorized after owner release. |

#### [`packages/cli/test/lint.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/lint.test.ts)

History: `f5ff024 feat(cli): check ticket readability before launch (#238)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L14 — ready lint batches descriptions, gives fixes and an error exit; default lint and brief warn without blocking | R | Checks batched ready/open-spec reads, explicit id dedup, strict error/default warning, fixes and warning-before-prompt; catches lint blocking valid launch or reading/warning wrong tickets. |

#### [`packages/cli/test/local-launch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/local-launch.test.ts)

History: `e63072e feat(cli): reserve shared names and numbers for a ticket (#216)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L234 — one launch supplies the herdr brief, then worker login/claim records the returned handle | R | Checks actual created native handle appears in prompt/login/claim and fleet record; catches workers claiming a predicted or wrong workspace. |
| L284 — launch pre-approves only after preflight, and dry-run only describes the label change | R | Checks label write follows runtime preflight and dry-run has no label/token writes; catches approved plans persisted for launches that cannot run. |
| L312 — launch rejects explicit approval labels before runtime preflight or token minting | R | Checks explicit approval label refuses before native/token calls; catches launch bypassing required owner approval. |
| L324 — missing prerequisites and mismatched harness never create a token or runtime | R | Checks missing prerequisites and mismatched harness have zero token/runtime writes; catches wrong harness started with scoped token. |
| L335 — policy decisions and completed tickets are rejected before token creation | R | Checks policy choice and completed-ticket refusal before token; catches launches outside approved policy or closed work. |
| L347 — validation recovery keeps pre-approval and preview flags instead of changing the intended launch | R | Checks recovery argv preserve preview and approval intent; catches a suggested retry silently starting a worker or bypassing policy. |
| L372 — a failed prompt retains the workspace, revokes its token and never leaks it | R | Checks failed prompt retains created workspace, revokes token and masks it; catches orphaned usable tokens or destruction of diagnostic workspace. |
| L381 — an unpublished CLI never launches a worker with an older package's profile rules | R | Checks npm missing stops launch; catches a worker installing an older CLI that interprets profile policy differently. |
| L389 — shared preflight blocks known missing sign-in before token/runtime creation | R | Checks known missing auth prevents token/native creation; catches credentials sent into a harness that cannot start. |
| L397 — JSON launch never prompts or installs even on an interactive terminal | R | Checks JSON interactive mode has no installer/prompt side effects; catches machine consumers mutating their machine unexpectedly. |
| L422 — DeepSeek launch and worker claim explicitly identify the OpenCode fallback | R | Checks DeepSeek profile actually drives OpenCode native launch and claim labels; catches unsupported dsh substitution or misleading profile identity. |
| L453 — a different available DeepSeek model does not launch the configured worker | R | Checks configured exact model missing prevents native launch despite another listed DeepSeek ID; catches unintended provider/model execution. |
| L461 — interactive launch saves the chosen exact DeepSeek model and starts that model | R | Checks numbered model choice persists exact id then starts that id; catches owner-selected model ignored by launch. |
| L481 — JSON launch never prompts or writes a missing OpenCode model | R | Checks JSON missing model prints gaps without config writes/prompts; catches unattended model selection. |
| L494 — a newly selected model/profile is copied to the actual worker worktree before it claims | R | Checks worker worktree receives selected profile configuration before claim; catches new model launched with stale worker metadata. |
| L520 — failed worker config delivery prevents the harness from starting and never logs config content | R | Checks config copy failure prevents harness start and output excludes private config; catches workers using wrong config or disclosing its contents. |
| L531 — known first-run questions stop launch with recovery, retaining the worktree and revoking the token | R | Checks native setup questions keep worktree and revoke token with owner recovery; catches brief sent before harness permissions answered. |
| L558 — a failed token revocation names its recovery without echoing server diagnostics | R | Checks revocation error emits recovery and excludes raw server diagnostics; catches credential leakage while preserving retry instructions. |
| L569 — launch refuses an OpenCode fallback before delivering the worker token | R | Checks wrong OpenCode footer blocks brief token delivery and keeps pane; catches token supplied to a different model. |
| L584 — dry-run prints the plan and creates nothing | R | Checks dry-plan settings plus zero token/native/install/config writes; catches preview causing launch side effects. |
| L613 — dry-run --json gives the same plan as JSON | R | Checks JSON dry-plan serialized profile/branch/worktree/preflight fields with no creation; catches machine-readable plan losing launch facts. |
| L635 — dry-run exits non-zero and lists every gap without creating anything | R | Checks all missing-tool gaps exit nonzero without launch; catches falsely ready plan or hidden prerequisites. |
| L644 — dry-run lists a missing harness sign-in and an unpublished CLI as gaps | R | Checks missing auth and unpublished package both surface in plan; catches partial preflight hiding another blocker. |
| L656 — dry-run honors herdr's configured worktrees directory | R | Checks configured native worktree root shapes predicted path; catches preview pointing recovery at another directory. |
| L662 — dry-run names the deepseek OpenCode fallback and its exact model | R | Checks DeepSeek dry plan identifies actual OpenCode and literal model; catches plan concealing provider fallback. |
| L679 — dry-run lists a missing repository as a gap and still reports the preflight | R | Checks repository failure is a gap while remaining preflight still rendered; catches preview crash hiding recovery. |
| L688 — OpenCode first-run provider questions retain the worker pane before model verification | R | Checks provider setup screen inspected before model catalog/token delivery; catches model checks applied before owner connects account. |
| L699 — herdr launch briefs include declared shared keys and holders, or explicitly warn when unavailable | R | Checks reservation holders appear in actual local brief and outage is explicit; catches launch instructing workers to guess shared resources. |

#### [`packages/cli/test/local-setup.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/local-setup.test.ts)

History: `a32c262 feat(cli): set up local harnesses and explain first-run questions (#160)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L189 — owner setup saves one permission choice, opens each native harness at the actual worktree parent and checks readiness | R | Checks explicit permission choice persisted once, exact real native worktree parent and readiness probes; catches privileged harness start without owner choice or in wrong checkout. |
| L208 — cancel, invalid choice and concurrent config edits never save full or start harnesses | R | Checks cancel/invalid/concurrent config edit produce no save/start; catches full permissions enabled through stale configuration. |
| L217 — JSON and noninteractive setup never ask, save permissions, or start sessions | F | Checks JSON setup is side-effect free, but fixture sets only json:true while name also promises noninteractive setup; add a plain noninteractive case asserting no prompts, config or runtime calls to detect interactive guard regression. |
| L228 — saved explicit decisions survive subsequent setup and remaining questions are reported without answers | R | Checks persisted decision reused and questions reported without supplying answers; catches owner setup asked again or automatically answered. |
| L237 — setup surfaces account/model rejection after the token-free probe without leaking pane content | R | Checks account/model rejection surfaced with no pane content leakage; catches token-free probe treated as ready despite rejection. |
| L247 — edited profile settings cannot be verified by a retained setup session with old arguments | R | Checks edited profile cannot reuse old native argv verification; catches stale model session satisfying new config. |
| L256 — OpenCode provider questions are inspected before model checks and keep the setup pane for the owner | R | Checks OpenCode connection questions inspected before model reads and pane retained; catches unauthenticated profile declared ready. |
| L266 — setup refuses an OpenCode fallback model before its token-free probe and retains the pane | R | Checks incorrect model blocks token-free probe and retains owner pane; catches readiness on a different provider/model. |
| L275 — after the owner clears OpenCode setup questions, reuse verifies the profile before probing | R | Checks reusable pane after questions clears still verifies model before probe; catches stale setup readiness across reruns. |

#### [`packages/cli/test/local-tools.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/local-tools.test.ts)

History: `82518f4 fix(cli): verify local profile models in doctor (#156)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L51 — missing tools have official installers, deduplicated by binary | R | Checks exact official install hints and one probe per distinct binary; catches DeepSeek/OpenCode duplicate installer offers. |
| L67 — herdr requires stable 0.9.1; bad exits and unrecognized output cannot pass | R | Checks old/prerelease/bad-exit/garbled versions fail preflight; catches unsupported herdr accepted from incidental numeric diagnostics. |
| L84 — checks each harness status and the exact DeepSeek model | R | Checks literal status argv and exact model availability drive ready/error state; catches wrong auth endpoint or model accepted. |
| L112 — known missing sign-in blocks launch and only names an owner command | R | Checks known logged-out is blocking and names owner login command without executing it; catches unattended login or launch without auth. |
| L137 — unknown auth and diagnostic failures are not a false missing login | R | Checks uncertain diagnostics remain warning rather than fabricated logged-out; catches false refusal caused by unrecognized harness response. |
| L150 — without an exec adapter detection is unknown, never a claim the tools are missing | R | Checks absent exec becomes unknown without missing-install claim; catches install recommendation unsupported by any machine observation. |
| L162 — declines, empty answers and cancellation run no install; cancellation ends the prompts | R | Checks negative/empty/cancel input yields zero spawn and cancellation stops offers; catches default acceptance or prompts after cancellation. |
| L172 — installs only accepted tools, rechecks and does not execute login | R | Checks only accepted official install executes and rechecks readiness with no login; catches arbitrary installer or invented successful install. |
| L186 — failed installs or an unchanged PATH stay gaps, without printing raw errors | R | Checks failed install/path unchanged retains gap and excludes raw diagnostics; catches false readiness or token echo after failure. |
| L199 — non-TTY, CI, JSON/read-only and missing prompt or spawn never mutate | R | Checks readonly/nonTTY/CI/missing prompt or spawn all suppress mutation; catches installer running in automation. |
| L214 — official installers receive paths but no terminal credentials or provider keys | R | Checks installer env allows paths while removing provider/session credentials; catches supply-chain process receiving terminal secrets. |
| L243 — an accepted official script can repair herdr; the result reflects the new version | R | Checks accepted official herdr script followed by version recheck changes readiness; catches cached old version after repair. |
| L262 — doctor selects only herdr profile harnesses, deduplicated | R | Checks profile-only harness dedup excludes cloud configuration; catches doctor asking cloud users to install local harnesses; localHarnesses has real doctor/setup callers. |
| L274 — doctor lists all configured gaps and JSON/read-only reports never offer installs | R | Checks actual doctor prints every configured gap with zero install prompts in JSON/readonly; catches incomplete machine diagnostics. |
| L296 — doctor offers each gap separately and rechecks only the accepted install | R | Checks actual doctor offers per tool and rechecks only accepted repair; catches refusal of one repair suppressing another choice. |
| L315 — DeepSeek preflight checks exact model IDs across providers without auth or keys | R | Checks exact provider/model ids with zero auth/key operations; catches another provider satisfying configured DeepSeek identity. |
| L345 — doctor checks every distinct DeepSeek profile model with one read-only models call | R | Checks all distinct profile models validated against one native catalog; catches first profile hiding missing second model. |
| L368 — doctor's missing dsh is informational, never an install offer or plugin call | R | Checks optional dsh absence informational with no installer/plugin call; catches unsupported native dsh becoming prerequisite. |
| L396 — consented OpenCode install retains the DeepSeek-specific preflight | R | Checks accepted OpenCode install still applies DeepSeek-specific model gate; catches generic harness readiness bypassing model choice. |
| L442 — doctor asks and saves a missing or unavailable OpenCode model, preserving comments and other profiles | R | Checks owner-selected exact model written preserving comments/other profiles; catches config corruption by setup editor. |
| L474 — model selection without TTY, in JSON/read-only or CI prints choices and config line without a write | R | Checks readonly/CI/nonTTY print model choices without writing; catches unattended profile mutation. |
| L497 — cancelled, empty, invalid and failed model writes leave configuration and readiness unchanged | R | Checks cancel/empty/invalid/save failure retain original config and failed readiness; catches false selected model after failed save. |
| L513 — a present non-DeepSeek model and a variant suffix cannot satisfy an exact DeepSeek selection | R | Checks nonDeepSeek/variant suffix cannot satisfy exact expected selection; catches prefix matching launching wrong model. |
| L524 — a config edit while choosing a model is preserved and prevents a stale write | R | Checks concurrent config edit preserved with stale write refused; catches clobbering owner changes during prompt. |
| L539 — model choice preserves CRLF, quoted section names and literal-string quoting | R | Checks model write preserves CRLF, quoted section and literal-string syntax; catches editable config converted or wrong section touched. |
| L558 — the shared OpenCode preflight validates the supplied exact model without credentials | R | Checks shared exact OpenCode preflight reads catalog without credentials; catches launch helper skipping model validation. |
| L569 — doctor verifies Claude help examples without treating them as a complete catalog | R | Checks Claude help examples verify only advertised identifiers without pretending full catalog; catches unknown model accepted or valid alias rejected. |
| L596 — doctor flags a Codex model absent for this sign-in and keeps harness catalogs separate | R | Checks Codex sign-in-specific catalog separate from Claude/OpenCode catalogs; catches model taken from another harness. |
| L631 — doctor saves only a numbered Codex catalog pick; read-only modes and failures never write | R | Checks only numbered Codex selection saves and readonly/cancel/write failure never writes; catches arbitrary model string or stale config. |
| L661 — doctor bounds the Claude help probe and never reads a Codex catalog after known missing sign-in | R | Checks Claude help bounded and known Codex logout suppresses catalog; catches hanging doctor or account query before auth. |

#### [`packages/cli/test/login.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/login.test.ts)

History: `6951ace feat(cli): sign in to Armada from the terminal with armada login (#33)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L61 — shows the code, opens the page, stores the session 0600; whoami names the person and organization; logout revokes it | R | Checks device code/page, actual 0600 session persistence, identity rendering and revocation; catches lost session, weak permissions or logout retaining authorization. |
| L104 — a denied code stores nothing; an Armada without accounts refuses with its own next step | R | Checks denied/unsupported device flow saves nothing and retains server recovery; catches refusing login still persisting credentials. |
| L119 — login --api-key reads the key from stdin, checks it, stores it; revoked, whoami says to sign in again | R | Checks stdin API key verification/persistence and revoked identity recovery; catches unchecked key saved or revoked key treated as signed in. |
| L142 — ARMADA_API_KEY in the environment signs in with nothing stored, and wins over a stored session | F | Checks environment API-key identity/logout, but no stored session is installed despite promised precedence; remove unsupported title claim. Core credentials.test.ts:52 already owns literal environment-over-stored-session precedence, so preserve CLI output/logout assertions without duplicating that oracle. |
| L153 — a key typed on the command line is refused without being printed | R | Checks pasted positional/equals key rejected without its value printed; catches shell-history misuse disclosing credentials in recovery output. |
| L161 — a sign-in is sent only to the Armada that issued it | R | Checks session only sent to its issuing API origin; catches project/config URL redirect leaking sign-in credentials. |

#### [`packages/cli/test/main-health.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/main-health.test.ts)

History: `11ee2fa feat(fleet): show when main is red and which merge broke it (#204)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L6 — status renders main health and hides unavailable readings | R | Checks exact status main-health text for green/red/running and omission when unavailable; catches coordinator losing actionable failing-main facts or seeing fabricated health. |

#### [`packages/cli/test/main.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/main.test.ts)

History: `69a60ab feat(cli)!: reach the fleet's live data only through the Armada API (#55)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L60 — a printf pipe through bun run posts both message lines | R | Checks real printf shell pipe reaches report with both lines; catches entry stdin reader truncating command input. |
| L72 — a shell heredoc through bun run posts both message lines | R | Checks real heredoc preserves multiline report; catches shell redirected input ignored by entry point. |
| L84 — a large heredoc reads the shell's redirected input to EOF | R | Checks large heredoc read to EOF and reaches tracker; catches buffered redirection truncation beyond small input. |
| L97 — the entry point reads a large Unicode pipe to EOF | R | Checks large Unicode pipe reaches EOF intact; catches byte/character decoding or pipe truncation at entry boundary. |
| L104 — stdin arriving after the reader starts is not mistaken for EOF | R | Checks delayed stdin not mistaken for EOF; catches early close before first pipe data. |
| L110 — empty input is refused before writes: $name | R | Checks empty/whitespace real stdin refuses before tracker writes; catches blank report posted by real entry reader. |

#### [`packages/cli/test/merge.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/merge.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L311 — merge lists unblocked tickets and routed launch hints (json=%s) | R | Checks human/JSON unblocked list and routing-derived launch recovery after confirmed merge; catches lost follow-up work or incorrect profile hints. |
| L361 — a coordinator's merge approval reason is masked before API and Linear comments | R | Checks reason masked before API/Linear/comment writes; catches merge approval text disclosing resolved secrets. |
| L380 — a merge that closes no ticket lists nothing (%s) | R | Checks no-ticket merge omits ticket unblocking/workers closure output; catches unrelated worker lifecycle changed by maintenance PR. |
| L389 — a named merge re-arms only its owned workers and pending launches | R | Checks named coordinator rearm only owned workers/pending launches; catches worker watch bleed between roles. |
| L420 — armada merge test-merges a head behind main, merges it pinned to its SHA and says who to tell | R | Checks real CLI wires throwaway test merge, literal pinned gh argv and worker notification facts; catches head movement or source-checkout mutation. |
| L469 — signed in, Armada down refuses the merge; --no-lock merges anyway and says so | R | Checks signed-in API outage refuses locked merge and explicit no-lock emits warning; catches silent lease bypass. |
| L487 — not signed in, the merge goes on without the lock, with a warning | R | Checks signed-out merge succeeds with missing-lock warning; catches optional Armada dependency preventing authorized standalone merge. |
| L497 — a merge lock held by another coordinator is waited for, then refused; nothing is merged | R | Checks occupied lease retries then refuses with no gh merge; catches two coordinators concurrently merging. |
| L517 — a refused checklist exits 1 and names each failure | R | Checks actual checklist refusal exit1 and rendered reasons; catches command presenting failed gate as successful merge. |
| L528 — armada merge --wait updates a head behind main on GitHub, proves the update only brings main in, and merges it | R | Checks wait mode updates branch pinned to head and proves only main changed before merge; catches stale handback authorizing added product commits. |
| L545 — armada merge refuses flags that do not go together | R | Checks incompatible flags fail before work; catches preview/wait/no-ticket ambiguity causing unintended merge. |
| L559 — CLI accepts --no-ticket --reason and posts its audit comment without ending the worker | R | Checks no-ticket reason audit comment without worker session end; catches maintenance merge releasing active ticket. |
| L583 — a confirmed merge launches its owned deferred follow-up through the shared Conductor launcher in the same run (%s) | R | Checks confirmed merge launches owned deferred follow-up once through native launcher; catches durable follow-up left stranded or duplicate launch. |
| L669 — when-green persists intent without merging, deduplicates, lists on a new invocation and removes | R | Checks when-green persists across invocations, deduplicates/lists/removes with zero merge; catches queue intent lost or eagerly executed. |
| L694 — when-green queues multiple no-ticket PRs in argument order and preserves flags | R | Checks multiple queued PRs keep argv order and keep-open/hold intent; catches queue reorder or intent dropped. |
| L732 — merge archives only its confirmed, ended Armada worker (%s) | R | Checks archived workspace is only confirmed ended Armada generation and recovery remains nonfatal; catches delete of live/replacement/coordinator workspace. |
| L886 — afterMerge refuses incomplete archive evidence (%s) | R | Checks incomplete archive proof leads zero runtime writes; catches claim-less snapshots authorizing deletion. |
| L938 — confirmed merge ends worker sessions before starting matching deploy watchers | R | Checks ended worker sessions precede matching deploy watcher start; catches old worker authorization retained or unrelated target watched. |

#### [`packages/cli/test/opencode-model.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/opencode-model.test.ts)

History: `048492d fix(cli): recognize OpenCode model and provider footer names (#165)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L42 — recorded DeepSeek and Gemini footers resolve model AND provider display names | R | Checks recorded native footer resolves literal model plus provider display identity; catches same-name model routed through wrong provider. |
| L54 — splash screen is polled until the recorded footer appears | R | Checks splash polling bounded until recorded footer; catches preflight rejecting normal initial startup or accepting splash as verified model. |
| L61 — GLM fallback and the same model on another provider are real mismatches | R | Checks GLM/same model other provider rejected; catches incorrect model/provider accepted from fallback. |
| L71 — unknown provider, model-name prefix, and command echoes never verify | R | Checks unknown provider, prefixes and echoed command fail verification; catches command text impersonating native footer. |
| L86 — unavailable provider catalog fails closed without surfacing metadata | F | Catalog-error fixture contains a private canary but only asserts rejects.toThrow('could not verify'); appending metadata still passes. Assert complete error excludes canary while retaining fail-closed result. |
| L93 — resolved provider display-name overrides match the TUI identity | R | Checks resolved provider display-name override maps exact footer; catches valid named provider rejected by fixed display-label assumptions. |

#### [`packages/cli/test/output.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/output.test.ts)

History: `d4f4187 fix(cli): finish large piped output before exiting (#34)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L61 — status --json writes a large Unicode result completely before exiting | R | Checks actual Node/Bun bundled subprocess JSON emits full large Unicode result before exit; catches process.exit truncating asynchronous stdout or broken UTF-8. |
| L70 — a large error is written completely and keeps the usage exit code | R | Checks large subprocess error drains completely and exit remains usage2; catches incomplete recovery output or flush changing exit contract. |

#### [`packages/cli/test/peek.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/peek.test.ts)

History: `8a8246d feat(cli): see what workers are doing with armada peek (#217)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L140 — peek shows local runtime facts, redacted reply and commands and keeps its cursor/tail across reads | R | Checks actual CLI local runtime/report/reply/commands serialization, redaction and persisted incremental cursor; catches transcript replay or secret/cache disclosure. |
| L167 — peek reads a local herdr worker through the same command | R | Checks herdr pane path feeds same command result; catches registry supporting only Conductor inspection. |
| L201 — peek reads a bound %s launch before sign-in or claim | R | Checks bound pending native launch inspectable before worker claim; catches launch troubleshooting requiring missing claim. |
| L219 — an unreachable runtime preserves the stored observation and its age | R | Checks unreachable runtime preserves stored state and observation age; catches outage represented as fresh false activity. |
| L237 — peek refuses worker sessions and invalid action counts before runtime reads | R | Checks worker scope and malformed action counts refused before runtime reads; catches worker inspection privilege escalation or unbounded count. |
| L268 — peek reads PR check counts once and reports missing GitHub credentials | R | Checks one PR check read and missing-credential warning with counts; catches wrong head diagnostics or hidden inability to inspect CI. |
| L330 — Conductor bounds a long transcript, resumes from its cursor and reads archived/unknown formats | R | Checks transcript page/size bound, cursor resume and archived/unknown format behavior; catches unbounded historical scan or fabricated parsed commands. |
| L377 — Claude replies and tool results expose command exit codes | R | Checks Claude tool-use/results associate literal exit codes with commands; catches successful/failed tools represented identically. |
| L426 — a pending replacement is inspected instead of the released previous claim | R | Checks pending replacement chosen over ended old claim; catches inspecting wrong worker after relaunch. |
| L454 — incremental Claude completion updates a cached command and user prompts preserve the worker reply | R | Checks incremental completion updates cached command and user prompt cannot replace assistant reply; catches permanently unknown exit or owner message shown as worker response. |
| L506 — whole configured secrets are masked before prefixes, including resolved unprefixed tokens and the cache | R | Checks longest exact secrets masked before prefixes in returned text and machine cache; catches partial secret suffix or plaintext persisted transcript. |

#### [`packages/cli/test/presence.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/presence.test.ts)

History: `fa0bdfc fix(cli): mint worker launches only when printing prompts (#101)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L20 — harness detection uses only exposed facts, with Conductor taking precedence | R | Checks exposed native facts/Conductor precedence with exact inferred identities; catches ambiguous harness environment recording wrong runtime owner. |
| L48 — $command records coordinator command facts | R | Checks actual coordinator command writes literal runtime facts through fleet; catches presence omitted or recorded by worker/help commands. |

#### [`packages/cli/test/process.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/process.test.ts)

History: `c9b594a fix(cli): stop only the current project watch (#133)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — Linux watch identity includes boot and kernel start ticks, handles parenthesized commands and fails closed | R | Checks Linux proc fixture boot/start ticks and parenthesized commands plus fail-closed errors; catches reused PID mistaken for original watch. |
| L44 — macOS watch identity uses the exact ps command and start time and lsof's cwd, or stays unverified | R | Checks literal macOS ps/lsof argv, exact start/cwd and unverified failure result; catches stopping another process from loose native identity parsing. |

#### [`packages/cli/test/release.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/release.test.ts)

History: `07b419b feat(cli): announce releases without stopping ordinary watches (#231)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L47 — ordinary releases never interrupt watch; notices are daily across versions and repeat after 24 hours | R | Checks ordinary release never becomes watch item, daily notice survives version changes and repeats after24h; catches interrupting fleet for optional upgrade or suppressing future notices. |
| L66 — a minimum-version refusal remains required after a quiet notice and without a machine store | R | Checks minimum-version requirement persists despite optional notice and absent machine store; catches obsolete CLI watch continuing against incompatible API. |
| L78 — \`${name} setup drift interrupts watch even without a newer release\` | R | Checks each bundled skill setup drift yields actionable required item even without newer version; catches incompatible local instructions silently retained. |
| L90 — legacy release memory migrates without suppressing notices forever; workers stay quiet | R | Checks legacy release cache migration allows notice and actual worker noticeRelease/pendingRelease remain quiet; catches migration suppressing notices forever or upgrade chatter sent to workers. |
| L105 — concurrent commands reserve only one daily notice across versions | R | Checks concurrent independent terminal calls reserve single daily notice across versions; catches duplicated upgrade spam from race. |

#### [`packages/cli/test/repo.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/repo.test.ts)

History: `f645ae6 feat(cli): bundle shipping skills for every managed project (#131)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L12 — the plan is never written through a linked folder, so the link's target stays intact | R | Checks actual symlinked parent target remains byte-identical and entire setup plan refused before writes; catches writes escaping checkout. |
| L29 — a skill file symlink refuses the whole update before any write | R | Checks skill-file symlink refuses full plan before any other output changed; catches partial updates or external symlink target overwritten. |

#### [`packages/cli/test/reserve.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/reserve.test.ts)

History: `e63072e feat(cli): reserve shared names and numbers for a ticket (#216)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L45 — CLI allocates numbers, names and exclusive keys; lists holders and only unreserves the selected ticket | R | Checks allocation variants/list/unreserve scoped to selected ticket through actual CLI; catches shared identifiers guessed, holders hidden or another worker reservation freed. |
| L73 — allocation flag mistakes are refused before writes; outages fail clearly without a Linear fallback | R | Checks conflicting argv and unavailable API cause zero writes with no Linear substitute; catches split ownership or ambiguous allocator mode. |
| L92 — reservation commands honor the watched project selector away from its checkout | R | Checks watched project selection resolves remote checkout reservation project; catches allocation in cwd project instead of chosen fleet. |

#### [`packages/cli/test/runtime-adapters.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/runtime-adapters.test.ts)

History: `df8f084 feat(fleet): check Conductor sessions before silence alarms (#213)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L212 — %s adapter reads without mutation, validates handles, and guards message delivery | R | Checks each adapter literal native reads, invalid handles and guarded delivery with reclaimed-generation refusal; catches read side effects or message reaching replacement worker. |
| L270 — Conductor preflight, launch, transcript and failures keep secret text off argv and output | R | Checks Conductor auth/catalog, exact create stdin protocol, transcript redaction, acknowledgement and error code handling; catches native incompatibility or token in argv/output. |
| L340 — Conductor refuses active archive, verifies workspace ownership, waits boundedly and stops only ended generations | R | Checks active archive refused, provenance validated, bounded idle wait and only ended generation deleted; catches running or wrong workspace deletion. |
| L367 — a replacement during Conductor provenance checks prevents cancel and archive writes | R | Checks generation replacement during native provenance prevents cancel/archive; catches time-of-check race deleting successor. |
| L406 — Conductor observations are throttled across processes, retain failed reads and surface stored state in inbox | R | Checks persisted observation throttle across processes/old watch snapshots retains failure state and inbox age; catches probe floods or outage inventing active state. |
| L443 — herdr rechecks the generation after internal state reads and before native writes | R | Checks herdr generation reread after internal state access before each native write; catches ownership race reaching new pane. |
| L486 — herdr cancellation and archive timeouts are uncertain mutations, never retryable outages | R | Checks uncertain cancel/archive timeout becomes nonretryable unknown-outcome; catches duplicate native mutation on timeout retry. |
| L510 — Claude Code refuses every adapter operation with the manual guide and executes nothing | R | Checks every guided Claude adapter operation refuses with guide and zero native exec; catches unsupported operation falsely claiming native completion. |
| L531 — Conductor observes only stale heartbeats and readings, using bounded reads; archives end the exact claim | R | Checks heartbeat/read staleness controls bounded native probes and gone closes exact generation; catches needless runtime load or old observation closing successor. |
| L550 — missing or unsigned Conductor retains the current claim and prints no error | R | Checks unavailable/unsigned Conductor leaves claim intact and command quiet; catches optional probe failure destroying working claim. |
| L572 — an archive observation cannot close a replacement claim | R | Checks replacement between archive read and publication cannot end new claim; catches stale gone write closing successor. |
| L600 — ended archive refuses new workspace sharing during %s | R | Checks sibling starts sharing ended workspace during provenance/wait prevents all archive writes; catches deletion beneath another ticket. |

#### [`packages/cli/test/runtime.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/runtime.test.ts)

History: `69c173f feat(cli): archive workers after confirmed merges (#214)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L147 — a fresh coordinator finds a blocked claim before its next report, answers in one command, and clears the inbox | R | Checks coordinator discovers native blocked claim and answer both delivered and recorded/resolves inbox; catches question lost until next report or answer falsely recorded. |
| L159 — failed runtime delivery leaves questions open and writes no answer; failed validation never prompts | R | Checks native delivery failure leaves question open/no tracker answer and invalid validation never prompts; catches recording undelivered authorization. |
| L180 — stop refuses remaining work: $expected | R | Checks dirty/unpushed/unverified Git state produces no archive/release; catches destroying unique local work. |
| L193 — stop archives a pushed worktree after release too, with no force or branch deletion | R | Checks released clean pushed tree removed with fresh upstream proof and no force/branch deletion; catches cached ref authorizing data loss. |
| L212 — unknown/runtime failures preserve reports instead of inventing a fresh working state | R | Checks unknown/runtime error keeps last report instead of new working fact; catches outage suppressing silence alarm. |
| L231 — phase self-reporting uses Armada source, maps every phase, and is nonfatal | F | Expected state is herdrPhase(phase), the same mapper reportHerdr invokes; a wrong mapping passes both sides. Use literal phase/state table at native argv boundary, retaining nonfatal-error assertion. |
| L269 — report and ask self-report their resulting phase, including nonfatal herdr failures | R | Checks report/ask literal native working/blocked argv and nonfatal runtime failure; catches wrong phase sync or optional runtime failure rejecting tracker report. |
| L294 — heartbeat uses its current scoped phase and continues when herdr reporting fails | R | Checks heartbeat current scoped phase/API write survives native reporting error; catches lifecycle liveness depending on runtime connectivity. |
| L310 — a failed archive record can be retried after herdr explicitly confirms the workspace is gone | R | Checks native explicitly absent archive supports idempotent stop record retry; catches permanent recovery refusal after successful physical deletion. |
| L326 — heartbeat preserves a detected harness question before any worker report | R | Checks heartbeat preserves native detected blocked state before report; catches liveness ping clearing unresolved harness question. |
| L334 — stop keeps the worktree when verification sees a %s | R | Checks new commit/pane replacement during verification prevents remove/release; catches destructive stop race. |
| L354 — a live herdr claim receives an answer despite stale tracker phase labels | R | Checks native live claim answer despite stale tracker phase; catches legitimate blocked-worker answer refused by delayed label. |
| L371 — an answer validated for an old claim never reaches its replacement | R | Checks old claim replaced during tracker validation gets no native message or answer write; catches authorization delivered to successor. |
| L408 — reused runtime IDs in another repository are neither observed nor messaged | R | Checks reused native IDs in different repo never observed/messaged; catches cross-project data exposure or commands. |
| L423 — stop retains the checkout when cancellation does not settle the active turn | R | Checks unsettled cancel retains worktree and claim; catches deletion while native process still writing. |
| L436 — a second native approval between polls reappears without any worker report | R | Checks second native approval sequence surfaces distinct inbox without new report; catches coordinator missing repeated permission prompt. |
| L448 — DeepSeek profiles keep their model label while report, heartbeat, answer and stop drive OpenCode | R | Checks DeepSeek profile identity retained while OpenCode native drives report/heartbeat/answer/stop; catches metadata/native harness confusion. |
| L533 — merge recovery stops only the ended merged generation (%s) | R | Checks merge recovery requires matching ended generation/event/pinned claim key; catches stale stop recovery deleting replacement. |

#### [`packages/cli/test/secrets.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/secrets.test.ts)

History: `fceaf43 feat(secrets): mask worker output and messages (#239)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L97 — the child gets them, Armada's value over a variable of the same name; nothing is printed but the names | R | Checks actual child env uses scoped released values over terminal variables with names-only CLI output; catches secret source reversal or value disclosure. |
| L119 — pipes split secrets and credential values on both channels, keeping the exit code | R | Checks split secret/credential chunks across both channels masked while child exit preserved; catches stream-boundary leakage or error-code loss. |
| L137 — TTY output inherits with one warning, and --redact forces pipes | R | Checks TTY warns/inherits and explicit redaction supplies masked pipes; catches misleading privacy promise or ignored --redact. |
| L153 — the real pipe preserves split UTF-8 and drains both channels before returning | R | Checks real subprocess pipe preserves split UTF8 and drains stdout/stderr before completion; catches decoder corruption or exit truncation. |
| L165 — --only hands out the names asked for and says which are not set | R | Checks --only exact requested release and missing-name recovery; catches overbroad secret release or hidden missing config. |
| L176 — a real child process holds the secrets in its environment, and Armada's output holds none | R | Checks real child sees secret env and Armada output excludes it; catches fake-spawn-only wiring gap or parent disclosure. |
| L187 — without a command after --, or with -- on another command, it is a usage error | R | Checks missing passthrough/unsupported command separator is usage error with no spawn; catches accidental executable dispatch. |
| L197 — its worker session is refused in another project's repository, before anything is asked | R | Checks worker token project mismatch rejected before any release; catches cross-project secret request. |
| L205 — setting never goes out with a worker session: the coordinator's own sign-in on the same machine sets | R | Checks setter uses coordinator sign-in despite colocated worker session; catches privilege routing to wrong identity. |
| L220 — from a hidden prompt, standard input or a variable of this environment | R | Checks hidden prompt/stdin/env ingestion, cancellation and newline handling; catches secret value echoed or unintended truncation. |
| L246 — a value on the command line is refused without being quoted; without a terminal it says how | R | Checks pasted value refused without quote and headless recovery names stdin/env; catches argv value leakage. |
| L263 — the list names each secret, where it is set, who set it and when; unset removes one | R | Checks list human/JSON metadata and unset scopes without exposing values; catches wrong scope/name output or deletion. |
| L289 — get prints one value for a person, with a warning on stderr that it is now visible | R | Checks deliberate get emits exact one value with transcript warning; catches silent disclosure or wrong secret printed. |
| L302 — refused for a path git tracks or does not ignore; written 0600 where it ignores it | R | Checks tracked/nonignored path refused, ignored dotenv written0600 and multiline skipped; catches committing exported credentials or unsafe file permissions. |

#### [`packages/cli/test/spec.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/spec.test.ts)

History: `6f544bb feat(cli): add specs without renaming every other spec (#206)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L38 — spec add appends immediately with a template, root parent and printed URL, without renames | R | Checks actual add writes template/root parent and renders created URL without rename; catches misplaced spec or empty authoring contract. |
| L53 — explicit position previews all renames and creates nothing without --apply | R | Checks positioned add previews all title writes with zero mutation absent apply; catches preview renaming tracker hierarchy. |
| L62 — spec add --apply updates totals and suffix in sequence before creating under the root | R | Checks apply sequential renames preserve totals/suffix before create; catches mixed hierarchy numbering or premature creation. |
| L85 — append with totals previews the global total bump, and renumber previews by default | R | Checks totals append/renumber default to full read-only preview; catches implicit bulk renumber. |
| L101 — a failed write stops immediately and lists only the unfinished operations | R | Checks failed rename stops immediately and displays only pending operations; catches additional partial writes or misleading recovery. |
| L116 — creation failure lists the pending creation after successful renames | R | Checks failed creation after successful renames lists only missing creation; catches recovery repeating completed renames. |
| L127 — truncated program reads refuse writes and invalid positions refuse the plan | R | Checks truncated program and invalid position reject before write; catches bulk changes based on incomplete hierarchy. |
| L148 — a stored worker session is refused before any key request, even with an environment key | R | Checks stored worker scope refused before coordinator key release even env key present; catches worker session borrowing coordinator privileges. |

#### [`packages/cli/test/upgrade.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/upgrade.test.ts)

History: `07b419b feat(cli): announce releases without stopping ordinary watches (#231)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L68 — upgrade waits for the exact tarball, verifies the installed version and leaves current setup alone | R | Checks exact npm tarball publication before install, native installed version verification and current setup untouched; catches speculative install or unnecessary setup merge. |
| L79 — only setup checks from the newly installed doctor trigger init --merge | R | Checks only upgraded doctor setup checks trigger init--merge; catches unrelated readiness failure causing repository writes. |
| L85 — publication waits are bounded to five checks and four sleeps, with no install | R | Checks five publication attempts/four injected sleeps and no install when absent; catches unbounded wait or unavailable-version install. |
| L92 — upgrade dispatch uses the selected checkout; workers cannot upgrade | R | Checks actual dispatch selected checkout and worker refusal before upgrade; catches pinned worker CLI changed or wrong repo setup. |
| L104 — a server-required target wins over lagging npm metadata, and registry outages are bounded | R | Checks server-required newer version wins stale npm metadata with bounded outage; catches upgrading to still-incompatible release. |
| L118 — the upgraded doctor cannot downgrade skills installed by an even newer CLI | R | Checks newer installed skill pointer never downgraded by older doctor; catches overwrite of future instructions. |
| L131 — selected nested/custom configs are refused before install, and a mismatched doctor cannot refresh setup | R | Checks nested/custom config refusal and mismatched doctor before setup refresh; catches writes from wrong checkout/version. |
| L161 — \`upgrade stops safely at ${JSON.stringify(options)}\` | R | Checks native install/version/doctor/init failure stages stop with recovery; catches continued mutation after failed prerequisite. |

#### [`packages/cli/test/watch.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/watch.test.ts)

History: `a5823d8 feat(cli): scope named coordinators to their own work (#243)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L108 — named watch defaults to mine, all opts out, and unnamed watch retains the full fleet | R | Checks named watch defaults mine, all opts out, unnamed whole fleet using API scopes; catches one coordinator consuming another role wakeups. |
| L135 — named inbox defaults to all, mine labels owned/unowned entries and keeps an owned re-arm count | R | Checks inbox all/mine rendering includes ownership and owned rearm count; catches broad read keeping role watch falsely busy. |
| L175 — stop verifies the holder and signals only this project's watch, without sign-in or network | R | Checks verified holder only SIGTERM for project and no network/sign-in; catches stop killing unrelated process or requiring unavailable API. |
| L210 — stop recognizes source and bundled watches with global options before the command | R | Checks source/bundle process commands with global argv recognized exactly; catches legitimate watch unable to stop after normal config flags. |
| L230 — stop clears a dead lock, but never signals a legacy, reused, other-project or non-watch PID | R | Checks dead lock cleanup but legacy/reused/other-project/nonwatch pid never signaled; catches PID reuse killing arbitrary process. |
| L290 — stop keeps the lock on kill failure and preserves a replacement holder | R | Checks signal failure retains lock and replaced holder survives cleanup; catches losing live watch ownership after failed stop. |
| L310 — stop refuses a holder replaced during inspection and handles a process gone before signalling | R | Checks holder replacement during inspect refuses and ESRCH cleanup scoped; catches killing successor or retaining dead stale lock. |
| L336 — \`${signal} during ${during} prints one shutdown line and releases only its lock\` | R | Checks each native signal during pending read/sleep prints one shutdown and releases only own lock; catches hung termination or successor lock deletion. |
| L374 — \`ordinary releases leave ${follow ? "follow" : "plain"} watch running until real work arrives\` | R | Checks optional release notices leave plain/follow running until real item; catches watch ending on nonactionable upgrade chatter. |
| L394 — \`a server minimum interrupts ${follow ? "follow" : "plain"} watch with a version item\` | R | Checks required server minimum interrupts plain/follow even filtered streams; catches incompatible watcher looping forever. |
| L414 — a server already requiring a newer CLI returns a version item on the first read | R | Checks required version on first API read yields actionable item; catches startup refusal silently stopping coordinator watch. |
| L420 — watches until a hand-back, prints it with the re-arm line, and leaves the state for the stop hook | R | Checks full handback wakeup/rearm, persisted seen/state and stop-hook decision; catches coordinator ending without watch or duplicated seen handback. |
| L505 — Armada down does not end the watch; a refusal does, and the stop hook then lets the turn end | R | Checks outage retried but signed-out refusal records stopped and frees hook; catches transient outage ending watch or hook trapping revoked session. |
| L552 — a hook that cannot read its input or its state lets the turn end | R | Checks unreadable stdin/state hook fail open; catches repository corruption trapping coordinator indefinitely. |
| L565 — two named coordinators watch one project concurrently and each wakes for its own item | R | Checks two named role locks coexist and each wakes for its own item; catches names sharing lock or cross-role seen cache. |
| L621 — follow NDJSON streams both items, persists, times out cleanly and shares the watch lock | R | Checks actual follow NDJSON, cursor persistence/bounded exit and shared watch lock; catches replay, malformed framing or parallel duplicate watchers. |
| L671 — plain watch accepts a bounded lifetime and follow refuses unsupported or malformed filters | R | Checks bounded plain watch and invalid stream filter argv refusal; catches uncontrolled watch duration or ineffective filtering. |
| L695 — long watch deadlines are chunked below Node's timer limit and cancellable | R | Checks injected deadline never exceeds literal Node timer bound and cancellation prevents expiry; catches multiweek timeout firing immediately. |
| L729 — named follow watches retain independent cursors, seen items and resume roles | R | Checks named follow independent cursors/seen sets and role-preserving resume; catches role switch replay/skipping another coordinator events. |

#### [`packages/cli/test/worker.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/worker.test.ts)

History: `fceaf43 feat(secrets): mask worker output and messages (#239)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L76 — coordinator release pins its claim and spares a worker launched afterward | R | Checks coordinator release pins claim timestamp and spares later worker authorization; catches broad revoke of successor session. |
| L137 — --stage reaches shipping events and refuses invalid phase or value | R | Checks shipping stage argv reaches fleet/tracker and invalid stage/phase zero writes; catches missing review/CI visibility or malformed lifecycle accepted. |
| L154 — shipping paths reach the ticket and coordinator inbox, without inventing legacy review evidence | R | Checks shipped-with text reaches handback/inbox, fallback reason validation and legacy unreported; catches claiming independent review without evidence. |
| L184 — a signed-in worker claims, reports on its branch and releases; Armada records every event | R | Checks complete actual CLI worker lifecycle uses ticket scope and records ordered events; catches missing/auth-misrouted fleet writes. |
| L220 — refusals exit 1 with the reason: invalid transition, short SHA, red CI | R | Checks transition/fullSHA/CI refusals exit1 and recovery reasons; catches command success despite rejected handback. |
| L244 — usage mistakes exit 2 | R | Checks malformed worker argv exit2 with recovery; catches parser permitting missing identity/reason/text. |
| L263 — a ready-to-merge report without a message option stays valid | R | Checks message-optional ready handback remains accepted with valid PR/SHA; catches existing authoring contract rejected. |
| L276 — --plan-file posts the plan under a one-line status, from a file or standard input | R | Checks file/stdin plan bytes and one-line summary preserved, mutually exclusive stdin rejected; catches plan truncation or reading same pipe twice. |
| L300 — an explicitly blank message file is refused even for a hand-back | R | Checks explicit blank message file rejected before writes even handback; catches empty input treated as omitted option. |
| L311 — outgoing reports, plans, questions, validations and answers mask before API and Linear | R | Checks all outgoing report/plan/ask/validate/answer text masked before API and tracker; catches disclosure through secondary write channel. |
| L354 — a partial secret release still masks every readable value | R | Checks partial release masks each readable secret despite warning; catches one unavailable vault key disabling all masking. |
| L377 — an unreachable Armada only warns; Linear is still written | R | Checks fleet transport failure warns while Linear report still writes; catches optional store blocking authoritative report. |
| L391 — a revoked API key only warns; Linear is still written | R | Checks revoked optional coordinator API key warns while Linear record writes; catches credential outage losing progress. |
| L404 — armada status measures silence from the last live event on Armada | R | Checks status silence based on actual latest fleet event serialization; catches fresh report flagged stuck from stale tracker timestamp. |
| L429 — armada status lists the workers launched that never claimed, under their own heading | R | Checks pending token unused/signedin-no-claim under separate heading with expiry facts; catches preclaim worker disappearing from coordinator status. |
| L457 — inbox identity: %s | R | Checks explicit/complete/partial/blank native identities filter coordinator's own session correctly; catches self counted as silent worker or another worker excluded. |
| L498 — answer checks a hand-back's PR through the CLI and records only the recovery note | R | Checks answer reads real PR state and only merged/closed handback recovery note resolves it; catches bypassing open-PR handback through answer. |
| L521 — a worker asks, the coordinator reads its inbox and records the answer, the worker resumes | R | Checks actual ask/inbox/answer/resume command flow including transport and rendered text; catches lost answer or blocked phase not resumed. |
| L566 — inbox --wait asks Armada every 15 s, sending the last read's etag, until a new item or its timeout | R | Checks inbox wait15s ETag polling until item/timeout with literal headers/output; catches stale duplicate response or unbounded wait. |
| L603 — usage mistakes exit 2; the inbox needs a sign-in | R | Checks malformed inbox/ask/answer argv exit2 and unsigned inbox refuses; catches unauthenticated fleet reads or ambiguous text accepted. |
| L622 — worker claim comments inherit the authenticated launch owner despite a different environment name | R | Checks worker claim authenticated launch owner beats spoofed env in comment/store; catches worker impersonating another coordinator. |
| L658 — hold commands share the pause with status and clear it idempotently | R | Checks hold CRUD/shared status/selector/idempotent clear with invalid input rejection; catches local-only pause or wrong project hold. |
| L701 — report accepts repeated --paths, records declarations in Linear and prints overlap warnings | R | Checks repeated paths normalized and recorded with overlap warnings, invalid paths refused; catches workers declaring wrong ownership or hidden conflicts. |

### dashboard-api

#### [`packages/dashboard/test/accounts.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/accounts.test.ts)

History: `79d6c37 feat(dashboard): a living landing page for signed-out visitors (#104)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L26 — every required variable turns accounts on; none keeps the password gate; some fail closed, named | R | Configuration contract: asserts production email login is disabled, retired/PGlite database fails closed, normalized owners and exact missing variables; catches accidental open fallback. |
| L65 — a request is signed with the person's name and address, within core's 80 characters | R | Actor-byte contract: independent short/name-equals-email/oversize examples assert signed text and email fallback; catches overlong tracker authors. |
| L141 — the committed migrations are what Better Auth needs, and replaying them changes nothing | R | Dependency/schema contract: Better Auth getMigrations reports no missing tables, columns or indexes after real app migrations and replay returns schema version; catches upgrade incompatibility. |
| L151 — an account is by invitation; an owner address signs up, confirms it and creates the first organization | R | Security boundary: real Better Auth/PGlite refuses stranger creation, denies unverified email sign-in, establishes verified owner session and owner membership; catches account squatting. |
| L179 — an owner invites by email; the invited address signs up, and after accepting belongs to the organization | R | Security boundary: real invitation acceptance refuses wrong address and member organization/invite creation, checks normalized mail and active organization; catches role bypass. |
| L262 — a stranger, or an owner address GitHub has not verified, is sent back with no session; an owner gets in | R | OAuth/security boundary: fake GitHub transport plus real Auth denies uninvited/unverified profiles, grants verified owner, checks sealed stored accessToken and server retrieval; catches plaintext/token trust regression. |
| L300 — without a session, pages go to sign-in and data answers 401; Better Auth's routes and sign-in pass | R | Proxy protocol: page redirect preserves next while data/actions return 401; auth and signed-webhook entry routes pass even unavailable; catches inaccessible callback or unguarded data. |
| L318 — a visitor without a session sees the landing on /, with no session lookup, even while sign-in is down | R | Public landing architecture: throwing session lookup is bypassed without cookie, writes deny, stale/valid cookies route correctly and Vary Cookie is asserted; catches landing outage/cache leak. |
| L341 — half-configured accounts serve nothing, not even the password gate, and name what is missing | R | Fail-closed deployment: incomplete accounts answers 503 on JSON and page and identifies missing variable; catches unsafe password fallback. |
| L351 — with a session everything passes but the sign-in page; an unreadable accounts database fails closed | R | Proxy lifecycle: signed-in data passes/login redirects, unavailable account reads return 503 for cookie-bearing requests; catches fail-open outage. |

#### [`packages/dashboard/test/activity-store.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/activity-store.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L155 — lists every event of the fleet newest first, and never a heartbeat or an inbox read | R | SQL feed contract: exact ordered mixed-source kinds omit heartbeat/inbox reads and foreign project merge; catches missing UNION branch or leaked noise. |
| L178 — says who did it | R | SQL actor attribution: checks launch/revoke/decision/request person names and agent/coordinator roles plus decision note/ref; catches incorrect attribution join. |
| L192 — filters by kind in every source, and the reports by phase | R | SQL query filtering: concrete mixed kinds and blocked phase outputs prove branch-level filtering; catches phase filter excluding questions or unrelated reports entering blocks. |
| L212 — pages on its cursor without a gap or a repeat | R | Cursor storage contract: gathers four-row pages and compares complete key sequence to unpaged result; catches omission/repeat at cursor boundary (equal-time case still worth extending). |
| L226 — reads only the projects it is given | R | Project scope: foreign-only query returns only G-1 and empty projects returns none; catches omitted project predicate. |
| L233 — reads the merges, claims, blocks, silences and what waits since a visit's start | R | Catchup query contract: independently specified merges/claims/blocks/gaps/waiting and sinceSummary reasons distinguish finite silent gap from blocked wait; catches SQL range/phase loss. |
| L252 — reads a silence whole when it began long before the visit's start, and stops at its end | R | Cross-window storage: late start excludes ended gap, crossing start retains original from, until before merge excludes it; catches clipped silence or future event inclusion. |
| L268 — start a new one after more than 30 minutes away, from when the viewer was last seen | R | Visit persistence: concrete timestamps prove absence threshold, stable visit window, late-beacon monotonicity and organization isolation; catches multi-tab rollback. |
| L280 — dismiss the summary of one visit only | R | Visit dismissal identity: wrong since refuses, current since persists and next visit retains old dismissal marker; catches dismissing future summary. |
| L287 — keep the notification settings | R | Settings persistence: default off and quiet-hours roundtrip for account/browser keys; catches losing notification settings in SQL upsert. |

#### [`packages/dashboard/test/attachments.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/attachments.test.ts)

History: `d03b5cc feat(attachments): let agents privately attach screenshots and links (#103)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L40 — an image and link are private metadata with member-only bytes | R | Storage/security boundary: asserts metadata omit bytes, private cache/content type/exact downloaded bytes, unauthenticated/foreign scope denials and HTTPS link redirect; catches attachment exposure. |
| L73 — duplicates store bytes once, can bind a new free reference, and do not consume quota | R | Quota/dedup contract: same content produces same id, updates reference, one SQL row and new link fails one-item quota; catches duplicate storage charging quota. |
| L94 — size, actual type and project byte quotas are enforced | R | Storage admission: oversize bytes, magic-byte/MIME mismatch and project cumulative quota throw the intended errors; catches quota/type bypass. |
| L115 — transactional ticket quotas hold for concurrent uploads | R | SQL atomic quota: concurrent distinct uploads yield one success and one stored row; catches check-then-insert race. |
| L129 — retention starts at completion, keeps active tickets, and resets on reopening | R | Retention storage contract: completion threshold deletes at day 30, unrelated active bytes survive, reopened doneAt is reset and not pruned; catches deleting active evidence. |
| L158 — the upload body is bounded and malformed images are rejected before storage | R | Transport admission: streamed body beyond 3 MiB and malformed base64 reject before persistence; catches unbounded memory or permissive decode. |

#### [`packages/dashboard/test/auth.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/auth.test.ts)

History: `79d6c37 feat(dashboard): a living landing page for signed-out visitors (#104)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L39 — sends a page to the login page, keeping where the viewer was going | R | Redirect protocol: anonymous app query returns 307 login with exact next path; catches losing navigation destination. |
| L47 — shows the landing on / and lets the landing and its assets through | R | Landing/gate boundary: GET/HEAD/root marketing links and landing assets pass, prefix impostor/app pages redirect, server-action writes deny; catches route-prefix bypass. |
| L59 — answers 401 to the polling route and to a server action, with no data | R | Unauthorized transport: poll and server action produce 401/no-store/only unauthorized JSON; catches data leaking through write path. |
| L70 — lets the login page, the login and logout routes and the webhooks (signed, not signed in) through | R | Entry-route contract: login/logout and signature-guarded webhooks pass anonymous proxy; catches dead authentication or webhook setup. |
| L78 — refuses an expired, forged or old-password session | R | Session security: signed expired, forged HMAC, password-rotated and malformed cookies all fail 401; catches invalid cookie admission. |
| L88 — passes pages, the polling route and server actions, and skips the login page | R | Authenticated proxy: pages/poll/action pass and login redirects home; catches refusing legitimate sessions. |
| L103 — a production server with no password serves nothing and names the variable | R | Deployment fail closed: missing/blank production password gives page/data/login 503 naming required variable; catches publicly accessible unset gate. |
| L115 — the off switch opens the dashboard in development only | R | Environment security: off grants development access and returns production 503; catches opt-out reaching production. |
| L125 — the right password sets a signed HttpOnly, Secure, SameSite=Lax cookie the proxy accepts | R | Login-cookie interoperability: independently checked HttpOnly/Secure/SameSite/Path cookie passes proxy then fails after rotation; catches cookie/signature lifecycle regression. |
| L138 — a wrong password is rejected without a cookie | R | Failed authentication: wrong password redirects with wrong error and sets no cookie; catches accidental session issuance. |
| L145 — after five wrong passwords, the address is refused even the right one until the window ends | R | Rate-limit boundary: sixth login blocked even correct password, distinct address succeeds and injected window expiry reopens; catches ineffective brute-force limit. |
| L157 — a form posted from another site is refused | R | Origin security: foreign form returns 403 with no session cookie; catches cross-site login. |
| L163 — returns only to a local path | R | Open-redirect security: explicit scheme-relative/backslash/tab/dot-segment/foreign/login examples collapse to / while local query survives; catches unsafe next normalization. |
| L178 — logout clears the cookie, from this site only | R | Logout transport: same-origin POST clears Max-Age cookie, foreign origin rejects; catches cross-site logout or lingering session. |

#### [`packages/dashboard/test/cli-api.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/cli-api.test.ts)

History: `5a3a7f9 feat(cli): launch tickets when all blockers close (#226)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L100 — the person approves the code on /device and the terminal gets a session; whoami names them; logout revokes it | R | Device authentication boundary: real Better Auth pending/slowdown/approval/single use yields token without cookie; whoami identifies scoped owner and logout makes token 401; catches broken device lifecycle. |
| L146 — a denied code signs nothing in; no credential, or a made-up one, is told to run armada login | R | Device ownership security: other person cannot approve bound code, deny prevents sign-in, absent/made-up tokens 401 with login guidance; catches device theft. |
| L163 — an owner creates a key for the organization; it signs a terminal in; revoked, it is refused | R | Organization API-key security: member cannot create, repeated valid use succeeds, terminal logout refuses and Auth revocation makes next call 401; catches key lifecycle bypass. |
| L196 — every CLI route refuses with the next step; both gates let the CLI's routes through to say so | R | CLI protocol/gate boundary: no accounts returns 503 setup instructions/version headers; password/accounts proxies pass CLI routes without session lookup; catches CLI trapped behind browser gate. |
| L223 — a CLI older than the minimum is refused before anything runs, with the upgrade line | R | Version admission: outdated device request returns precise 426 upgrade and unchanged deviceCode count, minimum version succeeds; catches side effects before upgrade guard. |
| L291 — without a vault, or without a sign-in, nothing is handed out and the next step is named | R | Credential fail closed: vault off/invalid and anonymous deny, old unversioned retired request upgrades, empty vault returns explicit no-key schema; catches silent key fallback/leak. |
| L323 — the Linear key is the person's own when set, else the organization's; an API key gets the organization's | R | Broker scoped selection through authenticated route: member personal/org/owner/API-key selection and deletion fallback are independently asserted; catches cross-person key release. |
| L340 — every call is in the audit list, who and which key, and no value is ever logged or recorded | R | Secret audit boundary: actual audit rows identify member/API key and logs/events exclude both synthetic values; catches credentials entering observability. |
| L355 — a lost credential response retries the reusable key read, auditing both attempts and respecting the limit | R | Client/server retry contract: intentionally lost first completed credential response audits two real releases, reaches 429 without retry bypass and resumes after clock advance; catches unsafe retry classification. |
| L389 — the dashboard reads with the organization's Linear and GitHub keys, never a person's own | R | Server credential selection: organizationKeys returns only organization Linear/GitHub despite stored personal key; catches impersonated dashboard reads. |
| L397 — only the first organization, and the shared-password gate, fall back to the deployment's keys | R | Environment isolation: first/password scopes inherit env, secondary organization receives no env keys/repositories and own key still wins; catches tenant leakage. |
| L409 — a terminal asking more than 30 times a minute is refused until the minute has passed | R | Broker throttle storage: 30 authenticated releases succeed, 31st 429, other actor succeeds and later minute resets; catches missing per-actor release limit. |
| L422 — deferred launches use stored facts and distinguish authenticated API keys with the same name | R | Deferred ownership/API identity: no snapshot refuses; stored blocker enables request, response stamps stable key id and same-name second API key sees owned false; catches display-name authorization. |

#### [`packages/dashboard/test/cli-fleet.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/cli-fleet.test.ts)

History: `fceaf43 feat(secrets): mask worker output and messages (#239)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L120 — a coordinator and scoped worker attach to cached tickets; cross-project and cross-ticket calls fail | R | Authenticated attachment transport: cached coordinator/worker uploads dedup, foreign ticket/project/org refuse and real type/size admission returns intended statuses; catches route scope bypass. |
| L198 — a scoped worker attaches a fresh ticket once checked in Linear, and subsequent uploads use the snapshot | R | Cache-miss persistence: production attach receives scoped Linear lookup then persists fresh issue/completion time and reuses cache on second upload; catches lost cache write or wrong key scope. |
| L229 — concurrent fresh-ticket uploads preserve both cache additions and existing snapshot metadata | R | Concurrent snapshot storage: both added issues survive with exact unchanged prior config/forge/timestamps and +2 revision; catches read-modify-write lost updates. |
| L248 — a foreign ticket keeps the existing refusal and is neither cached nor stored | R | Foreign-ticket denial: null membership lookup leads exact 403 and no attachments or cached issue; catches persisting unverified upstream ticket. |
| L268 — a Linear error is retryable, reveals no upstream details and stores nothing | R | Upstream-error transport: thrown lookup yields sanitized 503, one attempt and no stored attachment; catches upstream error disclosure/unsafe retry. |
| L283 — cached tickets and scope refusals do not call Linear | R | Scope-before-network architecture: cached success and foreign ticket/org/config requests all make zero Linear calls; catches unauthorized upstream reads. |
| L350 — a worker with a launch token and a signed-in coordinator run a ticket from claim to merge; no database key anywhere | R | End-to-end fleet protocol: actual client/HTTP/Auth/PGlite claim-plan-answer-question-validation-handback-lease-merge roundtrip checks rows, times and profile cleanup; catches interface drift omitted by fake store. |
| L429 — a worker session acts on its own ticket and project only | R | Worker authorization: foreign ticket/project, inbox/lease/projects all 403; releasing worker makes next claim 401; catches worker privilege escalation. |
| L450 — signed out, or for another organization's project, nothing is read or written | R | Organization isolation: invalid API key 401, foreign project 403, own project listing and legacy first-org adoption are concrete; malformed project 400; catches registry takeover. |
| L482 — an unchanged inbox is answered 304 Not Modified, with no body; a change is answered in full | R | Inbox HTTP/ETag lifecycle: exact 304 empty/no-store, silence insertion, clock-only silence 304, new question full body and last-worker departure invalidate; catches watch missing event. |
| L509 — a coordinator binds one launch session, keeps it through sign-in and refuses a different or ended binding | R | Launch binding storage/provenance: idempotent same binding, conflict/different runtime/org/ticket/worker deny; mismatch stays audited and fast exchange-before-bind fills runtime; ended binding 409. |
| L571 — a launch no claim followed is in flight, then not started, told apart by its token's use; its claim or its end clears it | R | Pending-launch lifecycle: unclaimed and used-token launches inFlight then show distinct not-started reasons, actual claim/end remove pending entries; catches ghost launches. |
| L616 — launch revoke ends only the newest pending launch with the Workers-page audit, and refuses claims | R | Revocation generation: newest pending only ends, older token still exchanges, claim prevents revoke and worker/org permissions refuse; catches revoking replacement/active worker. |
| L668 — failed-launch cleanup ends its own unused token even after a newer launch claims | R | Exact-token cleanup: failed older unused launch revokes after new launch claims, newer session survives; wrong org/ticket/id/worker deny; catches failed-launch cleanup killing replacement. |
| L701 — an unused token expires after its grace hour, shows once even with the old ETag, then clears; exchanged launches age out at 24 h | R | Expiry transaction/ETag: concurrent old-tag inbox reads emit exactly one expired notice without foreign launch effects, clear on next read, exchanged pending ages out at 24h; catches duplicate alarms. |
| L737 — the masked token of the brief's human view is named as such, not as an invalid token | R | Launch guidance public bytes: masked brief token yields exact 400/error/next prompt instructions; catches confusing masked token for expired launch. |
| L752 — the inbox reconciles the stored snapshot before checking its ETag, without external reads | R | Snapshot reconciliation-before-ETag: persisted merged PR clears only matching handback/inFlight, preserves runtime/unrelated handback and stamps resolution; catches stale watch wakeups. |
| L830 — two coordinators taking the merge lock at once: one gets it, the other waits for it | R | Authenticated lease transport: two different credentials race and exactly one wins, loser cannot renew, release permits successor, overlong TTL 400 and logs omit key; SQL suite owns lease expiry detail. |
| L851 — digest reads and sends use organization scope and keep the channel address server-side | R | Digest authenticated boundary: French read/send, worker/foreign project refusal, real persisted private channel sends JSON and response excludes URL; catches leaked channel or scope mismatch. |
| L902 — older callers' prose and captions are masked with scoped vault values before persistence | R | Pre-persistence redaction: real worker report/ask/validation and attachment caption use scoped vault masker, event/validation data excludes secrets; unavailable vault returns sanitized 503; catches old CLI raw writes. |

#### [`packages/dashboard/test/cli-version.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/cli-version.test.ts)

History: `61d5b8d fix(api): announce CLI releases only after npm serves their tarballs (#113)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L44 — stays quiet cold, caches tarball checks for five minutes, then agrees with the brief | R | Publication/cache contract: independent tarball 404/200 fake drives previous then build version, refreshes at exact five-minute edge and respects verified brief agreement; catches premature release advertisement. |
| L67 — an outage stays quiet cold and retains the verified version when warm, with failure caching | R | Outage cache behavior: cold baseline stays quiet, warm verified previous retained, repeated failed refresh makes no requests inside period; catches downgrade/error flood. |
| L83 — a hanging refresh never delays a CLI response and concurrent refreshes share one request | R | Response latency/singleflight: hanging npm Promise causes zero pre-response fetches, after task shares one request and CLI still responds during hang; catches blocking CLI on registry. |
| L122 — refusals and upgrade instructions use the same verified header | R | Upgrade protocol: verified previous header matches precise npm install command in 426 body; catches header/body mismatch. |

#### [`packages/dashboard/test/coordinators.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/coordinators.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L28 — migration preserves legacy presence under default and leaves old claims unowned | R | Migration/storage contract: pre-named-role schema with legacy presence/claim migrates to default coordinator/session while old claim stays unowned and legacy presence readable; catches ownership invention. |
| L70 — presence retains different named roles and multiple sessions in one role | R | Presence SQL: default/front role order, two session handles and preserved default legacy row; catches named coordinator overwrite. |
| L93 — authenticated launches own claims; guarded handover preserves phase and survives a stale resume | R | Launch ownership/concurrency: authenticated launch defeats spoofed claim, rejected multi-ticket transfer changes nothing, parallel destinations yield one winner and stale resume preserves new owner/phase; catches split ownership. |
| L173 — first claim reads the pending handover owner after acquiring the project lock | F | Retain read-committed ownership contract, repair exact SQL adjacency assertions: current test proves post-handover owner and separate lock statement but additionally demands write=lock+1 and immediate BEGIN/COMMIT. Allow unrelated safe statements while requiring lock precedes owner/write; strongest eventual proof uses controlled concurrent handover on real Postgres. Candidate details in layer plan. |

#### [`packages/dashboard/test/dashboard-facts.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/dashboard-facts.test.ts)

History: `01afa00 feat(dashboard): a clear overview and a live fleet that scrolls back 24 h (#98)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L17 — coordinator activity and inbox reads have separate clocks, reset after silence and retain seven days | F | Retain distinct coordinator activity/inbox clock and reset assertions. Claimed seven-day retention is not exercised: final inboxReads at 25h+3m only tests its 25-hour SELECT window, and no inboxRead write is performed seven days later to run DELETE. Add persisted old/new inbox rows and a day-seven inbox write, then assert retained/deleted rows directly; candidate details in layer plan. |
| L50 — each session retains its launch facts and last report after release and replacement | R | Session history storage: real recordClaim/report/resume/release/replacement retains first launch model/profile/report and creates clean second session; catches historical facts overwritten. |
| L112 — steering requests deduplicate atomically per target, stay scoped and resolve without approving plans | R | Request uniqueness/security: parallel plan changes produce one item, relay resolves changes without approving plan, wrong scope/empty/open-PR rules deny and verified actor overrides spoofed author; catches dedup or authority drift. |

#### [`packages/dashboard/test/deploy-store.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/deploy-store.test.ts)

History: `4fb1977 feat(deploy): check merged deploys and pause on failure (#237)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L31 — persists first observation, caps output, coalesces the pause notice, and keeps terminal retries immutable | R | Deploy persistence: exact first record/4096-byte cap, retry identity, one hold/notice and scoped history; catches terminal rewrites or retry notice duplication. |
| L49 — pause false still notifies, and healthy clears only an explicitly covered failure | F | Retain pause-false and explicit coverage behavior, strengthen notification assertions: after non-pausing failure/healthy-without-coverage it checks only absence of holds, never that failure notice still waits. Assert exact no-pause notice before coverage and its resolution after covered b. Remaining stable target holds proof is line 81; candidate details in plan. |
| L81 — a healthy observation with a newer sequence but no coverage does not suppress a failure | R | Deploy recovery contract: waiting failure plus newer unrelated healthy row still opens hold when terminal failure arrives; catches using sequence instead of explicit ancestry coverage. |
| L105 — a repeated healthy row may add ancestry coverage and recover a previously unseen failure | R | Ancestry-enrichment persistence: repeated terminal healthy row adds failed SHA and clears outstanding hold; catches immutable healthy retries losing newly discovered ancestry. |
| L140 — failure and its hold/inbox item roll back together | R | SQL transaction rollback: CHECK rejects deploy inbox insert and assertions require deploys/holds/inbox all empty; catches partial durable failure writes. |

#### [`packages/dashboard/test/fleet-data.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fleet-data.test.ts)

History: `df8f084 feat(fleet): check Conductor sessions before silence alarms (#213)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L136 — the overview poll includes dashboard facts from Postgres and its ETag tracks those facts | R | Overview read/HTTP composition: Postgres owner/profile/coordinator/PR facts serialize, clock-only poll 304, new request invalidates without upstream calls and timeline omitted; catches missing projection/tag input. |
| L266 — a report recorded after the Linear read shows on the next poll without reading Linear again | R | Snapshot/live precedence: late shipping-stage report supersedes Linear label on poll and fresh server reads persisted stage without upstream call; catches stale phase precedence. |
| L301 — each row's timeline draws Armada's events of the last hours from Postgres | R | Timeline read contract remains needed for core flowStep: exact report span excludes 26-hour history and keeps phase transitions; catches poll history truncation affecting row steps. |
| L321 — with the database unreachable the view falls back to Linear and GitHub and says so | R | Outage resilience: warm DB failure serves stored rows with unreachable/unknown state; fresh fallback registry shows configured repo/inFlight; catches empty dashboard during storage outage. |
| L344 — a stale reading is served while it refreshes; a failed refresh keeps it, warns and waits a period | R | Refresh backoff: stale snapshot survives thrown upstream 503, visible warning recorded and repeat within period avoids another attempt; catches destroying last good data or hot retries. |
| L376 — no page or poll ever waits for Linear or GitHub, cold, stale or marked by a webhook | R | Architecture boundary: real PGlite with never-resolving upstream and forbidden fetch still answers every load path cold/stale/marked; catches pages waiting on Linear/GitHub. |
| L416 — one refresh per project at a time across servers; the others serve the reading they have | R | Distributed refresh lease: two cache instances concurrently view same Postgres project, held gate produces one source read and persistent result visible to second; catches refresh stampede. |
| L443 — a stale reading is brought up to date with Linear's changes and the pull requests, and read whole every 30 minutes | R | Refresh cadence: first full read, 61-second incremental request with independent touched/forge/since values, then 30-minute full read and no second incremental; catches stale read scheduling. |
| L468 — merges the ticket's Linear comments with its events and inbox, for its organization only, with an ETag | R | Agent activity composition: real SQL event/inbox and distinct Linear comments merge in independent expected order, wrong org/project denied and answerJson 304; catches cross-ticket history leaks. |
| L551 — the scope's projects only, each project's own numbers, records kept a minute, tagged for 304 | R | Insights composition/cache: persisted claim/merge yields independent 2h p50 and per-project count, inaccessible projects deny, one-minute cache then fresh count and 304; catches stale/filter cache mismatch. |
| L592 — every ticket of the last reading but those done over 30 days ago, the pull requests and the captions, for the organization only | R | Search persistence/scope: age-bounded ticket ids, branch/PR and attachment caption are independently checked, foreign organization empty and stable index 304; catches search leaking private history. |
| L674 — the activity of the scope's projects only, a page at a time, with each ticket's title | R | Activity adapter contract: limited pages contain expected merge/report then claim, title join and next exhaustion are asserted, foreign scope empty; catches cursor/title composition loss. |
| L700 — what happened since a visit, with each project's silence threshold | R | Catchup adapter contract: stored claims/merge and old held session produce exact project-qualified summary/silence minutes, foreign scope quiet; catches per-project threshold or scope loss. |
| L733 — each organization sees only its projects; projects registered without one go to the first organization | R | Organization registry adoption: unassigned projects hidden without home, adopted once by home and foreign launch requests fail while permitted succeeds; fallback repos hidden from second org; catches tenant takeover. |
| L761 — shows none of that project's live data to the other organization | R | Config mismatch security: impostor organization config names widgets yet gets none of widgets question/live data, home retains it; catches config slug as unchecked scope. |
| L788 — approving a waiting plan creates a signed answer request, not a worker or runtime action | R | Dashboard answer request: owner approval is stored with signed author and remains waiting for coordinator processing; catches directly approving plan or failing projection of queued answer. |
| L816 — a launch is checked against the frontier shown and the claims recorded since; an answer against the open question | R | Live-vs-frontier admission: independent ready/routing outputs, duplicate/recent claim blocks launch, legitimate requests and answer project correctly with one upstream read; catches stale frontier acceptance. |
| L870 — without the database nothing is recorded, and the reason is given | R | Unavailable storage admission: actual no-db load yields live-down instead of accepting launch request; catches falsely reported queued work. |
| L883 — shows on the owner's overview with its screenshots; the decision acts on that project and organization only | R | Validation UI-data boundary: actual gallery/title/PR composition, scope/empty/stale-decision errors, recorded decision/inbox and superseded open validation; catches approval losing owner evidence. |
| L972 — archived sessions remain ended after the dashboard's seven-day live window and a snapshot refresh | R | Archive lifecycle beyond window: persisted stop, 8-day advance and snapshot refresh still exclude ended ticket from overview and project inFlight; catches stale Linear label resurrection. |

#### [`packages/dashboard/test/fleet-store.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fleet-store.test.ts)

History: `a5823d8 feat(cli): scope named coordinators to their own work (#243)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L53 — a project is registered once per slug; an update keeps its creation time; an organization is given once | R | Registry SQL: update retains original createdAt and exact one-time organization adoption across different org callers; catches overwriting ownership. |
| L74 — a stale release leaves the replacement claim, profile, plans and questions untouched | R | Release generation storage: stale claim-time/session-id/handle leaves profile/inbox/event clocks untouched; current release resolves/retries and missing optional claim paths differ; catches stale worker killing replacement. |
| L175 — shipping detail persists on events and session reports, and a later phase clears it | R | Shipping detail storage: report events and retained session share review/ci stages then implementing clears stage in both; catches stale shipping badge. |
| L208 — heartbeats atomically target the current claim, never change reports, and stop on release or replacement | R | Heartbeat SQL: current exact claim updates heartbeat/session only, phase/report clock unchanged, foreign/stale/replaced/released generations deny; catches phase rewriting or replacement liveness. |
| L261 — the newest event of each ticket since a time, the coordinator's newest inbox read, the open sessions | R | Scoped newest reads: ticket/time filters, late coordinator update monotonicity, resumed claim original time/profile, release cleanup/new generation are explicit; catches wrong latest row/scope. |
| L345 — relayed validation decisions renew the bounded answer clock | R | Answer clock SQL: unrelayed decision gives no clock, resolution records exact time, foreign project/ticket/window excludes; catches premature heartbeat grace. |
| L363 — one open answer per question, even from two requests at once; none to a closed question | R | Request uniqueness SQL: concurrent two answers return one id, closed question denies, empty ticket filter denies and repeated launch inserts once; catches partial-index mismatch. |
| L391 — one open plan and one hand-back per ticket; resolving the plan resolves the answers waiting on it | R | Inbox upsert/lifecycle: second plan/handback content replaces one open row, resolving plan also clears waiting answer and leaves handback; catches duplicate open work. |
| L412 — one holder at a time, even when two ask at once; ours renews; an expired one is taken | R | Lease SQL lifecycle: competing holders one winner, renew preserves acquiredAt, boundary expiry allows loser, stale renewal/release ineffective; catches transactional lease race. |
| L439 — long jobs persist across store instances, are project scoped and never revive after stopping | R | Jobs storage: cross-instance persisted progress/ref/eta, stale/foreign update rejection, terminal state never revives; shownJobs prioritizes open and limits ended by ticket/time; catches durable job lifecycle loss. |
| L553 — a deferred request survives storage, shares launch uniqueness and is resolved by the worker claim | R | Deferred SQL: deferred flag/profile survive, immediate duplicate denied by same uniqueness, production recordClaim clears queued launch; catches deferred/immediate double-launch. |
| L595 — merge holds deduplicate automatic pauses and atomically open and resolve their inbox items | R | Hold transaction: automatic dedup/manual multiplicity, scoped/idempotent clear resolves linked inbox, reopened distinct hold, forced inbox rejection rolls back hold; catches orphan merge pause. |
| L653 — merge queue preserves intent, deduplicates concurrent adds and fences dequeue and finish with the lease | R | Queue transaction/fencing: concurrent add preserves intent, lease needed for dequeue/finish, successor resumes old entry, retry schedule/scoped refusal and removal verified; catches double merges or lost intent. |
| L759 — events/since uses the project, kinds and tickets, pages ties and reads late commits once | R | Indexed event cursor: ties paginate separate ids, late timestamp commit returned exactly once, kind/ticket/project/exclusions filter; catches follow missing or replaying reports. |
| L795 — events/since selects handover reports before pagination | R | Pagination filter: earlier implementing report excluded before limit=1 so ready-to-merge returned; catches post-page handover filtering. |
| L810 — declared paths replace the old plan, stay scoped to a project and are cleared on release and merge | R | Ticket-path storage: replacement plan retained per project, release removes only one project and merge clears other through production recordMerge; catches stale overlap warnings. |
| L846 — a higher reserved version does not hide a later merge-hold migration | R | Migration gap contract: fabricated higher applied version does not skip missing lower merge-hold migration and repeat safe; catches MAX(version)-based upgrade skipping. |

#### [`packages/dashboard/test/github-app.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/github-app.test.ts)

History: `391f058 feat(dashboard): link the GitHub App to the organization in one click (#57)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L106 — off with neither variable; invalid with a bad id or key, without quoting the key; on with a key pasted on one line | R | GitHub app config security: numeric id/key parsing accepts escaped PEM, missing/bad values refuse without quoting key; catches unusable or disclosed app credential. |
| L116 — the app's token is an RS256 JSON Web Token GitHub can check with the app's public key | R | JWT protocol: independent RSA verification and decoded iat/exp/iss assert GitHub signature/clock-drift contract; catches algorithm/key/expiry mismatch. |
| L133 — the installation's token reads the pull requests with their check runs; no GitHub token is set | R | Fake-network token lifecycle: real app client plus forge GraphQL produce CI checks, same-installation caching and parallel renewal mint once near expiry; catches wrong bearer or stampede. |
| L157 — an organization reads only through the installations linked to it; without one, a stored token, else the reason | R | Installation authorization: explicit allowed/foreign/missing/stored-token outcomes and sanitized upstream status reason; catches foreign-org app token release. |
| L195 — an installation is linked only when GitHub shows it to the person; unlinking touches only that organization | R | Link SQL/security: reachable network list prerequisite, repeated link idempotent and unlink touches only own organization; catches guessed installation id or cross-org removal. |

#### [`packages/dashboard/test/github-install.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/github-install.test.ts)

History: `391f058 feat(dashboard): link the GitHub App to the organization in one click (#57)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L69 — the button opens GitHub's install page with a signed state naming the organization, the person and the nonce | R | Decodes the signed state to organization/user/browser nonce and checks the exact encoded GitHub installation URL; detects loss of callback binding or malformed install navigation. |
| L77 — a genuine state links the installation with no other click, once in the audit list; coming back again keeps the link | R | Successful setup return persists installation11 and linker/time, and a second return leaves one installation and one link audit event; catches duplicate linking/audit side effects. |
| L91 — a forged, altered, expired, replayed or someone else's state links nothing | R | Wrong signing key, changed expiry/signature, expired state, missing or wrong browser nonce, wrong person/organization and downgraded member are denied with no org-b links; protects callback authorization at the state-consuming boundary. |
| L116 — an installation GitHub does not show the person is never linked, by the button or the Link button | R | Both setup and manual linking refuse unreachable installation99; absent/bad GitHub token and member role persist neither links nor audit entries, preventing cross-installation access. |

#### [`packages/dashboard/test/insights-store.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/insights-store.test.ts)

History: `9ff52cb feat(dashboard): show how fast the fleet ships and where tickets wait on /insights (#115)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L144 — reads every event of a ticket active since \`since\`, and only the heartbeats that end a gap or come last | R | PGlite event projection keeps complete pre-range history for active/open tickets, only heartbeat endpoints of real gaps, final-event flags and phase/headSha; excludes inactive/foreign project events, catching misleading cycle/silence statistics. |
| L160 — reads the sessions, the coordinator's waits and the owner's validations of the range and those still open, for the project only | R | Exact SQL session/profile/release, open old waits and recent resolved waits/validations are asserted separately for widgets and gadgets; catches lost still-open work or cross-project metrics. |

#### [`packages/dashboard/test/live-http.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/live-http.test.ts)

History: `f46eea4 feat(dashboard): keep the dashboard fast with budgets checked on every PR (#119)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L11 — answers 304 while nothing but the clock changed, and the overview again once something did | R | Real response status/body/ETag assertions distinguish clock-only304 from changed live-error200 and require no-store; catches polling churn and stale errors. |
| L29 — a 304 stays a 304, with the time on the server in a header and one log line | R | Injected10→22.25 timing clock yields app;dur=12.3 and one12ms log while retaining304; detects timing wrapper breaking conditional responses. |

#### [`packages/dashboard/test/migrations.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/migrations.test.ts)

History: `b7569bd fix(dashboard): drop unused saved views table (#190)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L6 — migrations remove retired views from %s and preserve accounts | R | All three parameter rows actually migrate empty/pre21/pre21-with-table-removed PGlite databases; catalog checks prove table/index/sequence retirement, users/orgs survive and a second migration preserves recorded timestamps. Independent persisted schema/data proof, not a source-text comparison. |

#### [`packages/dashboard/test/owner-push.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/owner-push.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L148 — current blocks precede the window and repeated reports preserve their duration; records carry running phases and snapshot titles | R | SQL digest records preserve a pre-window block start despite repeated reports,90-minute duration and snapshot title, then report recovered ongoing=false; catches window clipping or resetting blocked age. |
| L190 — manual project digests never advance another project's window or the organization schedule | R | Manual widgets digest leaves gadgets start/window/merge intact and later organization schedule includes GAD-2; prevents one project consuming another project’s digest activity. |
| L213 — a skipped quiet digest retains missed-slot notices for the next visible digest | R | No quiet skipped digest POST, then visible French digest carries missed09:00 slot notice; catches missed-slot acknowledgements being consumed before the owner sees them. |
| L224 — the optional cron discovers digest-only channels while production remains unconfigured | R | Authenticated ownerCron over a saved digest-only channel returns200 and makes one POST with alerts=false; catches cron discovery incorrectly requiring alerts. Assertions cover injected cron execution, not deployed scheduler configuration. |
| L239 — concurrent scheduled ticks send one channel digest, with missed-slot notes and the previous digest window | R | Concurrent SQL ticks create one durable civil-slot key and one localized title/approval-link POST; next-day ticks include missed-slot/previous-window text and advance digestRecords.since without leaking URL, catching duplicated or overlapping scheduled summaries. |
| L260 — quiet digests send one line, or retain the slot without sending when skipped; project filters and retries still apply | R | Exact quiet-summary text, persisted quiet-digest error without an extra POST, and failed delivery retried once under concurrent ticks exercise quiet slot persistence and retry path; detects lost or repeated scheduled digests. |
| L285 — concurrent instances send one POST per durable item; marked snapshots stay untouched; payloads contain titles and links only | R | Concurrent ticks send exactly two durable items once, correctly HMAC-sign each actual body, omit worker free text, include approval links and leave dirty snapshots untouched; protects idempotence, payload secrecy and no tracker reads during delivery. |
| L304 — long batches reserve each attempt against the live injected clock | R | Twenty-item batch advances only injected time during POSTs and checks each persisted claim expiry lies after the current clock; catches lease expiry calculated once at batch start. |
| L325 — a stopped coordinator with waiting items alerts once until it returns and stops again | R | Stale coordinator plus waiting inbox sends one alert across repeated ticks; refreshed presence suppresses it and later stale generation sends another, catching permanent suppression or noisy repeats. |
| L355 — quiet-hour arrivals are stored for the next digest in the channel timezone, never posted later as alerts | R | Auckland quiet-hour item persists sent_at/error=quiet/attempts0 and makes no POST either during or after quiet hours; detects delayed replay of suppressed immediate alerts. |
| L369 — retries are claimed once per minute, stop at five attempts, and ten consecutive failures pause the channel | R | Two items plus concurrent minute ticks produce ten POSTs, two persisted attempts5 and channel failures10/pausedReason=failures with no later send; catches duplicate claims, unlimited retries and missing pause policy. |
| L387 — 404 and 410 pause immediately; saving resumes; success clears consecutive failures; provider text is never kept | R | 404/410 immediately pause, settings save resumes while reusing sealed credentials, thrown provider error becomes unavailable without URL, and later success resets failure count; prevents secret/provider leakage and permanently paused channels. |
| L407 — organization/project filters and scoped pulse leases isolate delivery | R | Foreign organization tick/pulse sends nothing, concurrent rightful pulse sends once with one project-scoped lease, and unknown project setting is rejected; catches cross-tenant delivery or unscoped scheduling. |
| L424 — webhook credentials cannot be listed/released through the keys/worker broker | R | Saved owner-webhook disappears from every normal key/worker broker listing and release, direct project-key read refuses server-only, ciphertext omits URL/signing secret and channel removal removes credentials; catches credential exfiltration through generic secret APIs. |
| L448 — cron checks its bearer before opening accounts; password deployments are off | R | Missing bearer returns401 before accounts opens; valid bearer with no accounts returns enabled=false; configured channel reaches real SQL delivery and one POST; catches unauthenticated scheduler database work. |
| L480 — civil digest slots handle weekdays, offsets and both DST transitions without duplicate local keys | R | Hard-coded Paris spring gap yields zero slots/autumn overlap yields one first occurrence, Kathmandu fractional offset yields09:00 civil key and Sunday yields none; catches Intl/DST/weekday scheduling mistakes at cheapest pure boundary. |
| L497 — webhooks refuse private addresses, local hosts, userinfo, redirects and HTTP | F | URL/address rejection matrix is useful, but no redirect response or transport is invoked: removing post’s redirect:error (or following in safeWebhookFetch) leaves this “redirects” case green. Keep predicate assertions and add transport-level redirect refusal with injected DNS/HTTPS at existing owner; candidate O1 in layer plan. |

#### [`packages/dashboard/test/reservations.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/reservations.test.ts)

History: `e63072e feat(cli): reserve shared names and numbers for a ticket (#216)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L20 — simultaneous next allocations serialize an empty key; releases free values while merges keep them used | R | Concurrent real SQL empty-key next allocation produces23/24, merge permanently blocks23 and release makes24 reusable with correct persisted flags; catches allocation races and accidental reuse of applied migrations. |
| L60 — exclusive keys and names name the holder, stay scoped to their project and only the holder can free them | R | Real conflicting named reservations identify holder, permit same name in another project and deny wrong holder release; stale runtime release preserves reservation, catching cross-project/ownership cleanup errors. |
| L98 — number allocation counts explicit integer formats, ignores names and keeps large integers precise | R | Explicit leading-zero/signed numbers and names lead to25, while integer above JS-safe range increments exactly to9007199254740994; guards SQL numeric parsing/precision independently of core fake logic. |
| L109 — release frees and merge retains reservations even when the optional live claim write was missing | R | With no optional live claim, real release still frees reservations and merge keeps used value with endedAt; catches leaked or accidentally reusable shared resources when live writes were missing. |
| L139 — a claim arriving after an absent merge snapshot keeps its runtime, profile and reservations | R | Injected interleaving adds real newer runtime/profile/paths/reservation after merge event; final open generation and all new resources remain unmerged, catching absent-snapshot cleanup races. Wrapper schedules SQL writes, not the asserted owner implementation. |
| L200 — a replacement after merge release keeps its newly declared paths and reservations | R | Replacement created after old merge release retains new session/paths/unmerged reservation while old reservation becomes permanent; catches cleanup racing a replacement after successful release. |

#### [`packages/dashboard/test/runtime-state.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/runtime-state.test.ts)

History: `df8f084 feat(fleet): check Conductor sessions before silence alarms (#213)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — runtime readings and stop are scoped to an exact claim, preserve transitions, and reset on replacement | R | PGlite exact project/claim checks reject foreign/stale/out-of-order observations, preserve same transition age, accept sequence change, clear replacement state and fence stop against old generations; historical release times remain intact. |
| L67 — Conductor observations and archive records cross the fleet API on Postgres with exact generation checks | R | serveFleet+PGlite rejects bad state/future transition, persists failed/gone and post-release archive observation, fences stale replacement mutation, carries answered liveness, and idempotent stop leaves one release event time; protects API validation plus SQL generation storage. |

#### [`packages/dashboard/test/secrets.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/secrets.test.ts)

History: `d916cf3 feat: keep keys and secrets per project, fetched by workers with armada run (#72)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L121 — an owner sets and lists them, names and who and when only; a member or a worker session sets none | R | Actual Better Auth owner sets project/org secrets and member lists metadata only; member/worker mutation and reserved LINEAR_API_KEY are rejected with specific statuses, catching role/namespace failures in the CLI route. |
| L175 — each release names the project and the secrets in the audit list; another project's is refused and recorded | R | Worker receives only its project’s exact values/scopes and requested names/missing list; foreign project403 is audited as refusal with scoped release events, catching credential scope and audit omissions. |
| L202 — an unset secret is no longer released, a changed one is released changed, on the very next call | R | Rotate then unset through the CLI route, immediately release each time and assert changed value then only remaining secret; detects stale secret caches or ineffective deletion. |
| L215 — its creator an owner: it sets; demoted or gone, or unknown: refused | R | Real organization API key is denied until creator recorded, permits current admin set, and denies set/unset/release after demotion or membership deletion; catches stale creator-role authorization. |
| L247 — wins for that project over a person's own and the organization's; elsewhere they serve as before | R | CLI credential broker chooses project Linear key ahead of personal/org keys, unrelated project uses personal key, projects response advertises ownLinearKey and worker gets project key; protects transport/purpose propagation beyond vault SQL precedence. |
| L279 — no value is ever logged or recorded in the audit list | F | Case only reads global logs/events accumulated by earlier cases and asserts absent VALUES; filtered execution performs no secret mutation/release and can pass vacuously. Preserve secrecy contract by exercising a synthetic set/release/refusal within this case and asserting populated audit/log proof; candidate S1 in layer plan. Confirmed: filtered run passes with all five secret mutation/release cases excluded. |

#### [`packages/dashboard/test/vault.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/vault.test.ts)

History: `d916cf3 feat: keep keys and secrets per project, fetched by workers with armada run (#72)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L33 — 32 bytes in base64 or hex turn the vault on; nothing keeps it off; anything else is refused, named | R | Absent/blank/invalid config modes plus fixed same/different key IDs and equivalent base64url encoding check master-key configuration identity; catches accidental acceptance of invalid key material or encoding mismatch. |
| L47 — opens with the same master key on the same row only; a moved, altered or foreign value never opens | R | Actual AES-GCM roundtrip requires same key/organization/user/name/project; changed ciphertext and foreign keys fail SealError without plaintext, and fresh sealing differs; catches missing authenticated row binding or deterministic encryption. |
| L104 — are listed with who set them and when, never a secret's value; the audit list names keys, never values | R | Real SQL lists only safe owner metadata, excludes retired rows, enforces personal-key type and user scope, reads rightful precedence, reports unreadable foreign key, and deletion/audit/ciphertext exclude secrets; protects durable vault isolation and metadata. |
| L232 — a key stored before projects had their own still opens once the schema has them | R | Pre-migration7 schema plus legacy sealed row is migrated and decrypted unchanged, then new project row coexists without replacing org key; guards deployed ciphertext and schema backward compatibility. |
| L266 — the Linear key of a project: its own, then the person's own, then the organization's | R | Actual vault SQL resolves project>personal>org and refuses corrupt project ciphertext fallback, project GitHub tokens and per-project personal key; catches silent credential substitution on broken scoped keys. |
| L305 — secrets for workers: named in upper snake case, never a key Armada uses; a project's own wins over the organization's | R | Invalid/reserved names/personal worker scope are denied; exact values/scopes obey project override and requested-name isolation; tampered override does not fall back, metadata excludes values and project audit count is checked; catches namespace and encrypted-storage scope bugs. |

#### [`packages/dashboard/test/webhooks.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/webhooks.test.ts)

History: `11ee2fa feat(fleet): show when main is red and which merge broke it (#204)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L109 — a signed delivery about a ticket of the program marks its project; the refresh reads that ticket's changes only | R | Actual HMAC request marks only widgets and next refresh receives exact touched IDs and incremental cursor with forge=false; catches webhook-to-persisted-mark-to-source routing regression. |
| L130 — a comment names its ticket; a delivery about another program marks nothing | R | Comment issueId maps to widgets while unrelated issue/parent yields marked0 and no extra refresh; guards invalidation project targeting. |
| L145 — refuses a wrong signature, a replayed delivery, and answers 503 while its secret is not set | R | Wrong HMAC, stale timestamp and unset secret produce401/503 with no refresh callback; prevents unauthenticated/replayed invalidations. |
| L157 — a label renamed asks every project for a whole read on its next view, without reading now | F | Checks one background job and absence of readChanges, but readSnapshot calls/results are unobserved: a no-op job still passes the claimed whole reread. Keep deferred/mark checks and assert one full read plus changed persisted generation/content (and a second registered project for “every”); candidate W1 in layer plan. |
| L175 — a failed refresh keeps the marks, so the next one still reads what the webhook named | R | Real failed incremental refresh persists dirty/error, retry-period call does not reread and later success still receives same touched ID then clears dirty/error; protects durable marks during outages. |
| L198 — marks stay until a reading that saw them is written: a refresh cut short loses none, a mark during one is read next | R | Abandoned claim expires without losing touched ID; webhook during a claimed refresh leaves saved:true/dirty:true, catching premature acknowledgement of unseen marks. |
| L220 — a refresh that outlived its lease does not overwrite the newer reading of the one that took over | R | Fast replacement lease saves newer content, expired slow save/fail are ignored and version/error/lease/content stay newer; catches late functions overwriting or poisoning refreshed state. |
| L236 — a burst of deliveries makes one read; a reading both webhooks keep fresh is refreshed on view every 10 minutes, not every minute | R | Burst invalidations cause one incremental read while second mark persists; later views respect10-minute freshness only after both provider hooks, catching source traffic amplification or missed dirty refresh. |
| L269 — a pull request, check or push event marks the repository's project; the refresh reads GitHub only | R | Five actual GitHub event fixtures mark repository then coalesce into exact forge-only incremental request; catches missing accepted event or unnecessary Linear reads. |
| L282 — refuses a wrong signature; ignores the events that do not change the view | R | Bad GitHub HMAC401, ping ignored, foreign repository marked0 and no refresh callback protect admission/targeting without external network. |

#### [`packages/dashboard/test/workers.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/workers.test.ts)

History: `0dfebf3 feat(fleet): name coordinators and preserve launch ownership (#228)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L146 — a signed-in coordinator gets a token; the worker exchanges it once for a session on that ticket, with the launcher's keys | R | Real authenticated launch/exchange yields ticket/session metadata, single-use token refusal, worker identity and launch actor audit; broker chooses member’s personal key vs organization API-key launcher, detecting token reuse or identity/key provenance loss. |
| L204 — a token used after its hour is refused; one used within it works | R | Injected59/61-minute exchanges accept in-window token and reject expiry/unknown token with unused persisted state; protects one-hour credential validity without waits. |
| L219 — each command renews the worker session; one left unused past 72 hours has expired | R | Injected71-hour command renewals extend worker session twice then73-hour silence rejects it; catches failure to renew or enforce72-hour inactivity. |
| L235 — worker ownership comes from the launch row, never its fleet request | R | Named authenticated launch rejects invalid role name and spoofed coordinator request fields cannot change persisted worker ownership or session metadata; catches worker-controlled ownership escalation. |
| L279 — a heartbeat is project/ticket/session scoped, server timed, vault-free, and refuses replaced sessions | R | Actual scoped heartbeat claims return phase metadata, leave vault audit unchanged, ignore client future timestamp for persisted clock, forbid other ticket and reject old worker after replacement; protects liveness provenance and vault-free polling. |
| L316 — keys for another ticket, another project or a coordinator's command are refused; it launches and ends no worker | R | Worker key broker denies other ticket/project/coordinator commands, accepts normalized own-ticket worker commands and forbids launching/ending others; verifies constrained session capability boundary. |
| L349 — revoked from the dashboard: its next command is refused with who cut it off, and it gets no more keys | R | Foreign-org revoke does nothing; rightful revoke makes next key/session/heartbeat401 with cutter identity, and revocation before exchange also denies token; guards immediate durable revocation. |
| L388 — a coordinator release ends old launches but spares a newer replacement and its claim | R | Stale old worker and coordinator release cannot end replacement claim; malformed cutoff400, generation cutoff ends only old launch, replacement can report/release; catches lifecycle revocation races. |
| L447 — a release ends the worker's session; a merge ends every session of the ticket | R | Session delete ends released worker and ticket merge ends merged worker, both deny next heartbeat/keys and report correct persisted state; catches credentials surviving completed work. |
| L477 — exchanges are limited per address, and no token is ever logged or stored | F | Exercises same-IP quota/window and token absence, but positive log/token-count assertions depend on ABC-12 and >10 tokens from earlier tests; filtered case fails unrelated to safety and no other IP is checked while quota is exhausted. Give this case its own successful token/log and simultaneous second-IP exchange; candidate T1 in layer plan. Confirmed: filtered run fails at line492 missing ABC-12 log (0pass/1fail,10filtered). |
| L500 — without a vault no launch token is made; without accounts every route answers 503 with the next step | R | Authenticated launch with vault off returns503, bad ticket400, and accounts-off launch/exchange/end return503 actionable next; catches partially configured credential issuance. |

### dashboard-ui

#### [`packages/dashboard/test/activity-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/activity-view.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L32 — reads its chip and drops what it cannot use, older links' filters too | R | Literal valid/invalid and legacy URL inputs exercise readView, consumed by ActivityScreen; ignored filters cannot leak into current state. |
| L39 — writes only what is set, in one order, and reads back the same | R | Independent canonical query strings and round trips protect shareable links, including empty defaults; no router mock. |
| L51 — each chip reads its kinds: blocks are questions and blocked reports, for you plans and validations | R | Enumerated expected kinds for each public chip protect feed filtering beyond merely counting results. |
| L59 — keeps a time zone the server knows | R | Valid/invalid IANA names exercise viewer-zone validation; independent fallback expected. |
| L67 — says what happened, its kind and where it opens | R | Expected localized text, kind and links from feed events protect activity row presentation and destinations. |
| L108 — group the entries in the viewer's time zone | R | Fixed timestamps around midnight assert viewer-zone day groups; injected time avoids clock dependence. |
| L122 — split at the last visit, only when the page holds both sides | R | Both-sides and outside-page fixtures assert last-visit divider only within displayed history. |

#### [`packages/dashboard/test/announce.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/announce.test.ts)

History: `8466d22 feat(dashboard): build the Night watch look across the dashboard (#128)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L26 — says nothing when nothing that matters changed | R | Identical/irrelevant overview changes must produce no live-region message; public Announcer consumes the result. |
| L34 — names a new item waiting for the viewer | R | Added owner item yields its expected words and count, protecting actionable announcement. |
| L41 — names an agent's phase change | R | Changed worker phase yields expected announcement with agent identity. |
| L47 — names a merge: an agent ready to merge that left the fleet, not one that left from another phase | R | Ready-to-merge removal announces merge; other-phase removal does not, preventing false completion. |
| L55 — collapses a burst into counts, one sentence per kind | R | Independent expected sentences cover burst collapsing across items, phases and merges. |
| L64 — speaks the viewer's language | R | French fixture asserts localized speech, a distinct user contract from English content. |

#### [`packages/dashboard/test/clock-readings.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/clock-readings.test.ts)

History: `6414147 fix(dashboard): keep the overview still while its page streams in (#174)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L14 — \`reads no longer than LONGEST_TIMES (${lang}, ${format})\` | R | Loop exercises English/French clock formats against declared layout reserve LONGEST_TIMES; public clock text fits its reserved width. Source declaration generates cases, not duplicate declarations. |

#### [`packages/dashboard/test/contrast.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/contrast.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L77 — text reads at 4.5:1 on every surface and fill | R | CSS palette values are checked with independent WCAG luminance calculation against text contrast target across surfaces. |
| L81 — a state's text reads on its own 13% fill (a selected chip, an error) | R | Blended selected/error state fills get contrast checks that base-surface tests cannot substitute. |
| L94 — text on --raised (a selected tab) or a button's hover is --text or --text-2 | R | Controls CSS declaration scan restricts selected/hover text to readable foregrounds, covering actual control styling. |
| L102 — marks and the focus ring read at 3:1 on every surface | R | Non-text focus/mark contrast target independently protects perceivable navigation cues. |
| L112 — the text steps stay in order, brightest first | R | Palette luminance ordering preserves visual hierarchy independently of minimum contrast. |

#### [`packages/dashboard/test/coordinator-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/coordinator-view.test.ts)

History: `783cc8d feat(dashboard): show which coordinator owns each session (#241)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L76 — are the open validations of a session, oldest first; a decided one, another ticket's or project's are not | R | Oldest open validation selection excludes decided and other ticket/project fixtures; AgentScreen and preview consume it. |
| L94 — waits for the owner on an open validation, whatever else holds it, with the validation's words | R | Owner validation overrides other blockers and supplies validation wording, protecting action precedence. |
| L109 — waits for the owner on a plan to approve | R | Open plan produces owner decision state with distinct plan action. |
| L113 — is blocked on an unanswered question, red CI, a conflict, a blocked phase or a silence, in that order | R | Fixture matrix covers unanswered question, CI, conflict, phase and silence precedence, not only one state. |
| L130 — is ready to merge once handed back, with who approved its merge | R | Hand-back with recorded approver displays merge-ready state and identity. |
| L140 — runs otherwise, with the worker's last report | R | Working fallthrough retains last report instead of inventing a blocker. |
| L150 — follows its phase, then its flow step (review and CI are one step) | R | Phase and flowStep fixtures assert six-step mapping including review/CI collapsing. |
| L172 — add the tickets merged on the viewer's day, newest first, once | R | Injected viewer-day adds merged tickets once in newest-first order; unrelated days excluded. |
| L186 — group by state in its order, or by project with the most urgent first; empty groups are left out | R | Expected state/project grouping and urgency orders protect overview list hierarchy and omit empty groups. |
| L199 — count each project's sessions and the headline's figures | R | Expected per-project and headline figures derive from actual session fixtures, not implementation totals. |
| L212 — shows every state of the design, with the design's sessions in each | R | Design fixture exercises rendered-world session state groups through overviewItems, distinct from low-level state table. |
| L262 — ?owner= keeps one coordinator's sessions, beside the project filter | R | Owner and project filters compose and exclude other coordinators, preserving shareable filtered scope. |
| L279 — show only where a project names them; a project with only default looks as before | R | Default-only versus named coordinators controls owner visibility; tests both public representations. |
| L289 — the project's diamond is its most urgent coordinator that owns a session, else the one seen last | R | Urgency/ownership and seen-time fallback select sidebar coordinator diamond correctly. |
| L300 — reads the project, the grouping, the view and the selection, and ignores the rest | R | Literal query input matrix rejects obsolete parameters and reads current project/group/view/selection. |
| L313 — runtime failures and archived workspaces have distinct overview reasons | R | Failed and archived runtime fixtures yield different actionable reasons instead of generic working state. |
| L321 — stopped idle sessions are actionable even when their answered phase still says awaiting approval | R | Stopped idle runtime remains actionable despite answered awaiting-approval phase; regression boundary spans runtime and phase. |

#### [`packages/dashboard/test/demo-world.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/demo-world.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L51 — is the mockup's Acme world: three projects and eleven sessions in every state | R | Built demo status has expected projects, eleven sessions and state diversity; protects fixtures used by showcase and performance. |
| L76 — waits on a question, a plan and two hand-backs, and has one idle coordinator | R | Explicit question/plan/hand-back and idle coordinator fixtures keep demo capable of demonstrating actionable states. |
| L88 — keeps the mockup's project colors | R | Literal project color assignments keep stable design palette for showcase. |
| L92 — the large world has lists of hundreds of rows, and one ticket with hours of reports | R | Large scenario verifies hundreds of sessions and deep history used by performance scripts, not just base demo size. |
| L107 — ships each project's done tickets, the same ones its snapshot lists, the same every seed | R | Done ticket ids join snapshot and deterministic history, protecting seeded insight/overview consistency. |
| L116 — covers two weeks, more merged in the second, with re-plans, new heads, questions, validations and silences | R | History contains fourteen days and meaningful replan/new-head/question/validation/silence coverage, keeping synthetic data representative. |

#### [`packages/dashboard/test/fleet-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fleet-view.test.ts)

History: `df8f084 feat(fleet): check Conductor sessions before silence alarms (#213)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L38 — a decision comes first, then a failure, a silence, a hand-back, else the phase | R | Literal state precedence covers owner decision, failure, silence, hand-back and phase for sidebar/rows. |
| L57 — harnessOf reads every runtime label Armada writes | R | Every written runtime label maps to expected harness text, an external label contract. |
| L69 — a project keeps its color whatever other projects exist | C | Same-slug call equals itself and palette membership does not exercise other projects promised in name. Consolidate into demo-world.test.ts:88 literal color keeper; first carry unknown-slug deterministic fixture. projectColor is publicly used; do not remove helper. |
| L76 — an agent's page sits under the overview and its project, a project's under the overview | R | Literal breadcrumbs encode session/project navigation hierarchy. |
| L92 — the menu has the overview, Validations, Activity, Insights and the organization; agents and projects are the overview's | R | Expected menu order and destinations assert current owner navigation, including obsolete agents/projects exclusion. |
| L107 — Esc leads to where an agent was opened from, else to the overview, never out of the app | R | Internal/opened-from route matrix blocks external escape destination and gives overview fallback. |
| L119 — a coordinator's harness, from what it recorded | R | Recorded coordinator harness maps to displayed runtime independently of worker labels. |
| L127 — only a Conductor session opens in Conductor, by its workspace | R | Conductor-only workspace links prevent other runtimes opening in wrong application. |
| L135 — the link armada attach prints opens the attachment itself (THE-1021) | R | Literal attachment URL opens content rather than removed attachment page; public CLI link contract. |

#### [`packages/dashboard/test/insights-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/insights-view.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L36 — draws the merges of each of the last seven days, oldest first | R | Fixed seven-day values assert oldest-first merge bars, including missing-day zeroes; Insights page consumes these. |
| L48 — reads the time blocked from core's phases, and a rate as a whole percent | R | Literal blocked-time and percentage formatting assert display units from core numbers. |

#### [`packages/dashboard/test/jobs-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/jobs-view.test.ts)

History: `141e2d7 feat(dashboard): show a ticket's long jobs on its session page and the overview (#235)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L25 — a ticket's jobs show their progress, ETA, last news and overdue against the injected clock | R | Injected clock and open/ended/overdue job fixtures assert progress, ETA, last news and max_hours warning shown on session and preview; distinct presentation owner from store lifecycle. |

#### [`packages/dashboard/test/keyboard.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/keyboard.test.ts)

History: `f01dcb1 feat(dashboard): make every page usable with a keyboard and a screen reader (#118)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L12 — never leave a text field, a choice or an editable block | R | Input/select/contenteditable targets reject page shortcuts, protecting text editing. |
| L17 — never reach the page behind an open dialog (⌘K, a screenshot) | F | Dialog mock accepts any selector containing dialog; dropping [open] or role clause could still pass. Retain ownsKeys guard contract but use DOM-backed target/selector fixtures covering closed, open and role=dialog cases. |
| L21 — belong to the page anywhere else | R | Ordinary targets enable page shortcuts, establishing positive complement to exclusions. |
| L29 — the arrows move to the next and the previous, wrapping | R | Literal ArrowLeft/Right wrap boundaries exercise shared tab navigation independently. |
| L35 — Home and End go to the ends; any other key is the page's | R | Home/End, unhandled key and empty-count fixtures protect navigation endpoints and safe fallback. |

#### [`packages/dashboard/test/landing.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/landing.test.ts)

History: `975a8ae fix(dashboard): stop the landing's method section from hijacking the scroll (#192)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L23 — lists every command of armada --help, in its order | F | Command inventory regex binds to private const COMMAND_HELP source spelling. Retain drift guard but compare public armada --help output to landing commands so internal constant rename preserves test. |
| L31 — gives the launch token's lifetime and the vault's cipher as the code sets them | R | Landing claims are checked against configured token lifetime and vault cipher constants; guards published security claims. |
| L36 — installs with the README's commands | R | Independent README install commands must equal landing install instructions, protecting published onboarding consistency. |
| L41 — replays the session Armada's own code prints (bun run landing) | R | Committed terminal artifact equals CLI render output, guarding stale bun run landing output. |
| L45 — shares the image bun run landing draws | R | Share image artifact matches generated input metadata/dimensions; published share asset remains connected to landing generator. |
| L78 — is prerendered once, at build, with the overview its replica plays | R | Static page/export and generated overview route assertions protect build-time showcase contract. |
| L83 — reads no cookie, database, session, Linear or GitHub | R | Import-graph/source guard excludes cookie/database/session/network dependencies from public landing path; cheapest architectural guard, keep explicit permitted static API module. |
| L101 — never holds the scroll: no sticky stage, no block taller than the screen, no scroll or wheel listener | R | CSS/listener scan protects natural scrolling and bounded stages in public landing; cannot infer actual browser feel, retained as architecture guard. |
| L112 — moves between its steps with the arrow keys, Home and End, wrapping at both ends | C | MethodSteps stepForKey duplicates shared tabStep behavior with extra ArrowUp/Down. Consolidate under keyboard.test.ts:29/:35 only after carrying vertical arrows and switching MethodSteps caller to shared helper; then remove landing-specific helper if no callers. No current cut. |
| L128 — opens on the seeded demo: its sessions to validate, WID-15 asking, WID-18 still shipping | R | Replica start fixture checks seeded question and shipping state, anchoring showcase story. |
| L136 — ends on WID-18 waiting for the owner's decision, WID-15 back at work | R | Replica final fixture checks owner-decision and resumed work states, protecting message the showcase ends on. |
| L160 — flies the mark in, holds it on its anchor pointing up, then breaks it into five ships | R | Injected frame progression verifies flock stages, anchor orientation and five-ship breakup, independently expected geometry. |
| L173 — moves the same on a 60 Hz and a 120 Hz screen | R | Equal elapsed-time simulation at 60/120Hz checks frame-rate independent motion; deterministic steps avoid wall-clock performance claims. |

#### [`packages/dashboard/test/notify.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/notify.test.ts)

History: `47b62cf feat(dashboard): send owner alerts to a chat webhook (#212)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L34 — fire once per item, and only when turned on | R | Opt-in and durable per-item dedupe produce exactly one notification for actionable item; Notifier uses actual storage-rule owner. |
| L49 — stay quiet in the quiet hours, over midnight too | R | Injected local hour covers regular and overnight quiet windows plus disabled hours, preventing unwanted alerts. |

#### [`packages/dashboard/test/overview-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/overview-view.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L158 — holds only what the owner validates; the workers' questions, plans and hand-backs stay with the coordinator | C | pendingValidations is a direct core owner-items reexport. Move absent readings/decided/non-owner fixtures into core/test/owner-items.test.ts:41 keeper before removing wrapper-level rule repetition; core keeper currently misses absent-field fallback. |
| L165 — the Validations page lists what waits oldest first, then what was decided newest first (THE-1021) | R | Validation page sorting distinguishes pending oldest-first from decided newest-first; page-specific contract. |
| L182 — are the questions, plans and hand-backs, oldest first | R | Question/plan/hand-back inbox selection asserts oldest-first actionable list, distinct from owner validation rules. |
| L186 — show the recommended option first, else the worker's order | R | Recommendation parsing order preserves chosen-first/worker-order behavior in answer UI. |
| L196 — a hand-back merges its row's pull request, else the project's open one for the ticket | R | Hand-back selects row PR or project-ticket fallback; merge button must target correct PR. |
| L202 — show what the owner already asked, as the server holds it | R | Existing coordinator requests display answer/pending status from stored request fixture, preventing duplicate owner action. |
| L232 — a long plan is cut on a word | R | Long plan truncation checks word boundary and length for preview presentation. |
| L239 — is one card per project whose coordinator is not active while items wait for it | C | coordinatorAlerts is direct core owner-items reexport. Carry multi-project/oldest/count alert fixtures into core/test/owner-items.test.ts:41 before consolidation; its composed ownerItems test alone lacks these distinctions. |

#### [`packages/dashboard/test/page-anatomy.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/page-anatomy.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L62 — are found, with the modules they render | R | Nonempty fleet discovery and shared-module inventory prevent architecture scans passing vacuously. |
| L69 — \`render no ${what}\` | R | Per-forbidden-pattern source scan enforces fleet page semantic/font conventions across discovered modules. |
| L74 — have one h1, the header bar's, that the shell names | F | Raw <PageHeader heading= spelling requires particular JSX construction. Retain one semantic heading/name contract with render/AST behavior that survives aliased component or prop construction. |
| L82 — are found, with the card they share | R | Nonempty auth discovery and AuthCard presence anchor the auth-page scans. |
| L90 — \`render no ${what}\` | R | Auth forbidden-pattern table protects public auth anatomy across modules, a distinct route family. |
| L100 — is found, with its sections | R | Nonempty landing/component discovery ensures public-page guards cover actual sections. |
| L105 — \`renders no ${what}\` | R | Landing forbidden-pattern table protects static public section anatomy. |
| L109 — sets no font but Geist and Geist Mono | R | Explicit theme source font whitelist rejects introducing another typeface in variables. |
| L120 — globals.css sets no font but Geist and Geist Mono | R | Global CSS font whitelist covers cascade declarations outside theme variables. |
| L129 — the dashboard loads no other font | R | Package/layout inventory blocks loading unwanted font dependencies, distinct from CSS family-name guards. |
| L150 — styles no class that nothing renders | R | CSS classes are matched against rendered sources including compound selectors; stale style guard is existing architecture contract. |
| L176 — gives the phone's bars a height of their own | F | Raw @media(max-width:719px) declaration and any non-none/non-auto height do not prove fixed phone bars: inherit/initial can pass. Keep CLS regression contract; assert effective reserved bar heights at phone viewport or tighten independent AST values and responsive fixtures. |

#### [`packages/dashboard/test/project-view.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/project-view.test.ts)

History: `2450f9b feat(dashboard): rebuild the other pages on the sober v7 design (#188)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L22 — ready labels show the routed profile or defer to the coordinator in the viewer's language | R | Label-routed profiles and deferred launch names appear in both languages; protects coordinator launch UI. |
| L73 — reads each demo project as the design draws it: progress, owner, open PRs and coordinator | R | Demo project fixture verifies progress, owner, PRs and coordinator through current core reading, integration of presentation facts. |
| L115 — progress is unknown without a reading, and zero out of zero is 0 % | R | Missing reading versus empty program has different unknown/zero progress representation. |
| L123 — a pull request reads green, red, conflict, pending or none; a conflict wins over its checks | R | Conflict overrides checks; literal red/green/pending/none cases protect PR strip display. |
| L132 — only a Conductor Cloud coordinator has a session link: its workspace | R | Only Conductor Cloud coordinator yields workspace link, guarding public session destination. |

#### [`packages/dashboard/test/search.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/search.test.ts)

History: `5cedf6e feat(dashboard): rebuild the shell and overview on the sober v7 design (#186)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L195 — reaches agents, tickets (done ones too), pull requests, validations, projects, captions, actions and pages | R | Index contains every public search domain and action with expected hrefs, including attachment captions. |
| L213 — a project's reading gives every ticket but those done over 30 days ago or canceled, and its pull requests' tickets | R | Fixed cutoff excludes canceled/old done tickets but keeps current and PR-linked tickets, preserving search coverage. |
| L256 — a ticket id typed whole is the first result, whatever its case, kind or spacing | R | Literal id casing/spacing fixtures keep exact ticket match first across kinds. |
| L270 — a pull request by its number, with or without #, and by its branch | R | PR number/hash/branch queries reach expected pull request destination. |
| L276 — an id or name starting with the query beats a word, a word beats a substring, a substring beats letters in order | F | Relative indexOf ordering can pass when preferred result is absent (-1). Retain ranking contract, assert both ids are present before comparing ranks for each prefix/word/substring/fuzzy fixture. |
| L287 — a caption, a validation's screenshot and a page are found by their words, in both languages | R | English/French captions, screenshot labels and pages match independent expected targets. |
| L296 — results come grouped, the group of the best match first; near ties go to the recent picks | R | Expected grouping and recent-pick tie break exercise search presentation order. |
| L308 — without a query: the recent picks, then the oldest decision, launches and settings, then the pages | R | Empty query includes recent picks and oldest actionable decisions then pages in expected order. |
| L325 — answer the oldest open decision, launch what is ready, open the coordinator, copy a branch, switch language | R | Expected action targets include oldest decision, launch, coordinator, branch and language, protecting command palette requests. |
| L354 — no launch or answer while the live data is down: the request could not be written | R | Live-down fixture suppresses launch/answer writes while preserving navigation, guarding unavailable request store. |
| L360 — a query over 5 000 items answers well under 50 ms | F | Single-host hard 50ms wall-clock threshold over 5000 items is environment-sensitive. Preserve performance contract in calibrated benchmark (warmup/repeated median and declared runner), and assert returned results; current browser INP budgets cover a different boundary and cannot replace it alone. |

### skills-tooling

#### [`.agents/skills/review-code-dev/scripts/test_ocr.py`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/.agents/skills/review-code-dev/scripts/test_ocr.py)

History: `f645ae6 feat(cli): bundle shipping skills for every managed project (#131)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L20 — test_check_is_read_only_and_verifies_cached_content | R | Temporary OCR cache missing/valid/corrupt bytes plus download/execute spies prove check creates nothing, verifies hashes and runs nothing. |
| L43 — test_platforms | R | Four independent OS/architecture pairs map to supported asset ids; unsupported architecture raises, guarding portable dispatch. |
| L52 — test_install_cache_and_corruption | R | Synthetic download bytes/hash install executable once, reuse cache and reject later corrupt bytes; filesystem trust boundary. |
| L69 — test_bad_download_never_installed | R | Hash-mismatched bytes rejected with neither OCR binary nor temporary download left behind; prevents trusting corrupt downloads. |
| L78 — test_reject_llm_and_config_commands_before_install | R | Disallowed review/provider/exec commands raise before ensure_binary; protects deterministic-only review tooling policy. |
| L85 — test_arguments_are_not_shell_code_and_status_propagates | R | Literal shell-looking path remains single argv value, subprocess exit7 propagates and OCR_NO_UPDATE is1; protects dispatch and failure semantics. |

#### [`.agents/skills/ship-pr-dev/scripts/test_collect_ship_context.py`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/.agents/skills/ship-pr-dev/scripts/test_collect_ship_context.py)

History: `f645ae6 feat(cli): bundle shipping skills for every managed project (#131)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L24 — test_unknown_or_stale_base_requires_explicit_ref | R | Failed git base/diff subprocess results raise explicit --base/bad-ref errors; guards reviewing against an invented/stale baseline. |
| L32 — test_circleci_inventory_includes_its_config | R | Real temporary .circleci/config.yml is inventoried, protecting non-GitHub gate discovery. |
| L39 — test_agent_skill_paths_do_not_trigger_application_risk | R | Concrete agent skill/Claude path fixtures assert workflow classification without false backend/security classification. |
| L51 — test_application_paths_still_trigger_risk | R | Concrete auth API path asserts backend/security classification positive complement. |
| L57 — test_merge_keeps_uncommitted_and_untracked_paths | R | Literal committed/local/untracked records all survive merge into review inventory; catches omitted local changes. |
| L68 — test_merge_combines_status_without_duplicate_path | R | Three statuses for one path yield one combined record, guarding duplicate review accounting. |
| L76 — test_untracked_status_keeps_collapsed_directory | R | Literal porcelain directory/file rows preserve untracked entries while excluding tracked modification, preventing silent review omissions. |

#### [`.agents/skills/ship-pr-dev/scripts/test_prepare_ship_run.py`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/.agents/skills/ship-pr-dev/scripts/test_prepare_ship_run.py)

History: `f645ae6 feat(cli): bundle shipping skills for every managed project (#131)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L10 — test_linked_artifact_components_never_write_outside_checkout | R | Real temporary Git checkouts with symlinked plans components reject generation and leave outside directory empty; guards repository artifact escape. |

#### [`packages/cli/test/doctor.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/doctor.test.ts)

History: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L99 — no token produces exactly one not-checked warning | R | No GitHub credential produces exactly one not-checked warning, preventing noisy diagnostics. |
| L106 — a token denied access yields one warning without exposing the response | R | Denied API access produces one bounded warning and does not leak response canary. |
| L117 — appends all five compatibility lines despite unavailable classic protection | R | Unavailable classic branch protection still yields five independent compatibility findings. |
| L139 — not signed in, it warns that workers would need keys in their environment | R | Unsigned terminal warns expected worker key provisioning, preserving setup guidance. |
| L152 — signed in with an organization API key, it names the key and the organization | R | Signed-in organization API key shows name/org without value, public credential source contract. |
| L164 — a revoked sign-in is a warning with the way back | R | Revoked sign-in warns with recovery path; no crash or leaked response. |
| L176 — signed in to another Armada, it says which | R | Wrong Armada endpoint is identified so user can correct setup. |
| L183 — a key left in the credentials file that Armada now gives is flagged; an environment override is not | R | Machine duplicate key is flagged while explicit environment override is allowed; resolver policy at diagnostics boundary. |
| L202 — database variables of earlier versions left in the credentials file are flagged, signed in or not, never shown | R | Legacy database variables are diagnosed without values for either sign-in state. |
| L219 — older than Armada expects, it is an error whose fix installs the latest; the sign-in is not checked twice | F | Title promises sign-in not checked twice but assertions only inspect output. Retain minimum-version guidance and assert fakeArmada whoami/credential call count to catch redundant requests. |
| L231 — recent enough, it is ok and names a newer release | R | Compatible CLI prints installed/current versions and newer release guidance. |
| L245 — only inbox/status carry the daily notice; doctor stays quiet | F | Name promises inbox/status notices but exercises doctor and inbox only. Retain daily notice boundary and add status invocation with independent fake-server counter; doctor silence alone does not establish worker suppression. |
| L258 — a listed release stays quiet until the server verifies its tarball | F | Fake refresh callback performs publication check and changes latest itself; CLI test cannot prove server implements gate. Retain quiet-until-published behavior, pair with dashboard release-refresh owner coverage or mark that missing boundary explicitly; do not claim mock enforces real publication. |
| L292 — a worker is never told: it installs the version its brief names | D | Calls universally quiet doctor under worker sign-in and only asserts no notice: no worker-specific production notice branch is reached. doctor.test.ts:245 already owns doctor silence; retain worker-notice eligibility at actual status/inbox owner before broad cuts. This redundant negative doctor case alone can be deleted. Actual worker notice suppression remains in cli/test/release.test.ts:90. |
| L300 — a CLI older than the server's minimum gets the upgrade line only | C | Only asserts outdated doctor output lacks daily notice. Consolidate this assertion into minimum-version doctor.test.ts:219 keeper; carry no-extra-notice assertion there before dropping duplicate setup. |
| L335 — on PATH, it is ok; a project without a profile on Conductor is not checked | R | PATH availability and profile-none fixture distinguish applicable Conductor prerequisite check. |
| L353 — only inside the macOS app, the fix links it from a directory on PATH, else adds it to PATH | R | macOS app context versus ordinary PATH yields correct repair action without executing runtime. |
| L370 — found nowhere, it says where it looked | R | Missing binary diagnostics list searched locations, an actionable setup output contract. |
| L382 — names those not set in Armada, by name only; all set is ok; signed out it says it could not check | R | Secret-name checklist covers absent/present/unsigned states and asserts no values. |
| L407 — origin mismatch, equivalent forms, GitHub rename and unavailable checks | R | Origin forms, mismatch, repository rename and unavailable GitHub reads yield independent diagnostics and no canary leakage; injected retry waits protect bounded reads. |

#### [`packages/cli/test/init.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/init.test.ts)

History: `00e6f15 feat(doctor): check GitHub branch rules for merge compatibility (#236)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L315 — init refuses without a sign-in to Armada, before it pushes, opens or creates anything | R | Unsigned init refuses before Git push/PR/Linear mutations; side-effect boundary explicitly observed. |
| L330 — init replaces legacy PRs once and reuses armada/setup across versions | R | Real temporary Git origin plus fake PR state proves legacy cleanup once and stable setup branch reuse across versions. |
| L385 — init --merge refuses a diff outside setup paths (%s) | R | Outside-setup diff matrix refuses merge, protecting setup-only allowlist at exact Git diff boundary. |
| L401 — init --merge waits for checks, permits the first armada.toml and merges the pinned setup head | R | Checks transition pending to success and merge pins setup SHA; first config creation allowed. |
| L413 — init --merge refuses a setup PR retargeted while checks run | R | Retargeted base while waiting refuses merge, catching TOCTOU provenance change. |
| L428 — an empty init plan leaves a manually edited stale setup PR unmerged | R | Empty generated plan leaves manually changed stale PR untouched, preventing unrelated merge. |
| L454 — init --merge checks both sides of a rename on the exact merge head and gives the lock back on refusal | R | Both paths of rename checked on pinned head and lock released on refusal; substantive merge safety regression. |
| L475 — init --merge refuses armada.toml once the project is set up | R | Already initialized config cannot be merged as setup replacement, protecting user project configuration. |
| L492 — init opens one pull request that makes doctor pass once merged, and running it again updates it | R | Actual setup PR content merged into temp Git makes doctor pass; reinit updates same PR, valuable command integration. |
| L557 — an outdated skill is a doctor warning, and init opens a pull request that updates it | R | Outdated installed skill diagnosed and updated through setup PR, protecting upgrade workflow. |
| L578 — init asks before adding the stop hook; a no leaves it out and doctor says what it is for | R | Explicit stop-hook opt-out leaves hook absent while doctor explains it, preserving optional setup consent. |

#### [`packages/cli/test/review-runtime.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/review-runtime.test.ts)

History: `f645ae6 feat(cli): bundle shipping skills for every managed project (#131)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L5 — doctor diagnoses review prerequisites without installing or executing OCR | R | Fake executable observes doctor bootstrap prerequisite mode without install/OCR execution; protects CLI diagnostic side-effect boundary, complemented by Python wrapper tests. |

#### [`packages/cli/test/skills.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/cli/test/skills.test.ts)

History: `f645ae6 feat(cli): bundle shipping skills for every managed project (#131)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — skills update applies init's bundle locally without credentials or remote calls | R | Actual local files and safe names verified after skills update; forbids credential/network calls through injected Io. |

#### [`packages/core/test/skills.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/core/test/skills.test.ts)

History: `c811e71 feat(cli): read, answer and safely stop herdr workers (#143)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L8 — the bundle carries every file under skills/, byte for byte | R | Independent folder bytes compared to generated bundle catches stale release artifact; changes here are project-local and intentionally outside bundled skills/. |
| L22 — every runtime guide has the sections the coordinator and armada merge point at | R | Installed runtime names and public guide section headings are consumed by coordinator/merge links; protects navigation contract. |

#### [`packages/dashboard/test/fonts.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/fonts.test.ts)

History: `377f7ae feat(dashboard): preload only the Latin cut of Geist and Geist Mono (#109)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L30 — are the ones \`bun run fonts\` cuts from the geist package today | R | Fresh cuts of installed geist package compared to committed bytes guard stale font artifacts after dependency changes. |
| L40 — the Latin cut keeps every character Geist has in its ranges, the weight axis, the missing-glyph box and the features the CSS asks for | R | Font tables independently verify character coverage, weight axis, notdef and CSS features, catching generation losses. |
| L70 — every character the app writes that Geist has is in the Latin cut | R | App source characters cross-checked with source font cmap avoid unsupported Latin cut glyphs. |
| L85 — every page lists each full font before its Latin cut | F | Exact .map(font => font.variable) source and CSS-prefix assertions couple fallback-order contract to construction. Keep glyph/fallback registration contract via exported configuration/rendered classes that survives equivalent array construction. |

#### [`packages/dashboard/test/icons.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/icons.test.ts)

History: `dc2e74a feat(dashboard): show the Armada mark as the browser's tab icon (#94)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L9 — are the ones \`bun run icons\` builds from the shell's mark today | F | SVG freshness is verified, but PNG dimensions plus embedded mark hash can pass with wrong raster pixels. Retain generated icon contract and independently decode/compare raster pixels; metadata does not establish rendered mark. |
| L29 — pass the gate, which still holds every page and route | R | Proxy matcher public icon paths remain accessible under auth gate while page/route guard remains; independent allowed/held path assertions. |

#### [`packages/dashboard/test/perf.test.ts`](https://github.com/The-Vibe-Company/armada/blob/4fb197721bc05993e07acd935c9697b40741daf4/packages/dashboard/test/perf.test.ts)

History: `6414147 fix(dashboard): keep the overview still while its page streams in (#174)`.

| Location and exact declaration name | Mark | Evidence |
|---|:---:|---|
| L36 — sum each route's first-load chunks once, and compress each chunk once | R | Independent chunk graph fixture proves per-route/per-chunk dedupe and compression total for bundle budget. |
| L52 — hold up to the baseline plus the tolerance; a route without a baseline breaks them | R | Literal baseline/tolerance and missing route fixtures protect budget failure semantics. |
| L66 — read a run as Lighthouse shows it: scores out of 100, CLS to three decimals | R | Lighthouse fixture maps scores and rounded CLS to report units consumed by CLI. |
| L85 — name what each layout shift moved, with its box before and after | R | Layout shift fixture preserves affected node boxes for useful regression diagnosis. |
| L101 — keep the median run of performance | R | Multi-run fixture selects median score, avoiding lucky run reporting. |
| L107 — break on a score under its minimum or a metric over its maximum, LCP on mobile only, accessibility as a warning | R | Threshold cases distinguish mobile LCP and advisory accessibility from hard failures. |
| L126 — shows every number, then what broke and what only warns | R | Golden readable report covers values, failures and warnings at output boundary. |
| L154 — says when every budget holds | R | All-budget-pass report prints positive completion state. |
| L160 — an interaction over its budget breaks it | R | Over-budget interaction fixture triggers hard failure in INP tooling. |

## THE-1146 handoff

Refresh the declaration inventory after Specs 8–11 land, preserving this pin for comparison. Re-read changed files and their new regressions before moving any assertion. Start with the named definite duplicate and weak negatives; apply one owner-boundary batch at a time. Preserve every listed keeper contract and use deliberate caught mutations only in the authorized cutover, restoring source exactly. No measured deletion savings or production LOC reduction is claimed here.

Branch reconciliation: main `843c866c9bb86201c2b80eba154d5a8296520637` (#224) was brought in after the pinned baseline. It adds `dashboard/test/validation-gallery.test.ts` and changes core config/validations, CLI worker, dashboard fleet-data/migrations tests. These are outside the pinned ledger; THE-1146 must include them in its refreshed discovery. Refreshed branch verification is delivery evidence, not a retroactive baseline.

Current audit delta: tests 0 LOC, support 0 LOC, production 0 LOC. Only this ledger and the two project-local skill files are added. The upstream OpenClaw skill is pinned and MIT-attributed in both vendored files; referenced upstream workflow skills were read only for mapping and were not vendored.

Final reconciliation: main `f2f08c881286bc1e8cf02f36f85f60cb2d0d6f95` (#232, confirmed-merge recovery during Linear outages) was also brought in before hand-back. Its CLI/core merge and fleet changes, dashboard persistence changes and added regressions are outside the pinned ledger; THE-1146 must include them in refreshed discovery. This PR still adds only the two project-local skill files and this doc relative to the refreshed main.
