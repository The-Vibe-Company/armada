# Orchestrator retirement (#1382)

Step 1 (#1396) removed the owner-facing feature from the server, CLI, dashboard,
and smoke tests. The coordinator recorded the production deployment and set
November 14, 2026 as the earliest date for schema retirement. This allowed a
full day to roll back step 1. [Coordinator record in #1382](https://github.com/The-Vibe-Company/armada/issues/1382)

## Retired schema

The #2718 migration drops the tables below and their table-owned policies,
grants, indexes, constraints, and event identity sequence.

- `orchestrator_activity`
- `orchestrator_lifecycle_mutations`
- `orchestrator_operations`
- `orchestrator_runtime`
- `orchestrator_runtime_create_keys`
- `orchestrator_runtime_events`
- `orchestrator_waits`

## Scoped child access

Scoped access still uses `orchestrators`, `orchestrator_children`,
`orchestrator_delegations`, `orchestrator_child_operations`, and
`orchestrator_lifecycle`. These tables and their authorization and lifecycle
guards preserve child ownership, operation receipts, and admission limits.
Ordinary sandboxes, templates, and routines remain supported.

The `armada_orchestrator` wire namespace and private `orchestrator-tools` paths
are part of the scoped access contract. Managed-resource exclusions continue
to fail closed.
