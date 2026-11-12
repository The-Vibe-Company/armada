# Sidebar sub-text removal — before / after

Refs #1038. This is only the immediate removal of descriptive sentences. The five groups, destinations, icons and active styling stay unchanged; the proposed three-group structure is a separate draft, not part of #1152.

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
