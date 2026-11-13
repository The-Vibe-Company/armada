# Orchestrator retirement: deferred database plan (#1382, step 2)

Step 1 removes the feature's server, CLI, dashboard, smoke and documentation
surfaces. There is no compatibility route or feature flag. Ordinary sandboxes,
templates, routines and scoped child access remain supported.

## Authorization gate

Do not write or apply the step-2 migration until the coordinator confirms that
step 1 has run in production for a full day. The coordinator must retain the
ability to roll back step 1 during that observation window. Agents must not
apply migrations or deploy either step.

After deployment, the coordinator checks the non-tolerated staging smoke steps,
confirms no `orchestrator_operation_failure` log entries and verifies the
removed dashboard entry stays absent. This document is not deployment evidence.

## Separate migration PR

Inventory the live schema and dependencies before authoring a new, uniquely
versioned migration newer than main. Drop only obsolete orchestrator tables,
columns, functions, policies and grants; preserve scoped-child access and its
attribution, authority and lifecycle fences. Regenerate database types only
after the schema change and run the real migration/security tests and full
`bun run verify`. Historical applied migrations are immutable.

## Intentionally retained shared/schema identifiers in step 1

The generated database contract and `scripts/db/generate.ts` still describe
orchestrator tables because step 1 does not change the database. Schema-only
checks may still mention those names. They are removed with the authorized
step-2 migration, not by falsifying the generated contract now.

The existing scoped sandbox wire namespace `armada_orchestrator` and private
`orchestrator-tools` paths remain shared access contracts, not the removed
owner-facing feature. Their smoke probes must retain those exact identifiers
until a separately authorized wire-contract change. Legacy managed-resource
exclusions remain fail closed while their schema exists; this is not an active
reconciler or a compatibility API.
