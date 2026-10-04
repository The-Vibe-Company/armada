repo: The-Vibe-Company/armada
branch: main
path: packages/dashboard

## Last sync
date: 2026-10-04T17:36:15Z

### Updated in this project
- Refonte sobre du dashboard : vue d'ensemble en liste groupée par état (2 directions)
- Pages agent, projet, validations, activité, insights, organisation simplifiées

## Screen map
| Screen | Source |
|---|---|
| Shell / sidebar | packages/dashboard/components/shell/Shell.tsx |
| Vue d'ensemble | packages/dashboard/components/screens/OverviewScreen.tsx, SessionCard.tsx, AgentRow.tsx |
| Agent | packages/dashboard/components/screens/AgentScreen.tsx |
| Projet | packages/dashboard/components/screens/ProjectScreen.tsx |
| Validations | packages/dashboard/components/screens/ValidationsScreen.tsx |
| Données démo | packages/dashboard/lib/demo/world.ts |
