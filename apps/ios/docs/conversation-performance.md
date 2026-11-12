# Conversation opening: evidence and profiling

Refs #971. Server-only latency is not app opening latency. The owner measured
sandbox/detail at 430 ms and logs/read at 375 ms; these are supplied observations,
not measurements reproduced in this Linux sandbox.

## Opening-path audit

- The conversation view creates its model and starts detail loading. While that
  async read is pending, the loading-phase transcript starts independent follow
  and state-watch tasks. The app does not await detail before starting history.
- A cold transcript requests one backward/latest page, publishes it, and then
  follows its forward cursor. It does not download all older history on open.
  Existing ArmadaKit tests assert this request/render order.
- A warm open shows the session's raw snapshot before any catch-up request.
  Before this change it nevertheless re-projected that snapshot and re-parsed all
  its assistant Markdown: only the raw events survived between view instances.
- Projection is detached from the main actor; Markdown parsing is already off
  the main actor. First cold text remains visible before Markdown completes.
  The transcript uses LazyVStack. UIKit layout/SwiftUI frame time is not measured
  by the parsing intervals below.
- This change retains the derived presentation with its exact event window,
  sharing the existing eight-entry LRU and session/organization/access-denial
  invalidation. Cursor-only progress preserves it; changed events invalidate it.
  Late rendering cannot restore a removed or evicted cache entry.

## Automated work-count measurement

The test repeatedOpensReuseTheDerivedPresentationOfALongHistory opens a
2,000-event snapshot through 20 separate loaders and records derived-presentation
builds. Expected result: **one build, 19 reuses**. This measures factory invocations,
not iPhone frame time or a wall-clock speedup. The app's factory performs both
projection and Markdown parsing. Actual cold/warm timing remains a device check.

## Exact macOS / device checks

1. Run apps/ios/scripts/verify.sh; inspect the work-count line in ArmadaKit test
   output. This verifies both app variants but does not boot a simulator.
2. On macOS, profile a Release build on the same device and account as the
   baseline. In Instruments add **Points of Interest / os_signposts** and Time
   Profiler; filter subsystem co.thevibecompany.armada.
3. Open a long sandbox conversation once, navigate back, reopen it 10 times
   without new agent events. Record device/OS, SHA, event count, cold time to
   first text, and median warm time to first text. Compare the same unchanged
   conversation against main before this PR; do not compare different networks.
4. ConversationRequest intervals SandboxDetail and ConversationEvents include
   transport plus decoding. Their nested Decode intervals isolate JSON decoding.
   Check request overlap instead of adding the two durations.
   ConversationPresentation intervals Presentation, Projection, Markdown measure
   the app pipeline. Warm unchanged opens should have Presentation but no new
   Projection/Markdown intervals. No contents, resource IDs or credentials are logged.
5. Cold-open a long history and immediately navigate back before Markdown is
   ready; reopen and verify formatted Markdown finishes rather than staying
   permanently plain/partial. Then append a new assistant reply; reopen and
   verify it appears, Markdown/links and
   tool rows remain correct, and forward catch-up still occurs. Scroll to older
   pages: check ordering, no duplicates, and the scroll anchor.
6. Repeat after switching organizations/signing out and after server access
   denial. No old presentation may survive the existing cache clear. Check
   memory with several long histories: derived data stays with at most eight
   cached conversations, and evicted conversations render afresh.
7. In TestFlight repeat cold/warm opening and scrolling checks. Linux cannot
   run the iOS simulator or certify device timing. A new TestFlight build is
   needed after the batch merges.

Signpost API reference:
[Apple: recording performance data](https://developer.apple.com/documentation/os/recording-performance-data).
No migration, backend setting, production operation or new app capability.
