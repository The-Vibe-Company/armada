# @armada/app

Armada V2's single-page app (`docs/v2-desktop.md`): React 19 on Vite, Tailwind v4,
shadcn components on Base UI, Motion. It speaks only the daemon's protocol
(`@armada/protocol`); it never imports the daemon, the dashboard or `core`.
Private: not published. Electron (`packages/desktop`) opens it, and the daemon
can serve it to a browser.

```sh
bun run fake-daemon                 # a stand-in daemon on ws://127.0.0.1:4824, synthetic projects
bun run dev                         # the app on http://localhost:4823, connected to it
bun run build                       # dist/, what the desktop shell and the daemon serve
```

## Where the daemon is

`?daemon=ws://host:port/` in the page's address wins (the desktop shell opens the
app on its own daemon), then the build's `VITE_ARMADA_DAEMON_URL`, then the fake
daemon's port in development, else the page's own origin (the daemon serving the
app). `src/protocol/address.ts` holds the rule.

## The protocol client

`src/protocol/client.ts` is the app's one connection: `projects.list`, then
`project.subscribe` for each project from its last applied cursor; each frame is
validated with `serverMessageSchema`, and its major is read first, so a daemon of
another major is refused with the protocol's one line and never retried. A
dropped connection waits (250 ms, doubling to 5 s), reconnects and resumes every
project where it stopped; the projects stay on screen meanwhile. The socket and
the timer are injected (`SocketLike`, `schedule`), so tests drive it without a
network or a clock. Screens read the state with `useDaemon()`
(`src/protocol/store.tsx`, `useSyncExternalStore`).

Event kinds belong to the daemon. The app reads the few it needs, ignoring any
other kind or shape: `src/fleet/sessions.ts` counts a project's sessions in
flight (`session.claimed` until `session.released` or `merge.confirmed`).

`scripts/fake-daemon.ts` is for development and this package's browser test only
(Bun), until `packages/daemon` serves the protocol: it admits every request with
`admitRequest`, as the daemon must.

## The look

The v7 design (`design/dashboard-v7`) lives on as tokens and rules, not as CSS.
`src/styles.css` holds them in Tailwind's `@theme`, values copied from the
dashboard's `globals.css`: the planes, the ink, the hairlines, the state colours
(red blocked, amber waiting for the owner, blue running, green ready or live,
grey merged; always beside a word or a glyph), the type scale (`text-label` 11 px
to `text-title` 22 px), the shell's lengths (`w-sidebar`, `h-row`, `h-item`), the
radii and the rings. Tailwind's own fonts, colours, radii, shadows and sizes are
reset: `font-serif` or `bg-blue-500` builds nothing.

- **Geist and Geist Mono only**, self-hosted (`src/fonts`, from `design/dashboard-v7/fonts`).
- **Every page has the v7 anatomy** (`src/components/page.tsx`): a line of facts,
  the 22 px title, a quiet line, then the page's blocks. The title is the page's
  only `h1`.
- **shadcn on Base UI** (`components.json`, style `base-nova`): components are
  copied into `src/components/ui` when a screen needs one, then set on the v7
  tokens. `cn` (`src/lib/utils.ts`) is told the theme's size, radius and shadow
  names; without them it would drop `text-body` beside `text-text-2`.

`test/anatomy.test.tsx` refuses a font other than Geist and Geist Mono and an
`h1` outside the title line, and holds `cn`'s names to the theme.

## Movement

**Movement always says something: a state changed, something arrived. Nothing
loops in the working view.**

- An animation answers a change in the fleet's data (a count moved, a row arrived
  or changed state), never the passing of time. No spinners, pulses, shimmer or
  breathing dots: a waiting state is a word ("Reconnecting"), with a still dot.
- Nothing moves on the first paint (`AnimatePresence initial={false}`), and the
  keyboard never animates.
- Transform and opacity only, about 150 ms, on the theme's `ease-out`. The system's
  reduced-motion setting is honoured (`MotionConfig reducedMotion="user"`).
- Motion loads through `LazyMotion` with `m` components; its features arrive after
  the first paint (`src/components/shell/motion-features.ts`).
- Rive is reserved for future scenes, in a canvas apart from the lists.

## First-load budget

`perf-budget.json` caps the first-load JS (the entry script and its preloads,
gzipped) at 150 KB; `test/build.test.ts` builds the app as `bun run build` does
and fails past it. The same test opens the build in Chromium against the fake
daemon and checks the sidebar lists the projects with their counts, a claim
reaches it live, the one `h1` is the 22 px title, and every element is set in
Geist or Geist Mono. Install the browser once with `bun run test:browser:install`
at the repository root.
