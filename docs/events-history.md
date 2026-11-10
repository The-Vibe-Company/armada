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
larger than the requested budget is returned alone (the soft budget is exceeded).
Above the hard 1 MiB events-array limit, it is replaced by one closed
`kind: other, type: event_truncated` marker. Its `data.reason` is
`event_exceeds_hard_limit`, with `originalKind`, `originalBytes` and `limitBytes`; the payload
is omitted, not retryable with a larger budget. The raw cursor still advances.
Orchestrator envelopes retain their metadata and wrap this marker as an agent
event (including for an oversized non-agent payload). Markers preserve the
conversation and prompt IDs when present and at most 256 characters each.
Oversized context IDs are omitted with `data.contextTruncated: true`, not
clipped into misleading identities, so the marker itself remains bounded.
Non-agent envelope markers retain
the original envelope kind in `data.originalKind` and use its timestamp.

There are two `event_truncated` data shapes: the runtime journal's pre-existing
marker has `{ originalKind, bytes }` (`bytes` counts serialized UTF-16 code units
after redaction, at its 262144-unit journal limit). The history hard-limit marker
has `{ originalKind, reason: "event_exceeds_hard_limit", originalBytes, limitBytes }`;
`originalBytes` counts UTF-8 JSON events-array bytes, including an orchestrator
envelope when present. Clients must accept both as closed gaps and must not rely
on `reason` being present on journal markers.

Coalescing combines only adjacent message events with matching explicit
message/conversation/prompt IDs and known text modes, **starting from a native
snapshot**. Deltas after that snapshot append, subsequent snapshots replace,
and tool IDs retain latest values. The result uses the newest event ID and
snapshot mode. Delta-only runs remain raw, even with `coalesce: true`: Armada
never manufactures a replacement snapshot from a page-local suffix. Thus no
offset or cross-page snapshot stitching is necessary. Read older pages, put raw
events in chronological order, then apply snapshots as replacements and deltas
as appends; do not apply an older page directly over a newer rendered message.
Legacy/unidentified fragments and non-message events are not combined.

### Consumer change from #814 / #818

Consumers may now enable coalescing without receiving partial-message synthetic
snapshots, but must accept raw deltas in coalesced pages. Rebuild a message from
chronologically ordered pages when prepending history. Handle `event_truncated`
as an explicit gap, not as message text or a request to retry. The byte budget
is soft for one event; keep a 1 MiB receive allowance plus envelope overhead.

Visibility rules are unchanged. Orchestrator history first catches up retained
events from upstream (at most 100 upstream pages, otherwise unavailable rather
than a silently stale tail).

CLI: `armada logs <id> --tail [n]` (default 100), optionally `--follow`/`--json`.
Tail cannot combine with `--all` or `--since`. Follow switches from the initial
backward page to forward polling at its newest cursor.

## Historical measurement

The #814 synthetic delta-only coalescing measurement no longer describes the
safe contract: delta-only windows now retain raw events rather than collapsing
them into a partial snapshot.
