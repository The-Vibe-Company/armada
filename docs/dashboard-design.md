# Dashboard design notes

The signed-in dashboard (`apps/dashboard/src/app/(app)`) is a work tool: a person picks an organization,
checks what is running or failed, launches an agent from a golden, and occasionally manages goldens,
connections, keys and members. These notes keep later changes consistent with that job.

Resource create and add flows use `CreateDialog` through
`ResourceBrowser.actions`. Use one short, centered form and keep the resource
list on the page.

For fixture UI development, `bun run dev` runs the dashboard and
`e2e/mock-supabase.ts` on ports 3100 and 54399. Sign in as
`alice@example.com` with code `123456`. Free both ports before starting,
and use Ctrl-C to stop both processes. The dashboard unit tests use
`bun test` for pure logic; use `bun run e2e` for browser journeys.

## Principles

- **Scope first.** The current organization and the person's role in it sit at the top of the navigation,
  above every page. Nothing on a page should leave doubt about which org it shows.
- **One primary action per page.** Sandboxes: launch (it leads to the goldens). Goldens: launch from a golden.
  Detail: send a message or stop. Everything else is a secondary (outline or ghost) button.
- **Activity before reference.** Lists lead with the identifier and its state; supporting facts are muted and
  collapse on narrow screens. On a sandbox, the logs are the main column and the facts sit beside them.
- **Progressive disclosure.** Build forms, edit-and-rebuild and capacity caveats stay one click away; the
  default view shows what exists and what can be done with it.
- **Every state says what to do next.** Empty lists name the action that fills them; errors say what failed
  and where to fix it. No marketing copy, no invented labels.

## November 2026 redesign foundation (#2487)

The owner’s source of truth is checked in at `docs/design/refonte-2026-11-16/`.
`Armada.dc.html` specifies the shell and primitives; `Logo.dc.html` supplies the provider marks.
Later slices own page content and use this shared foundation rather than redefining tokens.

Prototype token names are public CSS variables: `canvas`, `sidebar`, `surface`, `raised`,
`sunken`, `line`, `line-strong`, `fg`, `muted`, `faint`, `ok`, `warn`, `danger`, `info`,
`scrim`, and `accent` with its `hover`, `fg`, `tint`, `edge`, and `text` variants.
The `.dark` class applies the prototype’s dark palette. Existing shadcn utilities map onto
these variables: `bg-muted` uses `raised`, `text-muted-foreground` uses `muted`, and
`bg-accent` is the neutral interaction fill. For the actual lime use `bg-primary` or
`var(--accent)`. This distinction preserves existing hover styles throughout the app.
Shadows are exposed as `shadow-md` and `shadow-lg` utilities and `--elevation-md/lg`.

Reuse `Button`, `Badge`, `Card`, `Input`, `Textarea`, `Dialog`, `Sheet`, `Table`,
`PageHeader`, `Empty`, `StatusBadge` and `StatusDot`; keep status meaning in `status-tone.ts`.
The shell owns the 244px rail, organization scope, command search, launch entry,
inline active sandboxes, grouped links, footer and breadcrumb. PageHeader actions render into the top bar through ShellPageActions; their forms and authorization remain page-owned.

## Tokens

The tokens live in `apps/dashboard/src/app/globals.css` (#757). The public landing has its own (`landing.css`) and
does not read these; the login and invitation pages do. Hierarchy comes from weight, size and space; colour is
for meaning only, and every text colour holds AA (4.5:1) on the page, the card and the muted fill in both themes.

| Role | Choice |
| --- | --- |
| Type | Geist and Geist Mono, the landing's faces (`src/app/landing/fonts.ts`), on every platform; page title 24px semibold, section 16px, card title 14px semibold, body 14px, facts 13px, labels 12px muted |
| Neutrals | prototype cool graphite (hue 265); the page (`background`) a shade off the cards (`card`), so groups read without heavy borders; `sidebar` for the navigation rail |
| State colour | `info` in flight (running), `success` live and idle (ready, connected), `warning` in transition (starting, stopping), `destructive` failed; neutral at rest. `src/lib/status-tone.ts` is the one mapping, `StatusBadge` draws it with a dot that pulses while the state moves on its own |
| Brand | prototype lime for primary actions and the fleet mark; focus rings use `accent-edge` |
| Identifiers | Geist Mono only for machine ids (sandbox ids, snapshots, paths), with a `CopyButton` where people take them elsewhere |
| Spacing | 4px grid; 24px between page sections, 12px inside a group |
| Radius | `rounded-xl` for cards, tables and dialogs, `rounded-md` for controls inside them |
| Elevation | `shadow-xs` on cards and controls, `shadow-lg` on dialogs and floating buttons; dialogs sit on a lightly blurred overlay |
| Motion | short and explanatory only: a button presses in (scale 0.97), a live state's dot pulses, results fade in. Everything honours `prefers-reduced-motion` |

## Primitives

- `PageHeader` (with an optional `meta`, such as a count), `SectionHeader` and `Empty` (with an optional icon and the
  action that fills the list) in `components/page-header.tsx`.
- `StatusBadge` and `StatusDot`, `Skeleton`, `Kbd`, `CopyButton`, the `destructive-outline` button for an action that
  is destructive but not the page's primary one (a confirmation then uses the solid `destructive` button).
- `Skeleton` placeholders that take the shape of what loads (the conversation's history while it is first read), so
  nothing moves when the data arrives. A `loading.tsx` boundary is never placed above a page that calls `redirect()` or
  `notFound()`: the boundary streams a 200 first, so the 307 or 404 would be lost (the sandboxes list redirects a new
  organization to setup, a sandbox page answers 404).
- The command menu (`components/command-menu.tsx`, `lib/command-menu.ts`): ⌘K or Ctrl+K anywhere in the signed-in
  app, also reachable from the Search button in the navigation.

Group labels in the navigation are sentence case (`Running`, `Launch from`, `What agents have`, `Setup`), not uppercase.
