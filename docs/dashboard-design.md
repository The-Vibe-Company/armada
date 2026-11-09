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

The app reuses the existing neutral shadcn tokens of `globals.css` (shared with the public pages, so they are
not changed here). Hierarchy comes from weight, size and space rather than new colours:

| Role | Choice |
| --- | --- |
| Surfaces | `background` for pages, `muted/40` for the navigation rail, `card` with a border for grouped content |
| State colour | only for state: `success` running/ready, `warning` starting/stopping, `destructive` failed |
| Type | system sans; page title 24px semibold, section 16px semibold, body 14px, facts 12–14px muted labels |
| Identifiers | monospace only for machine ids (sandbox ids, snapshots, paths) |
| Spacing | 4px grid; 24px between page sections, 12px inside a group |
| Radius | `rounded-lg` for groups, `rounded-md` for controls inside them |
| Motion | none beyond the existing focus and pending indicators |

Group labels in the navigation are sentence case (`Run`, `Build`, `Account`), not uppercase.
