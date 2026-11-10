# Subscription usage investigation (#873)

## What main actually does

The issue's migration reference is stale: `20261110120300_native_auth.sql`
creates native auth ownership/state, not usage storage. No `model_auth_usage`
table exists on the inspected main. `createModelUsageApi` keeps a maximum of
1,000 sandbox/account/version cache entries in process memory. The dashboard
requests `creds/accounts/usage` separately from the account list. Reads scan
up to 500 private native events, with a five-second budget, without inference.
They require an active account and an authorized current-version sandbox pin.
Restarting the server loses its cache. No eligible pin or no emitted reading
means unavailable, **not** zero usage.

The runtime forwards Claude `assistant.usage_report` (a local `/usage` report)
and Codex `account/rateLimits/updated`; an already running Codex app-server also
permits `account/rateLimits/read`. An ordinary Claude turn does not necessarily
emit a structured profile allowance report. API-key billing has no subscription
allowance. These are code-path explanations, not a diagnosis from production:
no production account, credential, logs or database was inspected.

## Sources (inspected 2026-11-10)

| Source | Harness / fields | Reliability | Safe Armada acquisition / cost |
| --- | --- | --- | --- |
| Claude SDK 0.3.319 declarations and Armada `packages/agent-runtime/src/claude.ts` | `usage_report.rate_limits`, percentage, ISO reset, extra usage | Experimental SDK local-command report; not promised on every turn | Existing private sandbox event stream; no new inference |
| Claude rate-limit events / subscription response headers | utilization, status, resets; not token spending | Diagnostic signal, not a guaranteed complete session/week account snapshot | Only what native harness emits; do not send a model request just to inspect headers |
| Claude `/status` and statusline | Identity/session context; token context usage is not plan allowance | Never convert context percentage or API cost to subscription percentage | Do not scrape terminal text or infer allowance |
| Codex app-server account limits | primary/secondary usedPercent, windowDurationMins, resetsAt; multiple meters, credits | Native protocol; pinned harness version still matters | Existing notifications/read inside user's running app-server; no inference |
| Codex API response headers/events | `x-codex-*-used-percent`, window-minutes, reset-at; `codex.rate_limits` | Native source implementation, not an independent public HTTP contract | Let Codex own auth/transport and consume normalized app-server events |
| CodexBar Claude OAuth fetcher | `/api/oauth/usage`, OAuth bearer + beta header, profile-scoped access, 401/429 handling | Reverse-engineered endpoint; optional query and user-agent workarounds demonstrate fragility | Not adopted: adds server OAuth traffic, scopes and refresh ownership hazards; no inference but network/rate-limit cost |

Pinned source code read (no source copied):

- [Codex rate-limit parser, 77fde36ae112437a8ce23e752209099ee04a0d50](https://github.com/openai/codex/blob/77fde36ae112437a8ce23e752209099ee04a0d50/codex-rs/codex-api/src/rate_limits.rs).
- [CodexBar OAuth fetcher, 7447bc77c2497323d9c41e40164ce705533493c8](https://github.com/steipete/CodexBar/blob/7447bc77c2497323d9c41e40164ce705533493c8/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift).
- Existing pinned SDK/protocol and Magpie references: [model-usage.md](model-usage.md).

A percentage is reported by the provider; it is not computed by dividing token
counts by an imagined plan cap. Snapshots are last-known observations, not live
balances. Retained window timestamps must not advance on sparse unrelated events.

## Production check (owner only; not performed here)

Run a turn with each subscription account; read the Harness account's usage API.
For Claude, check whether a structured native usage report actually appears;
absence must stay explicitly unknown. Verify percent/reset and observedAt against
the native session. Confirm API-key accounts say no subscription allowance.
Never paste raw native auth/usage envelopes into public logs.
