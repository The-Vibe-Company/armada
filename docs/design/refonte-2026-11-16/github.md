repo: The-Vibe-Company/armada
branch: main
path: apps/dashboard

## Last sync
date: 2026-11-16T19:50:40Z

### Updated in this project
- Machine sizes (small 2/4, medium 4/8, large 8/16, xlarge 16/32) from packages/core/src/machine-size.ts
- Size chosen per snapshot, template, launch, provider default and Docker host
- Launch dialog redesigned as a composer with inline pickers

## Screen map
| Screen | Built from |
| --- | --- |
| Shell / navigation | apps/dashboard/src/lib/navigation.ts, components/nav-links.tsx, components/landing/Mark.tsx |
| Sandboxes, sandbox thread | app/(app)/sandboxes, lib/status-tone.ts |
| Launch dialog | components/launch-sentence.tsx |
| Machine sizes | packages/core/src/machine-size.ts, components/machine-size-field.tsx |
| Logos | components/provider-marks.tsx, components/provider-mark.tsx |
| Catalog pages (Templates, Snapshots, Models, Tools, Skills, Machines) | app/(app)/* pages, README.md |
| Visual system | The-Vibe-Company/skillpack DESIGN.md, armada docs/dashboard-design.md |

## Sync history
- 2026-11-16T19:27:21Z: catalog pages on one card + drawer pattern, real logos
- 2026-11-16T19:05:12Z: first build of the dashboard concept
