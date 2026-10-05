# Harness token usage sources

Research snapshot: 2026-10-05. This is evidence for a future worker meter, not an
implementation or a billing guarantee. Examples below are synthetic. The ticket
comment holds the redacted observations from actual sessions.

## What was measurable

| Harness | Runtime | Evidence |
| --- | --- | --- |
| Claude Code | Local herdr | **Not measurable from this workspace:** no Mac command tool, local filesystem, or herdr server. The source below is a candidate, not local-session confirmation. |
| Codex | Local herdr | **Not measurable from this workspace:** same access limitation. The source below is a candidate, not local-session confirmation. |
| OpenCode | Local herdr | **Not measurable from this workspace:** same access limitation; installed version and storage layout remain unknown. |
| Claude Code | Conductor Cloud | **Confirmed:** Claude Code 2.1.286, a tool-free CLI probe and a resumed turn in the Cloud checkout wrote two usage rows. This tests the harness inside Cloud; a Conductor-managed Claude chat was not sampled. |
| Codex | Conductor Cloud | **Confirmed:** the running Conductor-managed Codex 0.159.3 session wrote a rollout with matching cwd and increasing token totals. |
| OpenCode | Conductor Cloud | **Not measurable in the inspected workspace:** no executable, data directory, or session. Conductor's bundled adapter contains OpenCode support, but `conductor model` lists no OpenCode models. This does not establish that OpenCode is universally unsupported in Cloud. |

Unavailable evidence means **unknown**, never zero usage. Local confirmation
requires usage-only samples collected on the machine hosting herdr.

## Claude Code

Source: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<encoded-cwd>/<session-id>.jsonl`.
The Cloud probe used `~/.claude/projects/<encoded-cwd>/`. Directory encoding in
the inspected Conductor adapter replaces every non-alphanumeric character with
`-`, with truncation and a hash for long paths; replacing only `/` is insufficient.
Prefer the actual transcript path over reconstructing it.

Match `cwd` and `sessionId` in transcript rows to the worker's canonical worktree
and native harness session. Hooks provide `cwd`, `session_id`, and
`transcript_path` directly ([hook reference](https://code.claude.com/docs/en/hooks)).
The directory alone can hold multiple sessions and its encoding can collide.

Assistant rows hold **per-response** `message.usage.input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, and `cache_read_input_tokens`. Cache writes and
reads are separate buckets, additive to uncached input. Sum one final usage per
native response, not every content block or repeated transcript row; preserve
message/request identity when deduplicating. Do not also sum nested cache-TTL
breakdowns or `iterations` into their parent counts. The two probe turns retained
the same session ID and separate usage, confirming that the last row alone is
not the cumulative total.

```json
{"type":"assistant","sessionId":"session-example","cwd":"/work/repo","message":{"id":"message-example","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":300,"cache_read_input_tokens":400}}}
```

`claude -p ... --output-format json` also emits result `usage`; the probe's result
agreed with that invocation's transcript row. It is not an ongoing session poll.
Include associated `<session-id>/subagents/agent-*.jsonl` for delegated work,
without recounting copied responses in the main transcript. Claude's interactive
`/usage` reports session totals and separate cache counts, but local cost is an
estimate ([cost reference](https://code.claude.com/docs/en/costs)). Persistence
disabled or cleaned-up files make retrospective measurement incomplete.

## Codex

Source: `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*.jsonl`; also check
archived sessions when necessary. Match `session_meta.payload.cwd` to the
worktree and `session_meta.payload.id` to the native thread ID. In the inspected
Cloud workspace, `/conductor/sessions/<conductor-session-id>.json` exposed
`agentSessionId`, which matched that native ID. This is an observed internal
mapping, not a stable public API; extract only identity fields, never the full
state file. Cwd alone would combine multiple chats sharing one checkout.

Use the **latest non-null** `event_msg` with `payload.type = "token_count"`:
`payload.info.total_token_usage` is cumulative; `last_token_usage` is the last
usage increment. Never sum successive cumulative snapshots. For a claim begun
mid-session, subtract a saved baseline and handle counter resets explicitly.
The pinned protocol can synthesize totals on context-full recovery, so this
counter alone is not an exact spend ledger under every failure condition.

```json
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":25,"total_tokens":1100}}}}
```

Cache reads are separately reported as `cached_input_tokens`, **included in
input_tokens**. Reasoning is included in output. The observed 0.159.3 schema also
has `cache_write_input_tokens` (zero in the sampled session); older readers must
allow its absence. Use `total_tokens` rather than adding cache or reasoning
subsets again. The same rollout contains `token_usage_record` with per-response
`payload.usage`, response identity, and `thread_token_usage`; use one accounting
source consistently. These are best-effort records of completed responses, not
proof of every provider charge. See the pinned [usage definitions](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/protocol/src/protocol.rs).

Codex also documents `thread/tokenUsage/updated` in its
[app-server protocol](https://developers.openai.com/codex/app-server/).
This is a harness notification, not a Conductor CLI usage endpoint.

## OpenCode (source inspection only)

Resolve the actual executable/version before choosing a reader. OpenCode
1.18.34's pinned [database resolver](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/core/src/database/database.ts)
uses `$XDG_DATA_HOME/opencode/` (normally `~/.local/share/opencode/`), `opencode.db`
or a channel-specific `opencode-<channel>.db`. `OPENCODE_DB` overrides the file;
`:memory:` cannot be read from another process. Conductor's inspected adapter
can override V1 storage to `<parent-of-agent-binaries-dir>/opencode/opencode.db`;
its V2 branch uses a different session-ID prefix and native storage.

The pinned [schema](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/core/src/session/sql.ts)
has `session.directory` and cumulative `tokens_input`, `tokens_output`,
`tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`. Match directory
**and native session ID**; `project.worktree` can identify the shared repository
root rather than the worker checkout. `message.data` contains V1 assistant JSON;
`session_message.data` is another representation with a separate `type` column.
Check which representation the installed version writes; do not sum both.
Assistant `tokens` has input, output, reasoning, and separate `cache.read` and
`cache.write`. The [stats implementation](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/cli/cmd/stats.ts)
adds these five buckets and folds reasoning into displayed model output. These
semantics were not verified against a provider response here.

```json
{"role":"assistant","sessionID":"session-example","path":{"cwd":"/work/repo","root":"/work/repo"},"tokens":{"input":10,"output":20,"reasoning":5,"cache":{"read":400,"write":300}}}
```

This illustrates the V1 shape, **not an observed session**. Older installations
may use `storage/message/<session-id>/<message-id>.json` and matching session
JSON. Prefer a version-appropriate session export/API or read-only SQLite access
including WAL visibility. `opencode stats --project ""` aggregates a project,
not a single worker session ([CLI reference](https://dev.opencode.ai/docs/cli/)).

## Implications for a meter

Keep runtime handle, native session IDs, canonical worktree, harness version,
claim baseline, and separate token buckets. Include child sessions and completed
compaction requests where recorded. Verify resume, deletion/revert, compaction,
retries, and truncated live writes before treating any source as a monotonic
spend ledger. Preserve unknown/incomplete readings and report last observed time.
Tokens can support alerts; price and subscription billing require another rule.
This spike adds no meter, budget enforcement, or automatic kill.
