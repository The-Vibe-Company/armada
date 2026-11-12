# Detail panel comparison — issue #1153

Each image shows **before (left)** and **after (right)** at the same viewport and theme. Data comes only from the existing local mock; no production data or credentials are shown.

Baseline: `25dc636c` (unchanged main when this branch started). After: `3713dbfd` (the reviewed implementation). Production builds, 900px viewport height, animation disabled for capture.

| Page | Desktop light | Desktop dark | Phone light | Phone dark |
| --- | --- | --- | --- | --- |
| Environments | [Compare](environments-1280-light.jpg) | [Compare](environments-1280-dark.jpg) | [Compare](environments-390-light.jpg) | [Compare](environments-390-dark.jpg) |
| Templates | [Compare](templates-1280-light.jpg) | [Compare](templates-1280-dark.jpg) | [Compare](templates-390-light.jpg) | [Compare](templates-390-dark.jpg) |

Escape was exercised after every screenshot: the panel becomes hidden. The browser regression suite also proves focus returns to the selected row, Back closes/Forward reopens, reload preserves selection, J/K changes items, outside click dismisses, and a nested confirmation receives Escape before the detail sheet. Form drafts and pending rebuilds survive closure and breakpoint changes.
