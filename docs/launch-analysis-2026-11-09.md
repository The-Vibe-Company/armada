# Launch review — 9 November 2026

## Evidence

A read-only, fully paged `armada list --limit 100 --page-info --org <org> --json` returned 75 visible, non-deleted sandboxes before the two onboarding workers were started. This is a snapshot of sandbox state, not a record of 75 successful or failed launches.

| Observation | Count |
| --- | ---: |
| Boat / Modal in the surviving sample | 75 / 0 |
| Codex / Claude | 56 / 19 |
| Stopped / failed / running | 69 / 4 / 2 |
| Created since midnight UTC on 9 November | 22 |
| Missing expiry / recorded lifecycle error | 0 / 0 |
| Four-hour effective TTL | 66 |

All four failed records carry the same provider reason: the box moved to another machine while a prompt was running. All four have a confirmed stop timestamp. Do not report these as credential failures, agent-code failures, or a launch success rate. The newest ten sandboxes all retain the requested model defaults: seven Codex `gpt-6.1-sol / medium`, three Claude `claude-opus-5-5 / medium`.

Eight older rows have stop timestamps later than their recorded expiry. Earlier operator checks established that their machines were already physically stopped when stale database state was reconciled. The late timestamps therefore do not establish extra compute usage. Durable lifecycle reconciliation shipped in 2.8.0; retain this distinction in future metrics.

During this work, one new Codex launch failed at the first repository pull with Git's dubious-ownership refusal. The same box was stopped by failure cleanup. After resuming that owned box, the command user and repository owners were UID 1000, pulls succeeded, and the worker continued on current main. The exact initial command UID was not recorded; a transient execution-user mismatch is a hypothesis, not a proven cause. The parallel Claude launch succeeded. Neither attempt justifies disabling Git ownership checks globally.

## Proposed improvements

| Priority | Change | Acceptance |
| --- | --- | --- |
| P1 | Make repository preparation deterministic after a restore: establish the execution identity and inspect ownership of each configured repository before pulling. If needed, trust only explicitly validated configured paths for that command. | A restored ownership mismatch has an actionable error or a narrowly scoped repair; an unrelated repository is never trusted, and `safe.directory=*` is never used. |
| P1 | Distinguish provider relocation from agent failure and offer a deliberate continuation action for the same conversation. | Preserve the workspace/conversation and show the last confirmed cursor. Replaying a prompt must use an idempotency receipt; never automatically replay commands or completed work with unknown side effects. |
| P2 | Persist launch-attempt stages and outcomes, including refusals before a sandbox exists. | Record provider/harness, request ID, fork/ready/pull/init/MCP/prompt stage, timestamps and redacted error class. Report per-stage p50/p95, retries, first-prompt outcome, and physical stop confirmation separately; no prompt bodies, tokens or command output in metrics. |
| P2 | Offer opt-in stop-on-idle, in addition to the existing hard TTL. | A configurable grace period starts only after the latest prompt and all tracked jobs settle. Active leases and an explicit keep-alive defer stopping; new activity invalidates an old stop attempt. Preserve disks and conversations and confirm the physical stop. |

The median created-to-stop interval of stopped rows is about 10.6 minutes, while most effective TTLs are four hours. This suggests evaluating idle stopping; it is not an estimate of wasted runtime or money. Rows may be reused across several tasks, so this interval is not task duration.

## Changes implemented with this review

Issues [#575](https://github.com/The-Vibe-Company/armada/issues/575) and [#576](https://github.com/The-Vibe-Company/armada/issues/576) cover mandatory organization provider setup, an upstream credential check before saving, and a concise, resumable dashboard workflow. An individual user's provider key does not complete an organization's setup. Existing configured organization credentials remain usable.

## Limits

The sample omits deleted sandboxes, including the earlier Modal validation fixtures, and cannot compare provider reliability. It contains no durable per-stage timings, costs or full attempt history. `stopped` does not mean the task succeeded; `failed` may describe a later turn. Absence of a recorded lifecycle error does not prove every provider observation was timely. A later release's monitoring should supply these missing measures before changing provider defaults.
