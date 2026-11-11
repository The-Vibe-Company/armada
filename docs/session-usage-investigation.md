# Session usage investigation (#977)

## Verdict (2026-11-11)

Blocked under the feature freeze. The required Boat × Codex non-zero-token
acceptance cannot be delivered by repairing the existing display alone.
Boat's current public event path provides no supported native usage projection.
The missing acquisition/admission work is the subject of paused PR #927 (#883);
this investigation does not import it, implement another collector, or claim
that its unresolved attribution issue is safe. PR #876 concerns subscription
allowance, not session token counters, and is not needed for session display.

No production access, deployment, migration application, or new live turn was
performed. The evidence below is source inspection and replay of existing
recordings, not fresh staging acceptance or proof about every account type.

## Provider × harness × account matrix

Each cell describes the current code path, not eight new live measurements.
“API key” and “subscription” share the session counter path: authentication
does not synthesize counters or turn an allowance percentage into tokens.

| Provider | Harness | API key | Subscription |
| --- | --- | --- | --- |
| Boat | Codex | Existing recorded finished turn has no counters; API totals unknown | Same event path; per-account live evidence unavailable |
| Boat | Claude Code | Same unsupported native projection; no account-specific recording | Existing recorded finished turn has no counters; account type not established by fixture provenance |
| Modal | Codex | Runtime consumes native cumulative totals and emits turn deltas; no account-specific live check | Same counter path; fixture replays 13,136 input, 5 output, 0 cached; account type not established by fixture provenance |
| Modal | Claude Code | Runtime forwards final SDK result/modelUsage; no account-specific live check | Existing subscription recording replays 2 input, 4 output, 19,047 cache creation, 0 cache read |

The Boat Codex recording's account type is also not established by its
provenance. Neither Boat fixture proves that a raw Boat response lacked usage
before normalization. Fresh raw-envelope evidence would be needed before
claiming that a small normalization-only fix suffices.

## Trace and loss boundary

- **Boat:** `packages/provider-boat/src/provider.ts` sends prompts through the
  Boat API and normalizes its public events with `src/events.ts`. Response
  normalization copies text/model/tools, not counters. Other event types retain
  their data. There is no native usage acquisition here. The two normalized
  Boat recordings contain only a finished prompt and a message. Thus the
  server's existing parser has no final usage snapshot to consume.
- **Modal:** `packages/agent-runtime/src/codex.ts` emits
  `armada/turnUsage` from `thread/tokenUsage/updated`. A resumed thread without
  a known baseline deliberately reports null, not a guessed delta.
  `claude.ts` forwards final `result` data including `modelUsage`.
  Missing native fields stay unknown. These counters are distinct from
  account rate-limit/allowance notifications.
- **Server/storage/API:** `reportedTurnUsage` in
  `packages/core/src/sandbox-usage.ts` accepts those two final snapshot shapes.
  `packages/mcp-server/src/turns.ts` collects bounded complete event history
  on terminal status/wait reads and saves `usage_turns` through `data.ts`.
  Failed collection retains previous data; list reads the last observation.
  `public.sandbox_usage` and `withUsageTotals` expose usage; incomplete
  token coverage stays null. Existing replay tests verify this difference:
  Boat has one turn and no token rows; Modal has non-zero token rows.
- **Dashboard:** `apps/dashboard/src/lib/sandbox-cost.ts` reads stored columns
  directly through the user/RLS client, not the status API. It cannot recover
  counters missing upstream. `SandboxCostCard` currently says “No usage
  recorded yet” for an empty token-row set even after a completed Boat turn.
  This is misleadingly temporary wording, but changing it cannot satisfy the
  required non-zero Boat tokens. For reported rows, known model prices produce
  estimated (API-key) or API-equivalent (subscription) costs, never invoices.
  Unknown prices and missing counters have separate states. Cache-write cost
  is omitted by the current pricing helper even when the server records it.
- **CLI/iPhone:** CLI JSON exposes the API response without collecting tokens
  independently. No usage/cost presentation was found in the iPhone Swift
  sources. This PR changes no response schema. Ask the iPhone reviewer to
  confirm existing decoding remains intact when a future repair changes one.

## Paused work and exact missing prerequisite

[PR #927](https://github.com/The-Vibe-Company/armada/pull/927) adds a guest-local
native usage parser and admission bridge, rather than a display fix. Its body
reports an unresolved high-severity delayed-flush boundary problem: stale
cumulative counters can be attributed to the next prompt. It also lacks required
live Boat acceptance evidence. Do not bypass the freeze or copy that collector
here. A supported Boat final-usage event contract with verified raw evidence,
or explicit authorization to resume safe native acquisition with a proven
per-turn boundary, is needed to complete #977.

[PR #876](https://github.com/The-Vibe-Company/armada/pull/876) persists subscription
allowance observations. Allowance percentages are not session tokens or a
per-token bill. It does not unblock the missing Boat counters.

## Validation and acceptance gap

Existing evidence: `packages/mcp-server/test/fixtures/sandbox-usage/README.md`
documents provenance; `usage-recordings.test.ts` replays those recordings.
These are historical captures, not before/after staging evidence for this PR.

Required before declaring #977 complete: one real staging turn each on
Modal × Codex and Boat × Codex, non-zero tokens in the API and rendered
dashboard, before/after evidence in the PR, and iPhone decode review for any
changed responses. None is claimed here. There is no behavioral fix or changed
response in this investigation-only PR; keep it draft and the issue open.
