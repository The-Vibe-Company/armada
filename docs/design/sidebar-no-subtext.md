# Sidebar sub-text removal — before / after

Refs #1038. This document records the immediate removal of descriptive sentences in #1152. The captures below are historical evidence of that slice, before the three-group navigation landed.

## Integration with main

The #1155 three-group navigation is now on main. #1152 retains **Run**, **Library** and **Account**, including Models at the unchanged `/harness` route, collapsed navigation and the phone Sheet. There are no descriptive sentences beneath group labels or items. The original screenshot review finding is addressed by the before/after pairs below; they do not depict the current three-group layout.

For desktop, phone and collapsed light/dark captures of the integrated layout, see [the three-group navigation evidence](navigation-structure.md). Relationships remain on pages, not in the menu. No additional navigation redesign is part of this slice.

Baseline: `0324b7bc` (parent of this PR's original `8d70b72b`), rebuilt with its descriptive sidebar component against the same disposable mock. After: #1152 without the descriptive sentences. Light and dark; 1280×900 desktop and 390×844 phone. Desktop crops keep menu text at native size; click a crop for the full viewport. Phone captures show the open navigation Sheet.

The captures were rendered in a real production Next build with this sandbox's pinned Playwright/Chromium. The four baseline cases passed; all four light/dark desktop/phone navigation cases and typecheck passed locally. Images are committed here and embedded in the PR body rather than linking to machine-local files. CI and independent review remain coordinator-owned; no CI polling.

## Light — desktop

| Before | After |
| --- | --- |
| [![before desktop light](sidebar-no-subtext/navigation-no-subtext-before-desktop-light-sidebar.png)](sidebar-no-subtext/navigation-no-subtext-before-desktop-light.png) | [![after desktop light](sidebar-no-subtext/navigation-no-subtext-after-desktop-light-sidebar.png)](sidebar-no-subtext/navigation-no-subtext-after-desktop-light.png) |

## Light — phone

| Before | After |
| --- | --- |
| ![Before phone light](sidebar-no-subtext/navigation-no-subtext-before-phone-light.png) | ![After phone light](sidebar-no-subtext/navigation-no-subtext-after-phone-light.png) |

## Dark — desktop

| Before | After |
| --- | --- |
| [![before desktop dark](sidebar-no-subtext/navigation-no-subtext-before-desktop-dark-sidebar.png)](sidebar-no-subtext/navigation-no-subtext-before-desktop-dark.png) | [![after desktop dark](sidebar-no-subtext/navigation-no-subtext-after-desktop-dark-sidebar.png)](sidebar-no-subtext/navigation-no-subtext-after-desktop-dark.png) |

## Dark — phone

| Before | After |
| --- | --- |
| ![Before phone dark](sidebar-no-subtext/navigation-no-subtext-before-phone-dark.png) | ![After phone dark](sidebar-no-subtext/navigation-no-subtext-after-phone-dark.png) |
