# Issue #2522 visual evidence

Templates snapshot badges escaped their cards on a phone and widened the page. The fix bounds every shared catalog
chip (`RowTag`) to its container and truncates the label inside it, keeping the icon. Captured at 390×844 in both
themes against the Large fixture (longest names), prototype first.

Before the fix, the Large Templates page measured `document.documentElement.scrollWidth = 713` at `innerWidth = 390`
in both themes; the first snapshot badge ended at x=706. After the fix every catalog page and the sandbox list
measure 390, and no chip crosses its card's right edge.

| State | Prototype | Build |
| --- | --- | --- |
| Templates, light | ![Prototype](prototype-templates-390-light.png) | ![Build](build-templates-390-light.png) |
| Templates, dark | ![Prototype](prototype-templates-390-dark.png) | ![Build](build-templates-390-dark.png) |
| Snapshots, light | ![Prototype](prototype-templates-390-light.png) | ![Build](build-snapshots-390-light.png) |
| Snapshots, dark | ![Prototype](prototype-templates-390-dark.png) | ![Build](build-snapshots-390-dark.png) |
| Sandboxes, light | ![Prototype](prototype-templates-390-light.png) | ![Build](build-sandboxes-390-light.png) |
| Sandboxes, dark | ![Prototype](prototype-templates-390-dark.png) | ![Build](build-sandboxes-390-dark.png) |

The prototype has no phone media query (fixed 244px sidebar), so its 390px capture clips the main column; it is
shown for the chip-containment contract (`max-width:100%` with an ellipsized label), not for layout parity. The
Snapshots and Sandboxes rows reuse the Templates prototype capture because the reference has no separate phone
layout for them; the build captures are the evidence for those pages.

Validation: lint, strict typecheck, dashboard unit tests and the new phone journey pass. The journey fails on the
unfixed code (`713` vs `390`) and passes with the fix. No migrations or deployment prerequisites.
