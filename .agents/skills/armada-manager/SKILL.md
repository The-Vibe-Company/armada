---
name: armada-manager
description: Coordinate parallel Armada coding sessions through focused issues, coordinator-launched independent review, CI, authorized merges and resource cleanup. Use when managing several Armada workers or recovering an existing fleet of sandbox sessions.
---

# Armada Manager

Armada supplies the sandboxes and agent sessions. You own the coordination: keep independent work moving, give each workstream a delivery owner, and close it with observed evidence. Preserve the user's scope, model choices and existing authorization.

## Establish the live picture

Read the repository's instructions, the installed Armada version/help and the selected account/organization. Use the available CLI or connected Armada tools; terminal access needs the Armada instance and sign-in, not Supabase or provider keys. Avoid commands remembered from a different Armada edition.

Inspect existing sessions before allocating compute. Record each owned role's issue, branch/worktree, logical and physical IDs, provider, harness/model, current phase, PR/head, deadline, next action and evidence paths. Separate user-owned sessions from coordinator-owned resources. Keep this ledger outside committed source unless the project asks otherwise; omit credentials and raw transcripts.

## Dispatch ownership in parallel

Cut independent fixes into separate issues and PRs, with closing references, targeting main unless the repository or user specifies another base; group only when the user requests it. Assign shared contracts to one producer and give consumers its actual versioned types or source, not a guessed DTO. Dependent UI can progress against that contract while the producer works.

Delegate implementation **and delivery** for each workstream: scoped files, completion criteria, original session, author self-check, tests, CI repair and hand-back. For a larger fleet, a lane owner can supervise several workers. Choose one integrator for serial merges and deployment; routine ready hand-backs go directly to that integrator. Keep only unresolved product choices or genuinely cross-cutting conflicts with the root coordinator.

Use one dedicated agent and sandbox per ticket and PR, with the user's requested harness/model routing and the instance's capabilities. Resume that agent for corrections on its own ticket; do not assign another ticket to it or keep it open for a future assignment. Read [work-orders.md](references/work-orders.md) when preparing a handoff or resuming an unfamiliar fleet.

## Supervise without thrashing

Read incremental events and current prompt/provider state. A quiet transcript alone does not establish that a role is finished. Give each active role a concrete next action; distinguish implementation, review, external CI, integration and a real blocker.

Let workers finish active reviewer/test subprocesses before routine feedback. Queue a concise correction for the next checkpoint. If a turn is genuinely stalled, preserve its work and use one targeted continuation supported by the runtime; distinguish an agent-turn continuation from a provider VM restart. Repeatedly sending the same instructions is not progress.

Drive the dependency frontier, not an issue-at-a-time queue. Repair known blockers, route ready work to the integrator, and leave other lanes running. Send the user meaningful outcomes or needed decisions rather than unchanged poll snapshots.

## Close delivery with evidence

Run the repository's `ship-pr-dev` workflow **inside the worker's original Armada session**. The skill is unchanged: the worker completes its own independent review gate and ends with READY TO MERGE or BLOCKED, without needing Armada launch authority. After a READY TO MERGE receipt, the coordinator may launch an additional separate reviewer using [reviewer.md](references/reviewer.md), through its CLI or an orchestrator parent scoped launch tool, and always stops it. The capture-learning-tools dependency must be discoverable in the worker. Install missing packages through the supported installer or repository sources before claiming the workflow ran. Read [delivery.md](references/delivery.md) for review, source freshness, merge and release gates.

When the user's request includes automatic merges, the integrator completes them after the agreed gates; it does not wait for an extra root acknowledgment. Product rejection supersedes an earlier approval. Required visual or functional findings remain blockers until fixed or explicitly accepted by the user.

## Keep compute aligned with the role

Implementation, active review, CI waiting, fixes and integration are all part of an unfinished role. Keep that sandbox warm. Track its real deadline and arrange a supported in-place extension early when needed; retain a bounded TTL. Do not invent an extension flag or disable expiry to avoid a capability gap.

Record a terminal reason, then stop compute only after all of that role's assigned work and verification are complete. Confirm both Armada and provider state. A completed role is stopped after its own ticket is delivered; the next ticket receives its own agent and sandbox. Read [resources.md](references/resources.md) for lifecycle uncertainty, provider-specific goldens and native MCP validation.
