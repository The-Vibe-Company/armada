# Model selection investigation (#890)

Status: per-turn requested/observed reporting is implemented. Boat’s model forwarding remains an upstream question.

## Evidence boundaries

The issue records a production request for `claude-fable-5-2` whose response
reported `claude-sonnet-5`. This proves a discrepancy, not why it happened.
Neither subscription entitlement nor refusal fallback is established.

On 2026-11-10 the delivery sandbox attempted this harmless probe:

```sh
boat --no-update --json prompt self --new --provider claude \
  --model claude-fable-5-2 'Reply with the word probe only. Do not use tools.'
```

The local CLI exited 1 with `invalid model "claude-fable-5-2" for provider claude`.
Its model list included `claude-fable-5-1`, but not the requested ID. No turn
receipt or native stream was obtained. This is a different failure boundary
from the accepted production launch and cannot serve as its regression fixture.
No production operations were performed.

## Source trace

- `packages/provider-boat/src/provider.ts` forwards `request.model` into the
  SDK's `promptRequest.model`. This does not prove Boat's native argv.
- `packages/provider-boat/src/native-cwd.ts` preserves Claude's original
  arguments with `"$@"`; it does not capture the actual invocation.
- `packages/provider-boat/src/events.ts` copies response model metadata but
  currently does not establish root-thread provenance.
- `packages/core/src/outcome.ts` treats provider-finished turns as finished
  except for usage-limit and expired-login events. It does not check models.
- `packages/mcp-server/src/turns.ts` reports the sandbox selection, not a
  durable requested/observed model pair for the individual prompt.

## Coordinator capture (2026-11-10 12:35Z)

The authorized production check accepted `claude-fable-5-2`; Armada reported
finished while the main response reported `claude-sonnet-5`. Claude Code
2.1.322’s native session had one `api-request` with `params.model` already
`claude-sonnet-5` and one assistant response with that model. There were no
refusal-fallback notices. Cost metadata additionally named Haiku for title
generation; that is not main-turn model evidence. No settings file or model
environment variable was found in the checked shell. The process had exited,
so native argv was unavailable. The exact normalized Armada logs recording is retained unchanged in
`packages/core/test/fixtures/boat-claude-fable-recording.json`. Native-session
observations above are coordinator supplied, not an independently rerun probe.

This supports selection loss or mapping before the first main API request,
not a refusal-driven fallback. The exact Boat boundary remains unknown.

## Capture checklist for Boat upstream

The authorized coordinator check should capture one controlled request using
the same account and selection as the production discrepancy:

1. Original Armada request and Boat prompt request/receipt/run status.
2. Native Claude argv, specifically the model argument.
3. System/init, fallback notices (including scope), root response model and
   final result, preserving IDs needed to distinguish root and subagent work.
4. Explicit markers for truncation or absent evidence.

Exclude tokens, auth files, environment dumps and private prompt history.
Do not manufacture a native stream from the SDK's type declarations.

The implementation persists the request per prompt (including send
overrides), retains the next-send default, and exposes an unknown observed
model as unknown. Only a positively observed mismatch receives a closed failure reason warning that work may already have occurred;
no automatic retry occurs. Completed root response metadata is used, never
assistant prose or title-generation cost metadata. Partial, nested and
retracted native responses are excluded; aliases are not guessed. Missing or
truncated evidence is neutral unverified, never a failed turn or an error banner.
Legacy turns with no recorded request remain finished. Only decisive complete
terminal evidence is retained per turn
so historical requests are not compared with the sandbox default.

Steer has no model-selection argument and Boat may return a steer-record ID
rather than the actual run ID. A new run without recorded request provenance
is unverified; Armada does not invent its request from the next-send default.

Model-request and observation storage are best-effort telemetry: even a failed
write or logger cannot change accepted work into failed work. Running status
skips evidence and usage history scans; terminal evidence reads backwards to
the target prompt boundary, not from sandbox creation. A missing/incomplete
observation is retried on later reads rather than cached as a permanent result.

The supplied Boat recording has no `parent_tool_use_id`, `is_reverted` or
`is_retracted` at Armada event level. This patch does not infer those Boat fields
or claim to have validated Boat subagent/retraction attribution. Distinct or
ambiguous observed models remain neutral unknown rather than choosing a last
response. Before asserting Boat nested-agent attribution, the coordinator must
run a controlled Boat Claude turn spawning a different-model subagent, capture
redacted `armada logs --all --json` plus status, and verify that only the main
response establishes observed model. No such provider check was run here.
Native Modal Claude's SDK parent metadata is handled separately.

Native aliases and `[1m]` context modifiers are not literal concrete response IDs.
Without an authoritative resolution map they remain neutrally unverified, not
unhonoured selections. Alias/context examples follow the official
[Claude model configuration](https://code.claude.com/docs/en/model-config#model-aliases);
exact `claude-fable-5-2` remains an exact requested ID for the recording regression.
