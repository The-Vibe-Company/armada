# Dashboard design notes

The signed-in dashboard (`apps/dashboard/src/app/(app)`) is a work tool: a person picks an organization,
checks what is running or failed, launches an agent from a golden, and occasionally manages goldens,
connections, keys and members. These notes keep later changes consistent with that job.

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

## Tokens

The tokens live in `apps/dashboard/src/app/globals.css` (#757). The public landing has its own (`landing.css`) and
does not read these; the login and invitation pages do. Hierarchy comes from weight, size and space; colour is
for meaning only, and every text colour holds AA (4.5:1) on the page, the card and the muted fill in both themes.

| Role | Choice |
| --- | --- |
| Type | Geist and Geist Mono, the landing's faces (`src/app/landing/fonts.ts`), on every platform; page title 24px semibold, section 16px, card title 14px semibold, body 14px, facts 13px, labels 12px muted |
| Neutrals | cool graphite (hue 265, barely tinted); the page (`background`) a shade off the cards (`card`), so groups read without heavy borders; `sidebar` for the navigation rail |
| State colour | `info` in flight (running), `success` live and idle (ready, connected), `warning` in transition (starting, stopping), `destructive` failed; neutral at rest. `src/lib/status-tone.ts` is the one mapping, `StatusBadge` draws it with a dot that pulses while the state moves on its own |
| Brand | the landing's lime, on the mark only; focus rings are the landing's frontier blue (`ring`) |
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
- `loading.tsx` skeletons that take the shape of the page they stand in for, so nothing moves when the data arrives.
- The command menu (`components/command-menu.tsx`, `lib/command-menu.ts`): ⌘K or Ctrl+K anywhere in the signed-in
  app, also reachable from the Search button in the navigation.

Group labels in the navigation are sentence case (`Run`, `Build`, `Account`), not uppercase.
