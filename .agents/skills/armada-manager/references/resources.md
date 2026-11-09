# Compute, snapshots and provider evidence

## Lifecycle

Track starts and start-rate limits as well as concurrent machines. A stop/resume cycle may consume another start. A box waiting for CI, a review result, integration or a followup on its own ticket remains part of the process. Do not keep a completed box as a pool for unrelated tickets.

Before a lifecycle action, identify the exact logical ID, physical ID, provider, owner, organization and assigned role. User-created or ambiguous resources stay outside an owned cleanup list. Record why the role is terminal, stop through the supported interface, then confirm provider state and settled prompt state. An initial `stopping` answer is not confirmation of archive.

Extend an active role's deadline early using supported, authorized in-place tooling. If provider and Armada maintain separate deadlines, both must be synchronized and read back. A continuation of an agent turn is different from restarting its machine. Preserve work and state on either path; use a fresh sandbox only for a justified need.

An unknown create/delete/snapshot outcome is not a retry invitation. Retain its operation key, immutable target and provenance, then reconcile through the provider's exact owned resource identity. A missing result, null physical ID or not-found lookup alone may leave an asynchronous create unresolved. Use the server's recovery path; do not work around its fences with ad hoc database changes or another create.

## Goldens

A golden is built and saved for its provider. Boat saved handles and Modal images are not interchangeable. Select the exact provider, backend authority and repository configuration; do not fork another provider's snapshot or silently pick an unrelated golden.

Observe a replacement reaching ready and being successfully published before retiring a superseded artifact. Use the product's retention/reconciliation mechanism and its provenance/reference checks. Current pointers, aliases, in-flight operations and uncertain receipts matter. A prefix, age or removed history row does not prove deletion is safe. A committed build can succeed while cleanup is deferred; report those outcomes separately.

## MCP validation

Separate these observations: connection configured, authorization connected, binding selected for a sandbox, native harness discovery, and successful tool execution. Each proves a different part of the path.

Use the actual configured server alias and a harmless read-only tool. For a requested provider/harness matrix, collect native tool-call/result and completed-prompt evidence for each cell. A generic SDK request or configuration file alone does not prove Claude Code or Codex sees the tool. Do not claim an untested cell.

Inspect existing bindings before allocating a smoke sandbox. Respect immutable selections and personal/private versus shared/organization scope. Where a fresh resource is necessary, use a supported launch with an explicit connection, a bounded TTL and a single-purpose prompt. Stop it after the complete smoke role, or retain it for a concrete repair/retest while preserving its deadline. Keep upstream credentials out of sandbox logs; use the gateway's scoped authorization.
