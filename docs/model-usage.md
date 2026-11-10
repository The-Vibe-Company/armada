# Private per-account native quota telemetry (#624)

## Scope and prerequisites

This change owns passive native quota collection, private-event filtering and the
read-only usage API. Native login/import, encrypted OAuth state, ownership,
renewal, hydration and exec redaction belong to #604.

Requires #603's canonical named account IDs/version and sandbox pins. There is no
quota migration: metadata/cursors are bounded in-memory caches. The API does not
duplicate native auth ownership or refresh credentials. Its tests seed accounts
through #603's existing authenticated account-set flow, not #604's new CLI.

Only the integration owner merges, applies production migrations or deploys.

## Canonical read contract for #618

Authenticated POST /api/v1/creds/accounts/usage accepts:

    {"id": "<account UUID>", "sandboxId": "<optional sandbox UUID>"}

Without sandboxId, the server selects an authorized existing current-version pin,
or returns unavailable. An explicit sandboxId constrains the read; an invisible,
deleted or stale pin returns 404, not another account's data. Personal accounts
are readable only by their owner; org accounts require current scoped membership.
Normal sandbox visibility is independently enforced. Cache hits, completed reads,
and failed/timed-out reads recheck authorization.

Safe response:

    {
      "accountId": "<account UUID>",
      "version": 1,
      "status": "fresh",
      "observedAt": "2026-11-09T12:00:00.000Z",
      "windows": [{
        "id": "session-0", "label": "session", "kind": "session",
        "usedPercent": 25, "resetsAt": null
      }],
      "extraUsage": {
        "enabled": true, "currency": "EUR",
        "usedMinor": 125, "limitMinor": 2000,
        "used": 1.25, "limit": 20
      }
    }

Statuses are fresh, stale, unavailable or error. observedAt and percentages/reset
times can be null. Windows also retain optional native group, severity, active,
model and surface metadata. No native envelope, auth state or refresh token is
returned. No source returns unavailable with null observedAt and empty windows;
it never means zero remaining allowance.

The id/label and major-unit used/limit fields match #618's consumer additively.
Canonical source amounts remain usedMinor/limitMinor. Major units are derived
only for a reported recognized currency, using its currency exponent, never an
assumed USD/cent conversion. Unknown currency/amount means null, not zero.
Session API-cost estimates are not subscription balances.

#618 currently hides extra-only spend when no windows exist; the producer still
preserves that reported spend without inventing an allowance window. Native
terminal capability fields are produced separately by #604:

    {"hostedOAuth": false, "nativeCLI": {"codex_auth": "armada creds login codex"}}

The terminal value is a base command; #618 adds its quoted --name itself.

## Native credits and metered buckets (v3)

Native Codex credit counts are separate from Claude extra-usage money:

    "credits": {"hasCredits": false, "unlimited": false, "balance": "0"}

The credits object appears only for a valid native source snapshot: exact boolean
flags and a decimal balance string or null. Zero, trailing decimal zeros and
large decimal precision are preserved as strings, never coerced to numbers.
Unlimited is the reported boolean, not an inferred balance. Missing/malformed
credit metadata is omitted; no USD, monetary unit or fake zero is supplied.
Credit-only native data is valid even with no percentage windows.

Every actual rateLimitsByLimitId entry is retained in buckets, including a meter
that reports only credits:

    {
      "sourceId": "review",
      "label": "Review",
      "windows": [{"id": "primary", "kind": "primary", "sourceId": "review",
                   "label": "primary", "usedPercent": 42, "resetsAt": null,
                   "observedAt": "2026-11-09T12:00:00.000Z"}],
      "credits": {"hasCredits": true, "unlimited": false, "balance": "12.3400"},
      "creditsObservedAt": "2026-11-09T12:00:00.000Z"
    }

The sourceId is the actual native meter-map key; compatibility snapshots without
an ID use null, not an invented identity. Bucket balances are not summed.
Top-level credits is the compatibility alias, with creditsSourceId and
creditsObservedAt; consumers can render each bucket independently. The sanitized
compatibility object preserves the original single-bucket view. Flat windows
retain primary/secondary IDs and namespace additional meter IDs, while buckets
preserve every map view even if it differs from compatibility.

Sparse native updates retain previously observed nullable account metadata and
other meter buckets with their original timestamps. They do not promote an old
balance/window to a new observation. Aggregate status is stale if a retained
component is stale. A full native snapshot is authoritative for its current set.
Earned rate-limit-reset credits are a different protocol object, not a workspace
balance, and are not substituted for native credits.

Within an already-running eligible native ChatGPT app-server, the collector can
read account/rateLimits/read without inference. This does not start a process or
prompt just for an API usage request. The optional read is bounded and cannot
kill a coding turn on quota failure. Its full response and account notifications
are private; only allowlisted normalized metadata reaches this API.

## Native sources and privacy

- Claude SDK 0.3.322 usage_report retains provider rows, ISO resets and optional
  extra_usage in minor currency units. Null rows clear prior allowance rather
  than preserving a fake fresh value. A model-only setup token reports unavailable.
- Native rate_limit_event remains private diagnostic data. Header utilization is
  not promoted to a profile reading that a model-only token cannot query.
- Codex 0.167.0 account/rateLimits/updated and account/rateLimits/read are account-scoped, not thread-scoped.
  Its windows use native 0–100 percentages and Unix-second reset timestamps.
- Structured reports, account limits, native auth status and system
  local_command_output are omitted from general API/MCP logs. Claude /usage
  fallback assistant/partial/result text is not exposed as ordinary conversation
  text. Unrelated system events and native message identities remain intact.

Reads inspect at most five pages of 100 native events and carry cancellation to
providers. A read has a five-second budget, with a bounded one-second fresh-role
check after read errors. Late responses cannot advance the cache. Cache reads
last 15 seconds; observations older than 60 seconds are stale. Last-known
timestamps are retained on error. Genuinely future-dated records are ignored
while advancing the cursor, rather than claiming a future observation is current.

No prompt, inference, auto account switch, private OAuth scraping or cross-provider
traffic translation is used to query quota. No real provider consent is performed
by tests.

## Pinned research

- [Claude SDKUsageReport](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusagereport),
  checked against installed SDK 0.3.322 declarations.
- [Codex app-server account limits](https://learn.chatgpt.com/docs/app-server),
  checked against the pinned 0.167.0 native schema.
- MIT reference [yetone/magpie, 195d79939e215828c8b1cca73650b1d5c5cb8318](https://github.com/yetone/magpie/tree/195d79939e215828c8b1cca73650b1d5c5cb8318),
  internal/provider/subscription_usage.go and login_usage.go: consulted for
  allowance presentation/cache boundaries; no source code copied.

## Per-sandbox token counters (not subscription allowance)

Per-turn `TurnTokenUsage` preserves harness-native definitions. Codex
`inputTokens` includes `cachedTokens` and `cacheWriteTokens`; the cache fields
are subsets, not additional input. Claude `inputTokens` excludes the separately
reported cache-read and cache-creation tokens. Reasoning tokens, when reported,
are a subset of output. Do not add all columns to calculate unique tokens or
apply one cross-harness pricing formula. Missing fields/totals stay null.

Orchestrator own usage is authoritative from the durably ingested journal,
updated atomically with its cursor. Status polling cannot overwrite a managed
parent's usage snapshot. The first accounting page bootstraps old snapshots
from retained accounting events once; later pages merge only newly accepted
prompt/usage events into compact per-turn state. The JSON snapshot still costs
O(reported turns) to rewrite, but does not reread all retained message/tool events
on every page. Child sums use each child's latest persisted usage observation.

Compute seconds are Armada-observed elapsed running intervals, not provider
billed seconds or CPU time. Boat copies `stoppedAt` only when its API supplies
it; Modal's managed stop records a stop timestamp locally. If either provider
omits it, a confirmed stop uses Armada's observation time as the endpoint rather
than erasing known compute history. This can include polling/stop-confirmation
latency. Legacy unknown starts and missed stop/resume gaps remain unknown.
