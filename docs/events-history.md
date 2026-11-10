# Conversation history paging

`POST /api/v1/logs/read` accepts `id`, optional `conversationId`, `cursor`,
`direction` (`forward`, default, or `backward`), `limit` (default 100, 1–1000),
`maxBytes` (default 262144, 256–1048576), and `coalesce` (default false).
Existing `all` and `follow` remain; `all` cannot combine with backward reads.
MCP `logs` calls the cursor `since_cursor` and conversation `conversation_id`,
with count limit 500. Orchestrator events accepts the same paging options with
its existing `orgId`/`id` and count limit 500. Core exports `EventsRequest`,
`EventPage` and `OrchestratorEventPage`.

Responses contain chronological `events`, `cursor` (forward continuation after
newest included raw event), `olderCursor` (backward continuation before oldest
included raw event, absent on empty pages), and direction-relative `hasMore`.
Logs retains `settled`; orchestrator envelopes retain `version: 1`.
Cursors are opaque and exclusive; never decode or mix sources.

Start with `direction: backward` without a cursor. Save its `cursor` as the
live frontier. Prepend older pages requested with `direction: backward,
cursor: olderCursor` while `hasMore`. Poll forward with the saved live frontier
and no coalescing. Advance that frontier only from forward responses, never
from older pages. Empty first reads have no frontier (HTTP logs uses null);
follow without a cursor until one is returned. Preserve existing event-ID
upsert semantics for repeated/updated events.

Count applies to raw events before coalescing. Byte bound covers UTF-8 JSON of
the returned events array, not headers/response metadata. An indivisible event
larger than the bound is rejected, never skipped or truncated; retry with a
larger budget. Coalescing combines only adjacent message events with matching
explicit message/conversation/prompt IDs and known text modes. Deltas append,
snapshots replace, tool IDs retain latest values. The result uses the newest
event ID and snapshot mode. Coalescing is page-local: a message can span pages,
so output is not necessarily its full conversation text. Legacy/unidentified
fragments and non-message events are not combined.

Visibility rules are unchanged. Orchestrator history first catches up retained
events from upstream (at most 100 upstream pages, otherwise unavailable rather
than a silently stale tail).

CLI: `armada logs <id> --tail [n]` (default 100), optionally `--follow`/`--json`.
Tail cannot combine with `--all` or `--since`. Follow switches from the initial
backward page to forward polling at its newest cursor.

## Synthetic 2,000-event measurement

Real Boat SDK with fake fetch, 2,000 identified fragments. Forward drain:
**20 requests, 356449 response bytes, 2000 events, 22.11 ms**. Latest 100 raw
events coalesced: **1 request, 501 response bytes, 1 message event, 1.32 ms**.
Timings are local CPU, not production/network/phone latency. The after read
intentionally loads the current window, not all 2,000 events. Reproduction
and raw results are in ignored Ship PR artifacts.
