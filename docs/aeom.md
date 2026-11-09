# All Eyes On Me on the public landing

The landing below the hero (`apps/dashboard/src/components/landing`, the story rules of `apps/dashboard/src/app/landing/landing.css`) continues the accepted hero on its own night surface (#628). Its direction and rules are in `.aeom/standard.md`: the hero's art direction is a hard constraint, lime is the one accent, and a failing `one-direction` principle is a blocking finding. The hero, its navigation and its sky are protected and are not touched.

## #628: the story continues the hero

The split-diff page of run-20261109-1256 (#610, #623, below) was rejected: its pastel review panels broke the dark hero's continuity. #628 restores the story's structure and copy from the accepted landing (`501ee88`), then re-skins every chapter with the hero's tokens (surface, text, hairlines, glow, Geist and Geist Mono, lime), keeps the story index under the hero that the key journeys use, and rewrites the standard with `aeom standard` (night-continuity). Measured with `aeom review --base origin/main`: the four key journeys reach their end and nothing is outside the standard. The hero's DOM, computed styles and pixels are unchanged at 1440 and 390 px.

## Reproduce

- `scripts/aeom/install.sh` installs AEOM at the pinned commit (`9cd8ecf1d5e8f7ef97a5f8df5afdc8d2896b35c2`) outside this repository, with its `aeom` CLI, the `/aeom` and `/aeom-judge` skills and the `aeom-worker` / `aeom-judge` agents for Claude Code. Restart Claude Code after the first install so the agents load. Set `AEOM_TELEMETRY=0`.
- `.aeom/config.json` points AEOM at the signed-out landing: `scripts/aeom/landing-app.sh` builds the dashboard (only when a source changed) and serves it on `$PORT` (4317 by default) against the e2e mock of Supabase, with no account and no database. Pass `--timeout 300` to `aeom capture`, `aeom check` and `aeom journey` for the first build. Its `protected` list, which `aeom guard` enforces, holds the hero's files and its copy button, the rest of the dashboard and its tests, the packages, the database, the scripts, the docs and CI: a worker edits only the story below the hero.
- `.aeom/product.md` is the product sheet (with the hero as an accepted exception), `.aeom/journeys/` the four key journeys replayed in a browser, `.aeom/standard.md` the standard of the front every later landing change is held to (`aeom review`).
- Run state, captures and reports stay on the machine (`.aeom/runs/`, `.aeom/captures/`, `.aeom/reports/`, ignored).

## Run run-20261109-1256 (#610)

- Directions, drawn from the product sheet, each by an `aeom-worker` on Opus in its own worktree: `server-rack` (a rack read top to bottom), `branch-graph` (a history with a trunk and forked lanes), `split-diff` (the story as one side-by-side review diff).
- Screening, three `aeom-judge` agents: `server-rack` out (2 of 3: a dated, bevelled hardware skin); all three would start from `split-diff`.
- Final, three duel judges: `split-diff` beat `branch-graph` 2 to 1 (each chapter reads as a reviewed hunk, today against Armada, with the product's diagrams and commands in the added side).
- Page wave, one `aeom-worker` (Sonnet) in three passes on what the measure confirmed: a story index under the hero for phones, a paper review surface, the install as the diff's last hunk, the terminal sized to its session.
- Measures: 27 checks pass before and after; key journeys from 15 failing verdicts and 2 broken phone replays to 6 and none broken (ratchet: 4 kept, 0 back; guard: no feature, no protected file); page principles from 0 to 1 failing (`one-direction`, 2 of 3: the protected dark hero above the paper story). Review fixes after the run (#610 review): long command words wrap on a phone, one "today" line made exact, the protected list and the start script tightened.
