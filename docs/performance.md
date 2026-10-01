# Dashboard performance

The dashboard's speed is a rule the CI enforces (THE-892), not a measurement taken once. Every pull request runs the **Dashboard performance budgets** job: it builds the dashboard for production, seeds the demo world into a Postgres service, starts it, and checks the budgets below. Its table goes to the job summary and to one comment on the pull request, updated in place. A broken budget fails the job.

## The budgets

They live in `packages/dashboard/perf/budgets.json`.

| What | Budget | Measured on |
|---|---|---|
| Lighthouse performance | 95 or more, mobile and desktop | `/landing`, `/`, `/agents`, `/agents/WID-12`, `/projects`, `/validations`, `/insights`, `/activity` (the `fleet` demo world) |
| Lighthouse accessibility | 100 | the same pages (axe checks every page in its own job, THE-891) |
| Lighthouse best practices | 95 or more | the same pages |
| Cumulative Layout Shift | 0, as Lighthouse shows it (three decimals) | the same pages |
| Largest Contentful Paint | under 2.5 s on mobile | the same pages |
| First-load JS per route, gzipped | its baseline plus 5% | every route of `next build` |
| Interactions, input to next paint | under 200 ms with the CPU 4× slower | the `large` demo world: open ⌘K on `/agents` (250 rows), filter the agents by harness, switch an agent's tab (both ways, on 350 activity rows), answer a decision on the overview |

How they are measured:

- **Lighthouse 13**, three runs per page on mobile (the median counts) and one on desktop, with DevTools' own throttling: a slow 4G network and the CPU 4× slower, Lighthouse's and PageSpeed Insights' standard, on any machine. Lighthouse's default simulation estimates LCP from every script requested before the first paint: the pages render on the server, and that estimate read 2.1 to 2.9 s for text painted at the first paint (1.6 to 1.9 s measured). The pages poll every 5 s, so Lighthouse stops waiting for a quiet network after 15 s.
- **The margin.** Lighthouse's own guidance scales the slowdown with the machine (4× for a benchmark index of 1500 to 2000); GitHub's runners and a recent laptop score about 2500, which would mean 5×. At 5× (`ARMADA_PERF_CPU=5`), on 1 October 2026, mobile performance read 95 to 97 on `/`, `/agents`, `/agents/WID-12`, `/projects` and `/insights`, but 94 on `/landing` (the hero's canvas and the framework's start-up), 94 on `/validations` and 93 on `/activity` (hydration): those three have the least room, and THE-899 revisits the last two.
- **First-load JS** comes from `next build`'s `.next/diagnostics/route-bundle-stats.json` (Turbopack does not print sizes): each route's chunks, gzipped and summed.
- **Interactions** run in Chrome through Playwright, with the CPU 4× slower. The Event Timing API gives each one's longest event, as INP counts it. Each runs five times and the median counts, so one run that meets a poll's re-render or a garbage collection does not decide; answering a decision runs once, since it records the answer. A keyup is not counted: one that changes nothing on screen gets no frame of its own, and headless Chrome reports it when something else draws next, up to a second later.

## Running them locally

From `packages/dashboard`, with a Postgres database for each world (the production server refuses `pglite:`):

```sh
bun run build
bun run perf bundles                      # first-load JS per route against the baselines
ARMADA_DEMO_DATABASE_URL=postgres://localhost/fleet bun run demo:seed fleet
ARMADA_DEMO_DATABASE_URL=postgres://localhost/large bun run demo:seed large
export ARMADA_DASHBOARD_PASSWORD=local-check
ARMADA_DATABASE_URL=postgres://localhost/fleet ARMADA_DASHBOARD_DEMO=fleet bunx next start --port 4822 &
ARMADA_DATABASE_URL=postgres://localhost/large ARMADA_DASHBOARD_DEMO=large bunx next start --port 4823 &
bun run perf inp http://localhost:4823    # seed `large` again before another run: it answers a question
bun run perf lighthouse http://localhost:4822
bun run perf report                       # the Markdown the pull request gets, in .perf/report.md
```

Lighthouse and Playwright use the Chrome installed on the machine (`CHROME_PATH` to point at another).

## Changing a budget

- **A route grew on purpose** (a new page, a feature that needs its code on first load): run `bun run perf bundles --update` after `bun run build`, and say why in the pull request. A new route has no baseline and fails until then.
- **Heavy code that is not needed on first paint** loads apart instead: `useLazy` (`components/use-lazy.ts`) fetches its chunk when the browser is idle and renders it without suspending, as ⌘K and the attachment viewer do.
- **A list that can pass 100 rows** gets `long` on its `Section` (or `CardGrid`): rows off screen skip style, layout and paint (`content-visibility`), and every row stays in the page for j/k, find and screen readers.
- **A new main page** goes in `lighthouse.pages`.

## Where to read real users' numbers

- **Vercel Speed Insights** (`<SpeedInsights />` in `app/layout.tsx`, on in production): the Vercel project → Speed Insights. Pick p75, then mobile or desktop, to read LCP, INP and CLS per route from real visits.
- **The two routes every open dashboard polls**, `/api/fleet` (the overview, every 5 s while agents work) and `/api/fleet/activity` (an agent's history), answer with a `Server-Timing: app;dur=<ms>` header and log one line per answer, `armada timing <route> <status> <ms>ms`. In the Vercel project → Logs, filter on `armada timing /api/fleet` and read the p75 of the last number; the budget is 100 ms warm, and a poll that finds nothing new stays a 304. Measured locally on a production build of the demo world: `/api/fleet` 21 ms at p75 (a 304 about the same), `/api/fleet/activity` 5 ms.
