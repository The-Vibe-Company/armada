# Sandbox thread fidelity evidence (#2511)

Current-session Playwright Chromium 1254 captures of prototype `Armada.dc.html`, served with `python3 -m http.server 8091 --directory docs/design/refonte-2026-11-16`, and fixture dashboard `bun run dev`. Source: `6eba3b417b3d788bb2a4d3808897939364fac7db`. Linux libraries/fonts were supplied locally under `/tmp`. No deployed service or provider was used.

The default organization is Acme, signed in as Alice. Working uses the default recorded events. Waiting/stopped/failed use the existing fixture lifecycle/event endpoints, with completed or failed prompt outcomes and retained tool results. Starting retains queued/previous history. The diff and command-results captures use recorded Edit old/new payloads and Bash command/result events. The command-results captures expand successful test/push output and retain a running PR command. Large captures use its existing seeded owner-visible sandboxes. An expired deadline is a lifecycle notice, not an invented `expired` sandbox status. Its prototype cell is empty because the prototype offers no dedicated expired thread.

These compare layout and supported controls across different task content; they do not assert identical business data. Prototype phone rows were selected by dispatching click events because its fixed-width overlay intercepts pointer input. The prototype itself clips horizontally at 390px; the fixture retains a usable phone layout.

| Organization / state / size / theme | Prototype | Fixture |
| --- | --- | --- |
| Acme / working / 1440×900 / dark | ![Prototype working-desktop-dark](prototype-working-desktop-dark.png) | ![Fixture Acme working-desktop-dark](fixture-working-desktop-dark.png) |
| Acme / working / 1440×900 / light | ![Prototype working-desktop-light](prototype-working-desktop-light.png) | ![Fixture Acme working-desktop-light](fixture-working-desktop-light.png) |
| Acme / working / 390×844 / dark | ![Prototype working-phone-dark](prototype-working-phone-dark.png) | ![Fixture Acme working-phone-dark](fixture-working-phone-dark.png) |
| Acme / working / 390×844 / light | ![Prototype working-phone-light](prototype-working-phone-light.png) | ![Fixture Acme working-phone-light](fixture-working-phone-light.png) |
| Acme / waiting / 1440×900 / dark | ![Prototype waiting-desktop-dark](prototype-waiting-desktop-dark.png) | ![Fixture Acme waiting-desktop-dark](fixture-waiting-desktop-dark.png) |
| Acme / waiting / 1440×900 / light | ![Prototype waiting-desktop-light](prototype-waiting-desktop-light.png) | ![Fixture Acme waiting-desktop-light](fixture-waiting-desktop-light.png) |
| Acme / waiting / 390×844 / dark | ![Prototype waiting-phone-dark](prototype-waiting-phone-dark.png) | ![Fixture Acme waiting-phone-dark](fixture-waiting-phone-dark.png) |
| Acme / waiting / 390×844 / light | ![Prototype waiting-phone-light](prototype-waiting-phone-light.png) | ![Fixture Acme waiting-phone-light](fixture-waiting-phone-light.png) |
| Acme / starting / 1440×900 / dark | ![Prototype starting-desktop-dark](prototype-starting-desktop-dark.png) | ![Fixture Acme starting-desktop-dark](fixture-starting-desktop-dark.png) |
| Acme / starting / 1440×900 / light | ![Prototype starting-desktop-light](prototype-starting-desktop-light.png) | ![Fixture Acme starting-desktop-light](fixture-starting-desktop-light.png) |
| Acme / starting / 390×844 / dark | ![Prototype starting-phone-dark](prototype-starting-phone-dark.png) | ![Fixture Acme starting-phone-dark](fixture-starting-phone-dark.png) |
| Acme / starting / 390×844 / light | ![Prototype starting-phone-light](prototype-starting-phone-light.png) | ![Fixture Acme starting-phone-light](fixture-starting-phone-light.png) |
| Acme / stopped / 1440×900 / dark | ![Prototype stopped-desktop-dark](prototype-stopped-desktop-dark.png) | ![Fixture Acme stopped-desktop-dark](fixture-stopped-desktop-dark.png) |
| Acme / stopped / 1440×900 / light | ![Prototype stopped-desktop-light](prototype-stopped-desktop-light.png) | ![Fixture Acme stopped-desktop-light](fixture-stopped-desktop-light.png) |
| Acme / stopped / 390×844 / dark | ![Prototype stopped-phone-dark](prototype-stopped-phone-dark.png) | ![Fixture Acme stopped-phone-dark](fixture-stopped-phone-dark.png) |
| Acme / stopped / 390×844 / light | ![Prototype stopped-phone-light](prototype-stopped-phone-light.png) | ![Fixture Acme stopped-phone-light](fixture-stopped-phone-light.png) |
| Acme / failed / 1440×900 / dark | ![Prototype failed-desktop-dark](prototype-failed-desktop-dark.png) | ![Fixture Acme failed-desktop-dark](fixture-failed-desktop-dark.png) |
| Acme / failed / 1440×900 / light | ![Prototype failed-desktop-light](prototype-failed-desktop-light.png) | ![Fixture Acme failed-desktop-light](fixture-failed-desktop-light.png) |
| Acme / failed / 390×844 / dark | ![Prototype failed-phone-dark](prototype-failed-phone-dark.png) | ![Fixture Acme failed-phone-dark](fixture-failed-phone-dark.png) |
| Acme / failed / 390×844 / light | ![Prototype failed-phone-light](prototype-failed-phone-light.png) | ![Fixture Acme failed-phone-light](fixture-failed-phone-light.png) |
| Acme / diff-hidden / 1440×900 / dark | ![Prototype diff-hidden-desktop-dark](prototype-diff-hidden-desktop-dark.png) | ![Fixture Acme diff-hidden-desktop-dark](fixture-diff-hidden-desktop-dark.png) |
| Acme / diff-hidden / 1440×900 / light | ![Prototype diff-hidden-desktop-light](prototype-diff-hidden-desktop-light.png) | ![Fixture Acme diff-hidden-desktop-light](fixture-diff-hidden-desktop-light.png) |
| Acme / diff-hidden / 390×844 / dark | ![Prototype diff-hidden-phone-dark](prototype-diff-hidden-phone-dark.png) | ![Fixture Acme diff-hidden-phone-dark](fixture-diff-hidden-phone-dark.png) |
| Acme / diff-hidden / 390×844 / light | ![Prototype diff-hidden-phone-light](prototype-diff-hidden-phone-light.png) | ![Fixture Acme diff-hidden-phone-light](fixture-diff-hidden-phone-light.png) |
| Acme / diff-shown / 1440×900 / dark | ![Prototype diff-shown-desktop-dark](prototype-diff-shown-desktop-dark.png) | ![Fixture Acme diff-shown-desktop-dark](fixture-diff-shown-desktop-dark.png) |
| Acme / diff-shown / 1440×900 / light | ![Prototype diff-shown-desktop-light](prototype-diff-shown-desktop-light.png) | ![Fixture Acme diff-shown-desktop-light](fixture-diff-shown-desktop-light.png) |
| Acme / diff-shown / 390×844 / dark | ![Prototype diff-shown-phone-dark](prototype-diff-shown-phone-dark.png) | ![Fixture Acme diff-shown-phone-dark](fixture-diff-shown-phone-dark.png) |
| Acme / diff-shown / 390×844 / light | ![Prototype diff-shown-phone-light](prototype-diff-shown-phone-light.png) | ![Fixture Acme diff-shown-phone-light](fixture-diff-shown-phone-light.png) |
| Acme / expired / 1440×900 / dark | No dedicated prototype state | ![Fixture Acme expired-desktop-dark](fixture-expired-desktop-dark.png) |
| Acme / expired / 1440×900 / light | No dedicated prototype state | ![Fixture Acme expired-desktop-light](fixture-expired-desktop-light.png) |
| Acme / expired / 390×844 / dark | No dedicated prototype state | ![Fixture Acme expired-phone-dark](fixture-expired-phone-dark.png) |
| Acme / expired / 390×844 / light | No dedicated prototype state | ![Fixture Acme expired-phone-light](fixture-expired-phone-light.png) |
| Large / working / 1440×900 / dark | ![Prototype working-desktop-dark](prototype-working-desktop-dark.png) | ![Fixture Large working-desktop-dark](fixture-large-working-desktop-dark.png) |
| Large / working / 1440×900 / light | ![Prototype working-desktop-light](prototype-working-desktop-light.png) | ![Fixture Large working-desktop-light](fixture-large-working-desktop-light.png) |
| Large / working / 390×844 / dark | ![Prototype working-phone-dark](prototype-working-phone-dark.png) | ![Fixture Large working-phone-dark](fixture-large-working-phone-dark.png) |
| Large / working / 390×844 / light | ![Prototype working-phone-light](prototype-working-phone-light.png) | ![Fixture Large working-phone-light](fixture-large-working-phone-light.png) |
| Large / waiting / 1440×900 / dark | ![Prototype waiting-desktop-dark](prototype-waiting-desktop-dark.png) | ![Fixture Large waiting-desktop-dark](fixture-large-waiting-desktop-dark.png) |
| Large / waiting / 1440×900 / light | ![Prototype waiting-desktop-light](prototype-waiting-desktop-light.png) | ![Fixture Large waiting-desktop-light](fixture-large-waiting-desktop-light.png) |
| Large / waiting / 390×844 / dark | ![Prototype waiting-phone-dark](prototype-waiting-phone-dark.png) | ![Fixture Large waiting-phone-dark](fixture-large-waiting-phone-dark.png) |
| Large / waiting / 390×844 / light | ![Prototype waiting-phone-light](prototype-waiting-phone-light.png) | ![Fixture Large waiting-phone-light](fixture-large-waiting-phone-light.png) |
| Large / stopped / 1440×900 / dark | ![Prototype stopped-desktop-dark](prototype-stopped-desktop-dark.png) | ![Fixture Large stopped-desktop-dark](fixture-large-stopped-desktop-dark.png) |
| Large / stopped / 1440×900 / light | ![Prototype stopped-desktop-light](prototype-stopped-desktop-light.png) | ![Fixture Large stopped-desktop-light](fixture-large-stopped-desktop-light.png) |
| Large / stopped / 390×844 / dark | ![Prototype stopped-phone-dark](prototype-stopped-phone-dark.png) | ![Fixture Large stopped-phone-dark](fixture-large-stopped-phone-dark.png) |
| Large / stopped / 390×844 / light | ![Prototype stopped-phone-light](prototype-stopped-phone-light.png) | ![Fixture Large stopped-phone-light](fixture-large-stopped-phone-light.png) |
| Large / failed / 1440×900 / dark | ![Prototype failed-desktop-dark](prototype-failed-desktop-dark.png) | ![Fixture Large failed-desktop-dark](fixture-large-failed-desktop-dark.png) |
| Large / failed / 1440×900 / light | ![Prototype failed-desktop-light](prototype-failed-desktop-light.png) | ![Fixture Large failed-desktop-light](fixture-large-failed-desktop-light.png) |
| Large / failed / 390×844 / dark | ![Prototype failed-phone-dark](prototype-failed-phone-dark.png) | ![Fixture Large failed-phone-dark](fixture-large-failed-phone-dark.png) |
| Large / failed / 390×844 / light | ![Prototype failed-phone-light](prototype-failed-phone-light.png) | ![Fixture Large failed-phone-light](fixture-large-failed-phone-light.png) |
| Large / expired / 1440×900 / dark | No dedicated prototype state | ![Fixture Large expired-desktop-dark](fixture-large-expired-desktop-dark.png) |
| Large / expired / 1440×900 / light | No dedicated prototype state | ![Fixture Large expired-desktop-light](fixture-large-expired-desktop-light.png) |
| Large / expired / 390×844 / dark | No dedicated prototype state | ![Fixture Large expired-phone-dark](fixture-large-expired-phone-dark.png) |
| Large / expired / 390×844 / light | No dedicated prototype state | ![Fixture Large expired-phone-light](fixture-large-expired-phone-light.png) |

| Organization / state / size / theme | Prototype | Fixture |
| --- | --- | --- |
| Acme / command results, push and running / 1440×900 / dark | ![Prototype command-results-desktop-dark](prototype-command-results-desktop-dark.png) | ![Fixture command-results-desktop-dark](fixture-command-results-desktop-dark.png) |
| Acme / command results, push and running / 1440×900 / light | ![Prototype command-results-desktop-light](prototype-command-results-desktop-light.png) | ![Fixture command-results-desktop-light](fixture-command-results-desktop-light.png) |
| Acme / command results, push and running / 390×844 / dark | ![Prototype command-results-phone-dark](prototype-command-results-phone-dark.png) | ![Fixture command-results-phone-dark](fixture-command-results-phone-dark.png) |
| Acme / command results, push and running / 390×844 / light | ![Prototype command-results-phone-light](prototype-command-results-phone-light.png) | ![Fixture command-results-phone-light](fixture-command-results-phone-light.png) |
| Acme / lower command results, push and running / 1440×900 / dark | ![Prototype commands desktop-dark](prototype-command-results-desktop-dark.png) | ![Fixture lower commands desktop-dark](fixture-command-results-lower-desktop-dark.png) |
| Acme / lower command results, push and running / 1440×900 / light | ![Prototype commands desktop-light](prototype-command-results-desktop-light.png) | ![Fixture lower commands desktop-light](fixture-command-results-lower-desktop-light.png) |
| Acme / lower command results, push and running / 390×844 / dark | ![Prototype commands phone-dark](prototype-command-results-phone-dark.png) | ![Fixture lower commands phone-dark](fixture-command-results-lower-phone-dark.png) |
| Acme / lower command results, push and running / 390×844 / light | ![Prototype commands phone-light](prototype-command-results-phone-light.png) | ![Fixture lower commands phone-light](fixture-command-results-lower-phone-light.png) |

## Delivered

- One shell breadcrumb with adjacent status; full UUID available as a tooltip. Page-owned controls retain their existing authorization checks.
- Extend invokes the existing time-extension action. Stop and an accessible icon details toggle live in the header.
- Both cloud and Docker threads omit redundant launch-title and conversation/live headers. Multi-conversation selection remains available.
- Fact values share a left-aligned second column. Model and effort selectors are visible directly in the composer; launch-pinned models remain read-only with their reason.
- On a phone, organization/search/launch controls are in the existing navigation drawer. The mobile details portal replaces history without displacing the composer, even when nested disclosures remain open. Escape returns focus to Navigation.

## Validation

- `bun run lint`: passes, with the existing routines CSS specificity warning.
- `bun run typecheck`: passes.
- `bun test apps/dashboard/test/chat.test.ts apps/dashboard/test/composer.test.ts apps/dashboard/test/model-picker.test.ts`: 18 pass.
- Playwright against the existing fixture development server, temporary config overriding only server startup: three thread-control journeys (`sandboxes.e2e.ts:147`, `:174`, `:372`) pass. All seven journeys in `sandbox-viewport.e2e.ts` pass, including 390×664, independent history scrolling, nested details, custom-model resizing and clipped-control checks.
- Live Large-phone checks: opening Navigation and pressing Escape restores focus to its opener.
- One independent review-code-dev Alibaba review, resumed after fixes: all thirteen text files reviewed; no remaining static findings. The screenshot matrix and Gaps remain for coordinator visual acceptance.

## Gaps

- Queue is a different server contract from the existing Send as new turn. Existing Steer / New turn actions retain their names and behavior instead of fabricating Queue semantics; the prototype's Steer/Queue mode selector is not implemented.
- Harness/tools are launch-bound; no invented turn-level switches. Launch-pinned model/effort settings stay read-only.
- Completed tool events lack completion timestamps, so groups show steps instead of fabricated durations. Edited files derive only from recorded Edit payloads; no fabricated aggregate file totals. Git push appears as a recorded command/result, not an invented domain event.
- No dedicated expired-thread state is offered by the prototype. Expired-deadline captures show the real existing notice.
- Full dashboard journeys were not run. The relevant thread-control and viewport journeys above were run. These captures document remaining visual differences and are not a claim of coordinator acceptance.

Migration files: none. Deployment prerequisites: none added. No deployments, production operations, or migrations performed.

The coordinator merged the source slices as #2514 (header/details approved) and #2517 (composer pickers approved; phone layout not yet viewed). The remaining evidence PR adds captures; those comments are not claimed as full visual acceptance.
