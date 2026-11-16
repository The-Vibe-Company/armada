Machines now uses separate Cloud providers and Docker hosts catalog sections, with provider tiles, host resource chips, state and one footer action. Drawers keep existing connection, launch, retention, limits, snapshots, technical details and unlink controls reachable. Drawer drafts survive closing; Back/Forward, direct links and keyboard focus are retained.

Closes #2501

Validation: lint, root and dashboard TypeScript (via Bun), 24 targeted unit tests and two updated Machines browser journeys passed against `bun run dev`, retries disabled. Independent review-code-dev 2.1.0 / OCR 1.12.1 reviewed all four source/test files; all findings fixed. Full unit suite excluded by owner instruction. Full dashboard journey suite not run: neighboring legacy provider tests have stale pre-redesign expectations; the updated Machines journeys pass. No deployed/provider lifecycle evidence claimed.

Migrations: none. Deployment prerequisites: none.

Gaps and intentional limits:
- Provider status only supplies configured/unconfigured: no connection author/date, provider running count or organization-level machine-size policy API. Those prototype facts and the provider Default size form are omitted. Snapshot/repository size defaults remain in Snapshots. Implementing provider defaults needs a persisted provider policy and read/write API.
- Host registration accepts an optional name; limits can only be configured after heartbeat. No supported atomic registration size/capacity or pause/drain action exists, so registration preserves its one-time installer flow and editing keeps numeric resource controls. Existing backend busy-host constraints remain.
- Host daemon version, resource limits/capacity and heartbeat are shown only as reported. Older fixtures explicitly report unknown resources; no fabricated size. Host address/architecture and reusable register command are not exposed. Re-registration requires the existing unlink/add flow rather than a fabricated command.
- Default Acme fixture has host APIs disabled; Large has two hosts and Alice is a member. Additional seeded Acme captures use the existing fixture reset API to demonstrate admin registration, reported capacity, limits, retention and empty hosts.
- Footer actions open details before the real controls. Host drawers include additional existing operational controls (retention, snapshots, launch, unlink); prototype has no equivalents. Empty hosts retain recovery guidance.
- Shared shell/mobile navigation differences are outside this ticket.

Prototype served and captured before implementation, then fixture captures at 1440×900 and 390×844 in both themes. Each pair below links the original PNG. Provider defaults pair shows the provider detail fallback because that policy API does not exist. No secrets were entered into captured forms.

### Dark, 1440×900

| State | Prototype | Fixture |
| --- | --- | --- |
| Default organization | ![Prototype](prototype-dark-1440-page.png) | ![Fixture](fixture-dark-1440-page.png) |
| Reported-resource host cards | ![Prototype](prototype-dark-1440-page.png) | ![Fixture](fixture-dark-1440-seeded.png) |
| Large organization | ![Prototype](prototype-dark-1440-page.png) | ![Fixture](fixture-dark-1440-large.png) |
| Provider drawer | ![Prototype](prototype-dark-1440-provider.png) | ![Fixture](fixture-dark-1440-provider.png) |
| Host drawer with existing controls | ![Prototype](prototype-dark-1440-host.png) | ![Fixture](fixture-dark-1440-seeded-host.png) |
| Large host drawer | ![Prototype](prototype-dark-1440-host.png) | ![Fixture](fixture-dark-1440-host.png) |
| Register host | ![Prototype](prototype-dark-1440-register.png) | ![Fixture](fixture-dark-1440-register.png) |
| Replace key | ![Prototype](prototype-dark-1440-replace.png) | ![Fixture](fixture-dark-1440-replace.png) |
| Edit host limits | ![Prototype](prototype-dark-1440-edit.png) | ![Fixture](fixture-dark-1440-edit.png) |
| Empty hosts | ![Prototype](prototype-dark-1440-empty.png) | ![Fixture](fixture-dark-1440-empty.png) |
| Provider default size (unsupported API) | ![Prototype](prototype-dark-1440-defaults.png) | ![Fixture](fixture-dark-1440-provider.png) |

### Dark, 390×844

| State | Prototype | Fixture |
| --- | --- | --- |
| Default organization | ![Prototype](prototype-dark-390-page.png) | ![Fixture](fixture-dark-390-page.png) |
| Reported-resource host cards | ![Prototype](prototype-dark-390-page.png) | ![Fixture](fixture-dark-390-seeded.png) |
| Large organization | ![Prototype](prototype-dark-390-page.png) | ![Fixture](fixture-dark-390-large.png) |
| Provider drawer | ![Prototype](prototype-dark-390-provider.png) | ![Fixture](fixture-dark-390-provider.png) |
| Host drawer with existing controls | ![Prototype](prototype-dark-390-host.png) | ![Fixture](fixture-dark-390-seeded-host.png) |
| Large host drawer | ![Prototype](prototype-dark-390-host.png) | ![Fixture](fixture-dark-390-host.png) |
| Register host | ![Prototype](prototype-dark-390-register.png) | ![Fixture](fixture-dark-390-register.png) |
| Replace key | ![Prototype](prototype-dark-390-replace.png) | ![Fixture](fixture-dark-390-replace.png) |
| Edit host limits | ![Prototype](prototype-dark-390-edit.png) | ![Fixture](fixture-dark-390-edit.png) |
| Empty hosts | ![Prototype](prototype-dark-390-empty.png) | ![Fixture](fixture-dark-390-empty.png) |
| Provider default size (unsupported API) | ![Prototype](prototype-dark-390-defaults.png) | ![Fixture](fixture-dark-390-provider.png) |

### Light, 1440×900

| State | Prototype | Fixture |
| --- | --- | --- |
| Default organization | ![Prototype](prototype-light-1440-page.png) | ![Fixture](fixture-light-1440-page.png) |
| Reported-resource host cards | ![Prototype](prototype-light-1440-page.png) | ![Fixture](fixture-light-1440-seeded.png) |
| Large organization | ![Prototype](prototype-light-1440-page.png) | ![Fixture](fixture-light-1440-large.png) |
| Provider drawer | ![Prototype](prototype-light-1440-provider.png) | ![Fixture](fixture-light-1440-provider.png) |
| Host drawer with existing controls | ![Prototype](prototype-light-1440-host.png) | ![Fixture](fixture-light-1440-seeded-host.png) |
| Large host drawer | ![Prototype](prototype-light-1440-host.png) | ![Fixture](fixture-light-1440-host.png) |
| Register host | ![Prototype](prototype-light-1440-register.png) | ![Fixture](fixture-light-1440-register.png) |
| Replace key | ![Prototype](prototype-light-1440-replace.png) | ![Fixture](fixture-light-1440-replace.png) |
| Edit host limits | ![Prototype](prototype-light-1440-edit.png) | ![Fixture](fixture-light-1440-edit.png) |
| Empty hosts | ![Prototype](prototype-light-1440-empty.png) | ![Fixture](fixture-light-1440-empty.png) |
| Provider default size (unsupported API) | ![Prototype](prototype-light-1440-defaults.png) | ![Fixture](fixture-light-1440-provider.png) |

### Light, 390×844

| State | Prototype | Fixture |
| --- | --- | --- |
| Default organization | ![Prototype](prototype-light-390-page.png) | ![Fixture](fixture-light-390-page.png) |
| Reported-resource host cards | ![Prototype](prototype-light-390-page.png) | ![Fixture](fixture-light-390-seeded.png) |
| Large organization | ![Prototype](prototype-light-390-page.png) | ![Fixture](fixture-light-390-large.png) |
| Provider drawer | ![Prototype](prototype-light-390-provider.png) | ![Fixture](fixture-light-390-provider.png) |
| Host drawer with existing controls | ![Prototype](prototype-light-390-host.png) | ![Fixture](fixture-light-390-seeded-host.png) |
| Large host drawer | ![Prototype](prototype-light-390-host.png) | ![Fixture](fixture-light-390-host.png) |
| Register host | ![Prototype](prototype-light-390-register.png) | ![Fixture](fixture-light-390-register.png) |
| Replace key | ![Prototype](prototype-light-390-replace.png) | ![Fixture](fixture-light-390-replace.png) |
| Edit host limits | ![Prototype](prototype-light-390-edit.png) | ![Fixture](fixture-light-390-edit.png) |
| Empty hosts | ![Prototype](prototype-light-390-empty.png) | ![Fixture](fixture-light-390-empty.png) |
| Provider default size (unsupported API) | ![Prototype](prototype-light-390-defaults.png) | ![Fixture](fixture-light-390-provider.png) |
