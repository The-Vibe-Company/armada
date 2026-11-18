# Navigation clarity completion — #1038

Audit baseline: main at `f085c5ea`. The owner-approved replacement supersedes the original five-group proposal. This record reconciles delivered behavior with that decision; it adds no product behavior.

## Acceptance evidence on main

| Owner requirement | Implementation | Existing evidence |
| --- | --- | --- |
| Group labels and items only; no descriptive sidebar sentences | [Navigation component](../../apps/dashboard/src/components/nav-links.tsx) renders group labels and destination names; collapsed tooltips repeat names | [Sub-text removal captures](sidebar-no-subtext.md) |
| Run contains Sandboxes, Routines, Templates; Library contains reusable ingredients; Account calls Harness “Models” | [Navigation data](../../apps/dashboard/src/lib/navigation.ts); Models retains `/harness` | [Approved structure and light/dark desktop/phone captures](navigation-structure.md) |
| shadcn Sidebar primitives, active state, collapsed and phone layouts | [Navigation component](../../apps/dashboard/src/components/nav-links.tsx), [responsive shell](../../apps/dashboard/src/components/app-sidebar.tsx), [Sidebar primitives](../../apps/dashboard/src/components/ui/sidebar.tsx) | [Archived navigation browser spec](https://github.com/The-Vibe-Company/armada/blob/a08022c6970f77aec91345e492af4af59401e76d/apps/dashboard/e2e/navigation.e2e.ts) |
| Template ingredients link to their management pages | [Template page](../../apps/dashboard/src/app/(app)/templates/page.tsx) links snapshots, model accounts, skills, tools, variables and secrets | [Template link captures](template-cross-links.md), [archived browser spec](https://github.com/The-Vibe-Company/armada/blob/a08022c6970f77aec91345e492af4af59401e76d/apps/dashboard/e2e/templates.e2e.ts) |
| Library pages link back to templates using them | [Shared usage panel](../../apps/dashboard/src/components/template-usage.tsx), [snapshot usage](../../apps/dashboard/src/components/environment-templates.tsx), [Skills](../../apps/dashboard/src/components/pages/skills-content.tsx), [Tools](../../apps/dashboard/src/app/(app)/tools/page.tsx), [Variables](../../apps/dashboard/src/components/pages/variables-content.tsx) | [Integrated relationship captures](navigation-structure.md#relationships-on-the-pages-not-in-the-menu) |
| Launch ingredients follow Library order | Snapshot is chosen before the [launch dialog](../../apps/dashboard/src/components/launch-dialog.tsx); its supported ingredient controls show skills before tools. Variable/secret bindings come from [saved templates](../../apps/dashboard/src/components/templates.tsx) | [Integrated implementation record](navigation-structure.md#implementation) |

Usage counts cover caller-visible current template revisions, including blocked launches. Unreadable revisions remain partial/unknown. Skills usage counts templates containing skill pins, not Skillpack-key use. These are intentional limits, not total organization-wide usage claims.

The original proposal also suggested contextual empty states. Templates already explains saving a reusable launch setup; Tools explains connecting services; Variables explains binding configuration/secrets through templates. The owner-approved replacement did not require a first-use diagram, running-sandbox counts or a new model-account usage query. No extra features are needed to close this navigation ticket.

## Preserve later product decisions

The approved three-group layout shipped before subsequent navigation work. #1478 removed the Organizations destination, #1484 added Providers, #1488 renamed Environments to Snapshots, and #1774 moved its canonical route to `/snapshots`. Current navigation data is authoritative. Reinstating the historical diagram would undo later work outside #1038.

The earlier option comparison remains in [the original proposal](navigation-clarity.md), explicitly marked rejected. The owner chose the structure documented in [the approved replacement](navigation-structure.md), with relationships on pages rather than explanatory menu text. The screenshot sets linked above are historical evidence from those slices, not fresh captures or proof of a deployed staging check. This documentation-only reconciliation changes no screen, route, launch behavior, schema or deployment prerequisite.
