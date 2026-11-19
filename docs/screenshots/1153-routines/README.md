# Routines detail panel — issue #1153, Routines slice

Before: fresh main's unopted Routines detail. After: the same page with `detailPanel` enabled. Viewport screenshots finish animation and wait for the existing mock history result; no timing sleeps or offscreen full-page fixed-sheet artifacts. The row is scrolled into view before its geometry is measured.

`e2e/routines-panel.e2e.ts` checks unchanged row geometry, selected highlight, focus inside the panel, full width on phones, then presses Escape and verifies hidden panel, row focus and closed URL for every capture. A separate sequence covers native Back, reload then Back, close button, outside dismissal, one Back to the preceding page after repeated cycles, direct-link reload and J/K navigation. Existing routines tests retain lazy-history reads, hidden sandbox link authorization, creation in a centred dialog, enable/pause and stale-version behavior.

Desktop modal assertions fail against inherited inline mode, as expected. This slice does not change routine scheduling, state mutation, history access rules or sandbox conversations.
