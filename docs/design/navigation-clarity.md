## Navigation clarity — first slice
Refs #1038. No closing keyword: cross-links and empty states remain follow-up slices.

### What connects
A sandbox starts from an environment (repositories + machine image), runs Claude Code or Codex via a harness account/model, and receives tools, skills and variables. A template saves that combination. Routines will launch templates on a schedule; this PR adds no future route.

### Options and mockups
**A — relationship groups (recommended, implemented).** Replace the overloaded Build bucket with task-language groups. Keep familiar page names and URLs; no new conceptual destinations.
```text
Before                    After
Run                       Run
  Sandboxes                 Sandboxes
Build                     Start with
  Environments              Environments
  Templates                 Harness
  Tools                   Give the agent
  Skills                    Tools
  Variables                 Skills
  Harness                   Variables
Account                   Save a combination
  Organizations             Templates
  Settings                Account
                            Organizations
                            Settings
```
Each heading has one short relationship sentence. Phone navigation uses the same groups and full names, behind a Navigation toggle so conversations retain their height.

**B — flat menu + contextual explanations.**
```text
Build
  Environments   [hover/focus: machine + repos]
  Templates      [hover/focus: saved combination]
  Tools          [hover/focus: connections]
```
Lowest visual change, but relationships stay hidden and hover does not help touch users. Not recommended.

**C — template-centred navigation.**
```text
Run: Sandboxes
Templates
  Environment / Harness / Tools / Skills / Variables
Account
```
Compact, but falsely implies ingredients only exist inside templates; ad-hoc launches are supported. Not recommended.

### Design
Retain the existing Geist typography, graphite surfaces and semantic focus blue. Alignment stays left; grouping and copy do the work, not decorative badges or a tutorial. Existing theme tokens are authoritative. Reviewed shadcn Sidebar (group/label/menu composition), Breadcrumb, Badge, HoverCard and Empty docs. No new UI dependency: this repository currently uses its own NavLinks shell rather than a generated Sidebar component. Breadcrumbs/chips/counters/empty states belong in later slices, not this navigation change.

### Scope / coordination
No changes to #970 visual pass, #1005 Sandboxes, #1007 skill pickers or #1006 Routines pages. No route moves, APIs, queries, permissions or launch behavior changes. Cross-links and empty states deferred to the next slices.

### Validation
Pending local verification, independent review, rendered desktop/phone captures and latest-SHA CI.
