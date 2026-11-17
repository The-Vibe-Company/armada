# Dashboard browser tests (#2313, #2597)

The legacy Playwright specs and their runner were retired in #2597. They were
outside both `bun run e2e` and CI. The retirement PR records the browser
behavior that lost its only test coverage.

Run the tester-army journeys in `tests/dashboard/` with `bun run e2e`. They
use desktop and phone browser targets configured in `e2e.config.ts` and the
local Supabase and Armada fixture server shared with `bun run dev`.

The dashboard's exact Playwright pin still serves the production-smoke golden
setup and the local dashboard navigation performance probe.
