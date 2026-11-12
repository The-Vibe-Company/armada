# Tools detail panel — issue #1153, Tools slice

Every image shows **before left / after right** using the existing mock registry (no real accounts, keys or provider calls).

| Viewport | Light | Dark |
| --- | --- | --- |
| Desktop 1280 × 844 | [Compare](tools-1280-light.jpg) | [Compare](tools-1280-dark.jpg) |
| Phone 390 × 844 | [Compare](tools-390-light.jpg) | [Compare](tools-390-dark.jpg) |

Before: Tools in its existing unopted inline mode, captured with the shared panel implementation's `detailPanel` opt-in disabled. After: the same mock Alice Linear detail, now opted into the right-hand modal. Native screenshot capture finishes the animation, not a timing sleep. Phone capture scrolls the chosen row into view before opening it; opening must not change that scroll position.

`e2e/tools-panel.e2e.ts` opens each detail, verifies unchanged list geometry and selected-row highlight, focus in the modal and full width on phones, then presses Escape and verifies the modal is hidden, the row regains focus and the URL closes. Its separate history sequence exercises browser Back, close button, outside dismissal, direct URL reload, J/K and nested destructive confirmation (Escape and Back). The real OAuth workflow regression also closes/reloads its returned detail without reopening it from a stale success notice.

The inherited inline mode has no desktop modal; the new desktop modal assertion fails there. The nested-Back regression also fails before the ToolPanel dialog-lifetime fix, leaving its Delete confirmation visible after Back.
