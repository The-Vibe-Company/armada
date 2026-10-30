# @armada/app

Armada V2's single-page app (`docs/v2-desktop.md`): React 19 on Vite, Tailwind v4,
shadcn components on Base UI, Motion. It speaks only the daemon's protocol
(`@armada/protocol`); it never imports the daemon, the dashboard or `core`.
Private: not published. Electron (`packages/desktop`) opens it, and the daemon
can serve it to a browser.

```sh
bun run dev-daemon                  # armadad on ws://127.0.0.1:4824, a synthetic fleet that moves
bun run dev                         # the app on http://localhost:4823, connected to it
bun run build                       # dist/, what the desktop shell and the daemon serve
```

## Where the daemon is

`?daemon=ws://host:port/` in the page's address wins (the desktop shell opens the
app on its own daemon), then the build's `VITE_ARMADA_DAEMON_URL`, then the dev
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

The daemon folds its log; the app never folds. `project.subscribed` carries the
project's folded state (`snapshot`), and so does every `events` frame that
carries events; the client keeps the latest per project (`fleets`, never an
older cursor's). `src/fleet/state.ts` reads the few fields the screens need,
row by row: a row of another shape is skipped, any other field ignored.

`scripts/dev-daemon.ts` is armadad's own server (`@armada/daemon/server`, a
dev dependency for scripts and tests only) over an in-memory log seeded with a
synthetic fleet, one session in every state; in development Tidewater's TID-7
takes a step every three seconds. The browser test runs the same server, which
serves the build.

## The routes

The address's hash names the screen (`src/lib/route.ts`, `routeOf` and
`useRoute`): `#/` the hangar, `#/projects/<id>` a project, `#/settings/<section>`
a section of the settings (`#/settings` the coordinator's; the old `#/plugins`
is replaced by `#/settings/providers`, once); anything else is the hangar. The
daemon serves one page and the desktop shell opens it from a file, so the path
never moves. A screen is one line there and one in `src/App.tsx`; the sidebar
marks the current one (`aria-current`).

## The hangar: every project a squadron in one sky

`src/screens/Hangar.tsx` (THE-2025), the home, after the direction kept with the
owner (`.aeom/direction/index.html`, "hangar-sky-mix"): the title and the
fleet's facts on one line across the top (`PageBar` in `src/components/page.tsx`:
agents in flight, moving on their own, ready to merge, merged today, then apart
what is blocked and what waits for the owner, and how many projects), and the
whole view is the sky (`Sky` at `stage` size). Every project is a squadron
flying in depth: its coordinator's V of five, its agents in their harness
colours, a hairline arc in its most urgent state's colour, its name and counts
under it (zero counts left out, `src/fleet/hangar.ts`), and "Enter the room".
The whole squadron, its ships and its words, is one link to `#/projects/<id>`
(`Sky`'s `link`; the layout gives each squadron its `area`). A squadron with an
agent blocked or waiting for the owner flies nearest and largest, one at work
further, one with nothing in flight furthest (`SQUADRON_SCALE` in
`src/sky/layout.ts`). When nothing is in flight the sky is empty, with one quiet
line. The sky is drawn once every project's folded state arrived, so its first
paint holds every squadron in place.

`test/hangar.test.tsx` lays out two synthetic projects and checks each
squadron's ships, colours, depth, arc, counts and link area, the facts line, and
the empty sky's quiet line.

## Settings

`src/screens/Settings.tsx` at `#/settings/<section>` (THE-2069), reached from the
sidebar's one Settings entry (a gear, at its bottom) and loaded on demand, off the
first load. It has the anatomy of T3 Code's settings (`pingdotgg/t3code`,
`apps/web/src/components/settings`) on the v7 title line. `src/settings/Layout.tsx`
holds its parts. `SettingsNav` is the nav of sections: Coordinator, Providers,
Account, About, each with its lucide icon. The current one is `aria-current`
and is the nav's one tab stop, and the arrow keys, Home and End move between
them. Below 720 px of the settings' own width it becomes an icon rail with a
tooltip per icon. `SettingsSection` is a heading over a `SettingsGroup`, the
grouped card whose rows are divided by a hairline. `SettingsRow` takes a
`title`, a `description`, a `status` and one `control` on the right, and
`SettingsFold` holds a row's settings folded below it. `StateDot` puts a state
word on its dot.

The sections:

- **Coordinator** (`src/settings/Coordinator.tsx`): the coordinator's model, the key form unchanged, then the
  OS notifications' switch (`src/notify/NotificationSetting.tsx`, a `SettingsRow`, THE-2055).
- **Providers**: the plugins (below).
- **Account** (`src/settings/Account.tsx`): a disabled "Sign in to Armada" row until THE-2071.
- **About** (`src/settings/About.tsx`):
  - the daemon's address
  - the app's version (`__ARMADA_APP_VERSION__`, from `package.json` by `vite.config.ts`)
  - the protocol version the app speaks and the minor the daemon answers with
  - the daemon's version and its data folder, which read "Not reported by this daemon" until the protocol carries them

## Notifications

`src/notify/` (THE-2055), after T3 Code's `ThreadNotificationCoordinator.tsx`,
mounted once beside every screen and loaded after the first paint. It hears
every project's live turn (the client subscribes every project, so the daemon
streams each one's `chat.turn` and `chat.delta`) and each folded inbox. A turn
seen to work, then back to idle, is read once (`chat.read`, never for the room
on screen): when the reading holds an answer or a line written since the turn
began (not a stopped one), it is "Coordinator answered" (a fast turn may never
stream its words; a failed reading falls back on what streamed); an
`owner-request` that was not open at the project's first reading is "Question
for you". Each says the project's name and the first line said (markdown's
marks left out, 120 characters at most). The rules are `rules.ts`, pure over an
injected world (the platform's `Notification`, the focus, the room on screen,
the switch, the toasts and the badge):

- **The room on screen** (its route in a visible window) hears nothing.
- **A focused window** shows a toast at the bottom right with "Open the room",
  gone after six seconds unless hovered or focused.
- **A window in the background** gets an OS notification (silent, one per
  project and kind, a newer one replacing the older) and the badge counts those
  not yet read; a click brings the window forward and opens the room, the
  window's focus clears the badge. In the desktop shell both go through its
  preload (`window.armadaShell`, `src/notify/shell.ts`); in a browser, the
  window's own focus and the Badging API where there is one.
- **The switch** in Settings turns the OS notifications and the badge off
  (`localStorage`, on by default, this device only); turning it on in a browser
  not yet asked asks for the permission. Nothing makes a sound.

`test/notify.test.tsx` holds the rules on a fake `Notification`, a fake focus
and a fake room on screen.

## A project's fleet by state

A project's sessions by state are its room's panel's Agents tab
(`src/components/fleet/FleetList.tsx`, THE-2085): every group headed, most
urgent first, a row that changes state gliding to its new group.

The rules are V1's overview (`packages/dashboard/lib/coordinator-view.ts` and its
strings), copied into `src/fleet/overview.ts`, never imported:

- **The group is the fold's state**: blocked, waiting for your decision
  (`waiting-for-owner`), in progress, ready to merge, merged today (merged on the
  viewer's day, in their zone). Released sessions and older merges are not shown.
- **The reason** says why, in V1's words: an unanswered question, red CI or a
  conflict on the pull request, the worker's blocked line; a plan to approve, the
  validation's question; the worker's last line (else "At work"); handed back
  with the pull request's CI, or its place in the merge queue; `#N merged`.
- **The colour** is the state's: red, amber, blue, green, merged grey, on the
  row's dot, its group's dot, its step and its reason (quiet ink for in progress
  and merged).
- **The six-step bar** (Plan, Approval, Code, Review & CI, Ready, Merged): the
  done steps grey, the one at work in the state's colour; all grey once merged.
- A row's time is the hour on the viewer's day, else the date: a still word,
  whole from a 900 px window up (the title gives way, with an ellipsis).
- **Past 100 rows** each row is `content-visibility: auto` at its 48 px, so the
  browser skips the rows off screen; every row stays in the page.

`test/overview.test.ts` holds the rules on synthetic folded states;
`test/fleet.test.tsx` renders the list on the daemon's fold of a synthetic log
and reads the groups, the reasons and their colours.

## A session's page

Every row of the fleet is a link (the whole row, focusable, Enter opens it) to
its session's page, `#/sessions/<ticket>` (`?tab=files` for the second tab):
`src/screens/Session.tsx`, loaded when a row opens it, never in the first load.
Its route is `src/session/route.ts`, one line of `App.tsx`; its reading is
`src/session/view.ts`, pure, from the project's folded state and the events the
subscription replayed (the client keeps them per project): the app reads one
ticket's lines out of the log, it never folds.

- **The facts line**: back to the project (`#/projects/<id>`, its page, its room
  once that lands), the ticket, the runtime and its harness, the
  branch and the pull request's address from the forge's events, the pull
  request and its checks, claimed at, last report at. Then the ticket's title
  (the 22 px h1) and the state on the quiet line.
- **The state card**, edged in the state's colour: blocked says why (the
  worker's question when it asked one); waiting for you says the validation, the
  coordinator's question or the plan; in progress the last report; ready to
  merge the hand-back; merged the pull request. Plans and validations keep
  their choices and Note disabled with "Not available yet.".
- **The card's buttons act** (THE-2045, protocol minor 6). The card of any
  session in flight has them; against an older daemon they stay disabled with a
  line saying why.
  - **Answer** opens the worker's question: its choices (the recommended one
    primary) and a labelled Note. A choice sends `owner.answer`, which the
    daemon delivers to that worker generation.
  - The coordinator's question to the owner shows its choices and Note at once,
    as the room's card does.
  - **Release the ticket** opens a confirmation line with a required Reason,
    then sends `session.release` naming the session and its generation.
  - **Open the session** opens a read-only drawer with the worker's output
    (`session.output`, its last 200 lines). The drawer reads it again on each
    new event of the session while it is open; Escape closes it.
  - A V1 session (the tracker's reading, runtime `tracker`) opens its Conductor
    workspace from its claim comment, when the claim is among the ticket's last 12
    comments the Linear reader keeps. It is released from its own runtime.
- **The six steps** (Plan, Build, Ship, Review & CI, Merge, Done): the done ones
  grey, the current one in the state's colour and marked (`aria-current`).
- **Reports**: the ticket's reports and events, newest first (claims, reports,
  questions and answers, validations and decisions, the merge queue, the pull
  request's moves; heartbeats and unchanged readings left out), each on one line
  cut with an ellipsis, opened on a click to its whole text.
- **Files**: the pull request's files with their +/- counts when a forge event
  carries `files`; one quiet line when none.

`test/session.test.tsx` renders a synthetic session in each state on the
daemon's fold and checks the card, the steps and both tabs; `test/build.test.ts`
opens a row by a click and by the keyboard in Chromium, and holds every row's
time whole at 900 px.

## Providers: the plugins

`src/settings/Providers.tsx` at `#/settings/providers` (the Plugins screen of
THE-2019 before THE-2069) shows the catalog's numbers on the facts line (plugins,
on, loaded, refused). Below them, every bundled plugin is listed in grouped cards
by what it provides (`src/plugins/list.ts`: Models, Runtimes, Trackers, Forges,
Nodes, then Other). Each row has its name, version, description and
contributions, its state word on a dot (loaded, off, refused, restart to apply)
and a switch (`src/components/ui/switch.tsx`, lime when on). Its "Settings" fold holds
each contribution's form, generated from its JSON Schema by `src/plugins/schema.ts`
with the page kit's `Form`, `Field`, `Input` and `Select`, and each declared
secret as set or missing with a password field. The secret follows the coordinator
key's rule: the field is cleared before the daemon answers, and the value is never
kept or replayed.

The client (`setPluginEnabled`, `configurePlugin`, `setPluginSecret`,
`restartDaemon`) asks the daemon, which saves at once and answers with the whole
list. A change then shows "Restart to apply" and a notice with Restart. Restart
asks the daemon to restart (the desktop shell starts it again); the client
reconnects as after any drop and lists the plugins again. A daemon the shell does
not supervise says to quit and reopen instead. `test/settings.test.tsx` renders
the route table, the nav and a synthetic catalog over a fake socket.
`test/build.test.ts` opens `#/plugins` and lands on Providers, flips a switch in
Chromium, saves a setting and a secret, and presses Restart on a daemon the test
restarts on the same port, until the row reads Loaded.

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
  the 22 px title, a quiet line, then the page's blocks. The hangar, a full-bleed
  sky, keeps the direction's one line instead (`PageBar`: its 15 px title, then
  its facts). The title is the page's only `h1`.
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
- **A row that changes state glides to its new group.** The fleet's headers and
  rows are siblings of one list, keyed by group and by `project/ticket`, so the
  row is the same element moved, and Motion's layout animation (`layout`) carries
  it there, drawn above the rows it passes. A row that arrives fades in, one that
  leaves fades out, and the rows around them make room.
- Transform and opacity only, about 150 ms (200 ms for a row's glide, which
  travels further), on the theme's `ease-out`. The system's reduced-motion setting is honoured (`MotionConfig reducedMotion="user"`).
- Motion loads through `LazyMotion` with `m` components; its features (`domMax`,
  for layout animations) arrive after the first paint
  (`src/components/shell/motion-features.ts`).
- Rive is reserved for future scenes, in a canvas apart from the lists.

## The sky

`src/sky/Sky.tsx` (THE-2024) is the picture the hangar and a project's room
drew, after the direction kept with the owner (`.aeom/direction`); since THE-2085
it flies in the hangar only, the band kept for `?story=sky`: the mark's
triangles in V formations on the night surface, drawn from the fleet's state,
never from randomness. Its props are slices of the fold (`src/fleet/sky.ts`:
each session's group and its harness, read from its runtime) and one injected
clock; `size` is `band` (200 px, full width, the story page) or `stage`
(fills its container, the hangar). The words over it (group or project labels,
the quiet legend) are HTML in Geist; the canvas draws no text.

- **What it draws**: the coordinator as a V of five with the lime lead; one
  triangle per agent in flight in its harness's colour (Claude `#d97757`,
  Codex `#10a37f`, OpenCode `#bb87fc`, bone for another runtime), a blocked
  one banked away; an arc under each state's agents in the state's colour (the
  app's tokens, so the sky and the list agree); the day's merges as a faint
  bone V flying away. Three depths: near (in flight), middle (ready to merge),
  far (merged today).
- **Movement says something**: a ship banks and flies to its new group when its
  session changes state; a merge flies it to the merged V while its squadron
  closes ranks; a new session flies in from below, an ended one out through the
  top. Between two changes the sky holds still and asks for no frame
  (`src/sky/view.ts`): nothing loops. The first paint and a resize put every
  ship in place; reduced motion does so for every change.
- **The rules**: `flock.ts` holds the landing's pure rules
  (`packages/dashboard/components/landing/flock.ts`, copied, never imported)
  and the springs that fly a ship to its place; `layout.ts` gives each ship its
  place for the band and the stage; `draw.ts` draws on the few methods of a 2D
  context it names, one path per depth, colour and opacity.
- **Its budget**: `perf-budget.json`'s `skyFrame`: with 60 agents in flight,
  through launches, state changes and merges, no frame makes more than 400
  calls and writes to the context, and a frame's work averages under 4 ms.
- **A narrow band** (a room beside its panels) keeps every group: its labels
  give way to the legend, whose states then wrap to a second line (also under
  672 px) and whose harnesses give way (also under 896 px).

`test/sky.test.ts` draws it on synthetic fleets with a fake 2D context and a
hand-turned clock: the triangles per state and colour, the bank on a state
change, the regroup on a merge, the frame budget. `?story=sky` in the dev
server shows the band of each of the daemon's projects and the stage of them
all, live, and a synthetic fleet moved by hand (loaded only behind that flag).

## A project's room

`#/projects/<id>` (`src/screens/Room.tsx`, THE-1996) is the project's chat, full
height (THE-2085, after T3 Code's chat view; `Room.tsx` is only the composition):

- **The header** (`src/room/Header.tsx`, `PageStrip` of `src/components/page.tsx`):
  one 44 px line, the project's name (the page's h1, 13.5 px) and its repository
  in mono, then a pill per state that holds an agent (blocked red, waiting for
  you amber, in progress blue, ready to merge green, merged today grey: its dot,
  its number, its words), a provider read over three minutes ago ("Linear 25
  min ago"), and the panel's toggle (`aria-pressed`). A pill opens the panel's
  Agents at its group, its heading focused. Under 900 px of header the pills keep
  their dot and number, their words for screen readers.
- **The conversation** takes the rest, the owner's field at the bottom; with
  nothing said, the empty room's hero, its headline over the fleet's sentence
  ("1 agent blocked, nothing waits for your decision.").
- **The panel** (`src/room/Panel.tsx`, rules in `src/room/panel-rules.ts`, after
  T3 Code's right panel): tabs on top, Agents, Pull requests, Rules, Log; the
  tab in the address (`?panel=agents|prs|rules|log`, replaced, never pushed);
  320 px, 240 to 480 by dragging its left edge or by the arrow keys on it, kept
  with whether it is open in `localStorage` (`armada.room.panel`). `⌘.` toggles
  it, `⌘1` to `⌘4` pick a tab while it is open. Below a 900 px window it is a
  sheet over the conversation, closed at first and closed by Escape or a press
  beside it; opened by a pill it leaves the focus where it was (the field).
  - **Agents**: the oldest question waiting for the owner first (an open
    `owner-request`, `src/room/Pinned.tsx`: its choices from V1's "Options:"
    list, the one said "(recommended)" primary, a labelled note; answered
    through `owner.answer`), then the agents by state, a row's title opening
    its session's page (`#/sessions/<ticket>`, THE-2028), its report's ids
    links of their own (a ticket to its session, `#34` to its pull request).
    While that card is not on screen the field says the question waits, with
    Answer (`src/room/Asking.tsx`).
  - **Pull requests** (`src/room/PullRequests.tsx`): the open pull requests of
    the tickets in flight with their checks from the fold; merging from it is THE-2086's.
  - **Rules**: the project's rules (`src/rules/ProjectRules.tsx`, THE-1997);
    the old `#/projects/<id>/rules` is replaced by `?panel=rules`.
  - **Log** (`src/room/Log.tsx`): the project's last 50 events from the
    subscription, newest first, as time · kind · ticket.

The focus goes header, thread, field, panel. The hangar's squadrons open a
room on its agents (`?panel=agents`). The sidebar stays.

- **The conversation** (`src/room/chat.ts`) is the daemon's reading
  (`chat.read`, protocol minor 4): read when the room opens, and again whenever
  the subscription brings a `coordinator.*` event past the last reading. A
  message keeps one `requestId` until the daemon admitted it, so sending it
  again after a drop is the same message. The client's `request()` correlates a
  reply with its request and rejects it when the connection drops; nothing is
  replayed.
- **What it shows** (`src/room/Thread.tsx`, rules in `src/room/view.ts`): the
  owner's and the coordinator's messages as bubbles under who said them; the
  coordinator's own lines quiet, on a dot in the state of the ticket they name
  (the newest line about a ticket; older ones a quiet dot); each tool call one
  quiet line (`<details>`) that opens on a click to its input and result.
  Ticket ids and pull requests are set in mono, an id in its ticket's state.
- **How it scrolls** (THE-2054, rules in `src/room/follow.ts`, after T3 Code's
  timeline): it follows the end, smoothly while the coordinator works; a
  message the owner sends is pinned 24 px from the top with room reserved
  under it for the answer, until the answer outgrows that room; scrolled up,
  the row the owner reads holds still while items arrive above or below, and
  "Scroll to end" shows above the field 150 ms after leaving the end (within
  40 px of it the thread follows again). Each project's place is kept in the
  tab's `sessionStorage` and restored when its room opens; PageUp and PageDown
  from the field page the thread.
- **Unread** (`src/room/unread.ts`, `src/room/activity.ts`): the room keeps, per
  project in `localStorage`, the latest coordinator item seen with the window
  focused. The sidebar (`src/components/shell/Activity.tsx`, loaded after the
  first paint) reads each other project's conversation once per turn's end and
  counts its coordinator's items past that mark; its line also says Awaiting
  input (a pinned question), Working (from the live `chat.turn`) or Failed
  (the model failed the last turn). A project never visited starts with
  nothing unread.
- **Type** never under 13 px, 12.5 px only for Geist Mono ids and times; the
  state's colour on a dot or a triangle (an agent is the mark's triangle in its
  harness's colour, as in the sky), never a side border; every field labelled.
- **The empty room** (THE-2055, after T3 Code's draft hero, `src/room/Hero.tsx`):
  with the conversation read and nothing said, the thread's place holds "What
  should we work on?" (24 px, 30 px from `sm`: the theme's `text-hero` and
  `text-hero-lg`) with the owner's field centred under it, then the starter
  asks the fleet's facts justify (`starterAsks` in `src/room/view.ts`): "What is
  blocked?" when a session is blocked, "Launch what is ready" when a ticket is
  ready (not started, no phase, its blockers done, held by nobody, no open pull
  request, not a parent), "Merge what is green" when an open pull request is
  green and clean, "Sum up today" always. A chip sends its words as the field
  would. The field stays the same element in both layouts: on the first Send it
  glides down to its dock (Motion's layout animation, 250 ms, only on leaving
  the hero; none under reduced motion). `test/hero.test.tsx` holds the asks,
  the hero's markup, and in Chromium a chip's message and the glide.
- **Movement**: the sheet slides in; a new message fades in; an agent's row glides to its new group.
- `scripts/dev-daemon.ts` gives every project a coordinator on pi-ai's faux
  model (it reads the fleet with one tool call, then answers in one line), and
  seeds Harbor with a pinned question and a coordinator line.

`test/room.test.tsx` renders the room on the daemon's fold of the synthetic log
and a synthetic conversation (two tool calls, a pinned question) and reads the
header, the conversation, the panel and its card; `test/room-header.test.tsx`
holds the pills and the freshness, and `test/room-panel.test.tsx`, in Chromium
on the app's own Tailwind build, the tabs and their keys, the width dragged
and kept, the agents' links, a pill going to its group, the question answered
from its card and from the field's line, the rules, the log and the sheet. The browser test
opens Harbor's room, sends a message, waits for the faux coordinator's answer,
reloads to find the same conversation, answers the pinned question, and checks
the fonts and that no text is under 13 px.

## First-load budget

`perf-budget.json` caps the first-load JS (the entry script and its preloads,
gzipped) at 150 KB; `test/build.test.ts` builds the app as `bun run build` does
and fails past it. The same test opens the build in Chromium, served by armadad's
own server on a synthetic log, and checks the sidebar lists the projects with
their sessions in flight, the hangar's squadrons and their links, a project's
groups once its squadron is clicked, that a report arriving over the
subscription glides the same row into Blocked without a reload, that a claim
reaches the sidebar and the list live, that the one `h1` is the 22 px title, and
that every element is set in Geist or Geist Mono. Install the browser once with
`bun run test:browser:install` at the repository root.
