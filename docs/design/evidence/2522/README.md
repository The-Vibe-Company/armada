# Issue #2522 visual evidence

Templates snapshot badges escaped their cards on a phone and widened the page. The fix bounds every shared catalog
chip (`RowTag`) to its container and truncates the label inside it, keeping the icon. Captured at 390×844 in both
themes against the Large fixture (longest names), prototype first.

Before the fix, the Large Templates page measured `document.documentElement.scrollWidth = 713` at `innerWidth = 390`
in both themes; the first snapshot badge ended at x=706. After the fix every catalog page and the sandbox list
measure 390, and no chip crosses its card's right edge.

Validation: lint, strict typecheck, dashboard unit tests and the new phone journey pass. The journey fails on the
unfixed code (`713` vs `390`) and passes with the fix. No migrations or deployment prerequisites.
