# Sandbox list redesign evidence

Issue #2488. Reference: `design/refonte-2026-11-16`, `docs/design/refonte-2026-11-16/Armada.dc.html`, Sandboxes source lines 335–400.

Eight screenshots show the main baseline and implementation using fixture Acme, at 1440×900 and 390×844, light and dark. The prototype source was inspected; its runtime repeatedly crashed Chromium in this sandbox, so no rendered prototype comparison is claimed.

Validation: `bun run lint`, `bun run typecheck`, `bun test apps/dashboard/src/lib/sandbox-activity.test.ts`, and `git diff --check` passed. Independent OCR-assisted review covered seven changed source/test files with no remaining findings. Local browser prerequisites used Node 24.11.1 and locally extracted Chromium libraries.

`bun run e2e tests/dashboard/sandboxes.e2e.ts`: eight passed, two desktop tests failed with ENGINE_FAILURE during initial navigation (browser/context closed). All six-tab browse/open journeys passed on desktop and phone for Acme and Large (600 sandboxes). Both phone send/stop journeys passed. No CI retries or jobs were added.

Gaps: task text and updated time are absent from authorized list metadata; the existing safe name is shown and Updated omitted. Harness logos and shell/token integration await slice A. Existing advanced filtering/sorting, row actions, costs, preservation notices and access restrictions remain available.
