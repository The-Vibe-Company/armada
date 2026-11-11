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

A local, no-model Codex app-server handshake also succeeded: `initialize`
returned a result, and `thread/start` with `ephemeral: true` returned
`result.thread.id` and `result.thread.sessionId` as equal UUID-shaped strings.
Two existing local `session_meta` records had a JSONL filename suffix matching
their `payload.id`. Only field names and boolean/count results were exported.
This validates installed protocol/schema shape, not a Boat-dispatched model turn
or the completed identity bridge end to end.

## Live validation limitation

The implementation sandbox's Boat CLI rejected a no-tools Claude validation
prompt with HTTP 401 (not signed in / expired session). No Boat API credential
was available. Consequently, normal Boat-dispatched turns, headless callback
delivery, controlled stop, and resume/fresh-fork behavior have not been validated
against the live provider here. Local parser/bridge tests are not substitutes for
that acceptance proof. Restore authorized nonproduction Boat access and run the
coordinator check above before treating #883 as complete.

## Authorized #977 takeover: candidate boundary repair

The candidate no longer freezes an arbitrary cumulative file snapshot at the
next admission. For Codex it binds the admitted Armada prompt to the native
`turn/started` ID and checks the same ID on `turn/completed`. Extraction requires
matching `task_started` / `task_complete` records in append order in the native
session log. A resumed turn needs a closed preceding turn's final total; a
verified fresh thread's first turn uses the known empty baseline. Missing,
truncated, overlapping, mismatched or unclosed records remain unknown. Successful
closed-turn results are immutable on retry. No marker means no number, even if
a plausible cumulative snapshot is already present.

Local installed CLI 0.167.1 generated protocol types confirm native turn IDs in
both notifications. Local session inspection (event type names only) confirms
ordered task-start, context, token-count, task-complete records. A regression
covers a valid stale cumulative snapshot whose final counters and completion
marker flush only after the next prompt is admitted. This is local schema and
parser evidence, not proof of the live Boat bridge or staging acceptance.

The previous Claude cost-state subtraction has the same unproven flush boundary.
It has been disabled rather than retaining unsafe attribution: Claude's normal
native invocation and managed MCP bridge remain unchanged from main. Boat Claude
usage remains unknown until a verifiable native per-turn boundary is supported.
No new zero counters are invented. This is a remaining coverage limitation, not
an assertion that Claude never reports usage.

Required live validation is on staging, not production: first confirm a Modal
session's current dashboard tokens, then run Boat × Codex and Modal × Codex
turns and capture non-zero API and dashboard values. This sandbox currently has
Boat HTTP 401, no staging Armada session, and no browser login. Secure staging
access is required; no live acceptance or readiness is claimed.

Boundary source reference: official Codex `rust-v0.167.1`, resolved commit
`0a94398fa60c4fac0e7659e4213a0a36e613dd46`,
`codex-rs/core/src/session/mod.rs` (`send_event_raw_with_persistence`),
`codex-rs/core/src/session/turn.rs` (awaited token-count emission),
`codex-rs/core/src/tasks/mod.rs` (terminal emission after task completion), and
`codex-rs/protocol/src/protocol.rs` (serialized marker names). Native aborted
turns emit `turn_aborted`, not `task_complete`: the parser closes that sequence
without claiming complete counters, leaves the immediate next baseline unknown,
and permits later closed turns to establish a new verified baseline.

## Abandoned-admission recovery

An expired or superseded unclaimed admission is invalidated and retired, not
turned into a sandbox-wide permanent disable switch. A SHA-256 digest of the
exact requested prompt text is matched against the native single-text input
before claiming a ticket; raw text is never passed to guest exec or persisted by
this helper. Late callbacks for a retired input cannot consume a newer ticket.
Unsupported/transformed input remains unknown rather than guessed at.

Identical ambiguous inputs are quarantined for that physical sandbox generation:
without an external request identifier their delayed callbacks cannot be safely
distinguished. Other inputs continue collecting normally, and a fresh physical
sandbox resets inherited tickets/quarantines. A legacy pre-fingerprint disabled
state also stays unknown until that reset; the new path never creates it.
Regression scenarios use injected expired timestamps (no waits), rejected
unclaimed dispatches, late callbacks, exact/native input matching, same-input
ambiguity, successful later counters, and fresh-fork recovery.
