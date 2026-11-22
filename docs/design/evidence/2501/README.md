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
