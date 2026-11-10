# Model selection investigation (#890)

Status: blocked on a redacted native recording; no runtime fix is delivered here.

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

## Recording needed before closing the ticket

The authorized coordinator check should capture one controlled request using
the same account and selection as the production discrepancy:

1. Original Armada request and Boat prompt request/receipt/run status.
2. Native Claude argv, specifically the model argument.
3. System/init, fallback notices (including scope), root response model and
   final result, preserving IDs needed to distinguish root and subagent work.
4. Explicit markers for truncation or absent evidence.

Exclude tokens, auth files, environment dumps and private prompt history.
Do not manufacture a native stream from the SDK's type declarations.

The implementation must persist the request per prompt (including send
overrides), retain the next-send default, and expose an unknown observed
model as unknown. A closed selection-failure reason must warn that work may
already have occurred and must not cause an automatic retry. Root/subagent,
partial, retracted and alias evidence needs a defined interpretation based on
real recording fields, shared by every client. The issue's acceptance criteria
remain open until implementation and recording-based regression checks pass.
