# Sandbox thread fidelity evidence (#2511)

Captured in this delivery session using Playwright Chromium 1254, the prototype served with `python3 -m http.server 8091 --directory docs/design/refonte-2026-11-16`, and fixture dashboard `bun run dev`. Linux libraries and font configuration were supplied under `/tmp`; no deployed service or provider was used.

The fixture is Acme, signed in as Alice. Working uses the default recorded prompt/message/tool events. Other lifecycle captures change only the sandbox status with the existing fixture lifecycle endpoint; the retained history is unchanged. These are comparisons of layout/state controls, not identical task content. Prototype phone rows were selected by dispatching their click event because the prototype overlay intercepts pointer input.

| State / viewport / theme | Prototype | Fixture |
| --- | --- | --- |
| working / 1440×900 / dark | ![Prototype working-desktop-dark](prototype-working-desktop-dark.png) | ![Fixture working-desktop-dark](fixture-working-desktop-dark.png) |
| working / 1440×900 / light | ![Prototype working-desktop-light](prototype-working-desktop-light.png) | ![Fixture working-desktop-light](fixture-working-desktop-light.png) |
| working / 390×844 / dark | ![Prototype working-phone-dark](prototype-working-phone-dark.png) | ![Fixture working-phone-dark](fixture-working-phone-dark.png) |
| working / 390×844 / light | ![Prototype working-phone-light](prototype-working-phone-light.png) | ![Fixture working-phone-light](fixture-working-phone-light.png) |
| waiting / 1440×900 / dark | ![Prototype waiting-desktop-dark](prototype-waiting-desktop-dark.png) | ![Fixture waiting-desktop-dark](fixture-waiting-desktop-dark.png) |
| waiting / 1440×900 / light | ![Prototype waiting-desktop-light](prototype-waiting-desktop-light.png) | ![Fixture waiting-desktop-light](fixture-waiting-desktop-light.png) |
| waiting / 390×844 / dark | ![Prototype waiting-phone-dark](prototype-waiting-phone-dark.png) | ![Fixture waiting-phone-dark](fixture-waiting-phone-dark.png) |
| waiting / 390×844 / light | ![Prototype waiting-phone-light](prototype-waiting-phone-light.png) | ![Fixture waiting-phone-light](fixture-waiting-phone-light.png) |
| stopped / 1440×900 / dark | ![Prototype stopped-desktop-dark](prototype-stopped-desktop-dark.png) | ![Fixture stopped-desktop-dark](fixture-stopped-desktop-dark.png) |
| stopped / 1440×900 / light | ![Prototype stopped-desktop-light](prototype-stopped-desktop-light.png) | ![Fixture stopped-desktop-light](fixture-stopped-desktop-light.png) |
| stopped / 390×844 / dark | ![Prototype stopped-phone-dark](prototype-stopped-phone-dark.png) | ![Fixture stopped-phone-dark](fixture-stopped-phone-dark.png) |
| stopped / 390×844 / light | ![Prototype stopped-phone-light](prototype-stopped-phone-light.png) | ![Fixture stopped-phone-light](fixture-stopped-phone-light.png) |
| failed / 1440×900 / dark | ![Prototype failed-desktop-dark](prototype-failed-desktop-dark.png) | ![Fixture failed-desktop-dark](fixture-failed-desktop-dark.png) |
| failed / 1440×900 / light | ![Prototype failed-desktop-light](prototype-failed-desktop-light.png) | ![Fixture failed-desktop-light](fixture-failed-desktop-light.png) |
| failed / 390×844 / dark | ![Prototype failed-phone-dark](prototype-failed-phone-dark.png) | ![Fixture failed-phone-dark](fixture-failed-phone-dark.png) |
| failed / 390×844 / light | ![Prototype failed-phone-light](prototype-failed-phone-light.png) | ![Fixture failed-phone-light](fixture-failed-phone-light.png) |

## Delivered

The shell owns the sole breadcrumb and adjacent status. Page-owned authorized actions are portalled to the shell. Details use an accessible icon toggle. Both cloud and Docker threads omit the redundant launch title block, and the conversation omits its extra heading/live badge while retaining conversation selection when applicable. Fact values use a consistent left-aligned second column. Full UUIDs remain available as breadcrumb tooltips.

## Validation

- `bun run lint`: passes, with the pre-existing routines CSS specificity warning.
- `bun run typecheck`: passes.
- `bun test apps/dashboard/test/chat.test.ts apps/dashboard/test/composer.test.ts`: 14 pass.
- Playwright against the existing fixture development server, temporary config overriding only server startup: updated live-refresh and stop/resume journeys (`sandboxes.e2e.ts:147` and `:174`): 2 pass.
- Independent review-code-dev Alibaba review: six source/journey files reviewed; reported static findings fixed and re-reviewed. Full acceptance remains incomplete.

## Gaps — not acceptance evidence

- Composer model/effort remain in the disclosure, and the existing Steer / Send as new turn controls remain. Queue is a different contract; no queue semantics or launch-bound harness/tools switches were invented.
- No completed matrix for Large organization, expired lifecycle, edited-file diff shown/hidden, command results, or pushed/running lines. Existing prototype working screenshots include its rich diff/command/push blocks; the default fixture history does not exercise those blocks.
- Phone shell and composer still differ visibly from the prototype. These captures do not establish element-by-element fidelity.
- The full dashboard journeys have not been run; only the two updated thread journeys were run.

Migration files: none. Deployment prerequisites: none added. No deployments, production reads/writes, or migrations performed.
