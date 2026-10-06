# Test-pruning campaign

Campaign mode audits one subsystem's whole test surface, or the entire Armada
suite split by production owner. An audit-only ticket completes steps 1–4 and
records step 8's handoff without cuts. Steps 5–7 belong to separately authorized
follow-up work; never change tests or source during read-only discovery. The
value bar, retention bar, candidate evidence, and validation in [SKILL.md](SKILL.md) apply to every
lane. This file adds the order of work and the lessons of a full campaign.
Each step ends on its completion criterion; do not start the next step early.

## 1. Baseline

Record the subsystem's test and support line counts and every test file's
pass/fail state at a pinned `main` SHA. Keep baseline failures in their own
list as possible product bugs, not stale tests. Record Bun/toolchain versions,
commands, runtime test counts, declaration counts and skips separately.

Done when every in-scope test file has a recorded baseline result.

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file
prefixes. For Armada these are core (live/fleet API, merge, worker, brief and
related owners), CLI, dashboard storage/API, dashboard UI, and skills/tooling.
Include the subsystem's cases at shared core boundaries and its QA and live-proof
harness tests.

Done when every test file and QA scenario the subsystem owns belongs to exactly
one lane.

## 3. Read-only ledger per lane

Give each lane to its own read-only agent. The agent reads every assigned test
in full, including parameter tables. It also reads the production owners and
their entry points, callers, history, and CI routing. Each test declaration
goes into a written **ledger** with one mark. An `it.each` is one declaration
unless its rows need different marks; then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that
  only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative
  that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling
  table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists.

Judge a test by its assertions, not its name. A test named for retiring a
progress window that asserts it was _not_ cleared does not prove retirement.

Done when every declaration in the lane has a mark and an evidence line.

## 4. Layer plan per lane

Treat the per-test ledger as input, not as the edit list. A second read-only
pass, starting from the ledger, looks for the redundant **layer**. Look for
suites that replay a shared owner through mocked collaborators around stronger fake-network or PGlite boundary suites. Name the
**keeper** suite for each contract. Prefer the real transport boundary with a
fake network over a mocked collaborator. Correct any ledger errors this pass
finds.

Done when each lane plan names its retired files, its keeper per contract, the
assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit lane by lane. Serialize changes to shared harnesses and support files
through one owner. With each lane, remove the test-only production seams it
unlocks: injection parameters, getters, reset exports, and indirection layers.
Register moved suites in CI routing and test inventories. Update shrink-only
line-cap baselines. Put durable test-ownership rules in the subsystem's
`AGENTS.md`, drawn from mistakes this campaign actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

Before claiming a cutover complete, use the single independent `review-code-dev`
gate through `ship-pr-dev`. Its read-only reviewer compares deleted coverage
against keepers by boundary group, looking for contracts that lost their only
proof and new assertions that cannot fail (such as a rejection row the production
code never reaches). The worker owns authorized repairs.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red. Then restore the source byte for byte.

Done when every reported gap is restored or rejected with source evidence, and
every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a bug report. Fix it at its
owner as a separate commit, and prove it through the real user flow, with a
**control** run that reverts the fix and shows the old behavior. Record
unrelated product discrepancies you find as follow-ups instead of fixing them
in the campaign.

Done when each repaired defect has a failing control and a passing candidate
on the same harness.

## 8. Reconcile and hand off

Campaigns outlive many `main` commits. Merge `main` rather than rebasing a
long, many-commit campaign. When `main` modified a file an authorized cutover
deleted, retain the deletion only after confirming the keeper preserves every
new contract. An audit-only ledger keeps its pinned baseline and labels later
main changes as outside that baseline; the cuts ticket must inventory them
again. For an authorized cutover, port the new contract into the keeper instead,
and confirm every new regression `main` added still has a home. Rerun the whole
subsystem suite and repeat live proof on the merged head.

Expect review tooling to see a truncated file list on a diff this large.
Record maintainer decisions for generic compatibility flags in the PR evidence
rather than editing gates.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test/support line counts, with production counted separately;
- lanes, retired layers, and keepers;
- preservation gaps found and their mutations;
- product defects with control and candidate proof.

## Attribution and license

Adapted for Armada from [OpenClaw's test-audit skill](https://github.com/openclaw/openclaw/tree/bc8e15ed3b71e4ef505bb99855ef4219a131b071/.agents/skills/test-audit)
(`SKILL.md` and `CAMPAIGN.md`), pinned at `bc8e15ed3b71e4ef505bb99855ef4219a131b071`.
The authoring gate, junk patterns, value bar, retention bar, candidate evidence
and ledger marks are preserved. Armada changes the repository commands, lane
examples and delivery protocol. The upstream license follows in full.

```text
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
