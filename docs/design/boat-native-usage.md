# Boat native usage evidence (#883)

Boat usage belongs in the existing per-prompt usage projections, not a second
ledger. Extraction is on demand, after terminal observation and before controlled
stop. Missing identity or incomplete records must remain unknown, not zero.
Neither native cost fields nor derived estimates are an actual invoice.

## Installed schemas inspected

On the implementation sandbox, 2026-11-11, the installed executables reported
Codex CLI 0.167.1 and Claude Code 2.1.322. Existing local Codex session records
were inspected locally using an allowlist; no prompts, transcripts, session
filenames, credentials, or raw records were exported.

Codex JSONL records use top-level type `event_msg`, payload type `token_count`,
and `payload.info` containing `total_token_usage`, `last_token_usage`,
`last_usage_includes_reasoning`, and `model_context_window`.
Two consecutive observed numeric snapshots were:

| Counter | First total | Next total | Next last |
| --- | ---: | ---: | ---: |
| input_tokens | 14470 | 38177 | 23707 |
| cached_input_tokens | 0 | 14467 | 14467 |
| cache_write_input_tokens | 14467 | 23617 | 9150 |
| output_tokens | 78 | 186 | 108 |
| reasoning_output_tokens | 0 | 0 | 0 |
| total_tokens | 14548 | 38363 | 23815 |

These are cumulative totals and last-request counters, not independent additive
frames. In particular, summing total snapshots double counts usage.

Claude evidence supplied by the coordinator in issue #883 (2026-11-10) reports
a native `cost-state` record with `modelUsage` and counters `inputTokens`,
`outputTokens`, `thinkingTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens`, `cacheCreationEphemeral5mInputTokens`,
and `cacheCreationEphemeral1hInputTokens`. The reported main-model sample
was input 2, output 11, cache read 18996, cache creation 17578.
This is supplied evidence, not an independently executed Claude turn here.

## Coordinator production check

After deployment, launch one Boat sandbox per harness, run two normal turns,
then inspect status/list/dashboard for non-empty per-prompt and sandbox counters.
Retry status collection and verify identical totals; interrupt a third turn and
stop the sandbox, verifying retained observations and explicit missing coverage.
Use only anonymized counter output, never raw native session files. Production
checks are not performed by this change's delivery owner.
