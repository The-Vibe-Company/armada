# armada-server: lifecycle and contract rules

These rules add to the root `AGENTS.md`. The coordinator pastes this file into lifecycle and surface tickets.

## Sandbox lifecycle

Scope: `packages/mcp-server/src/sandbox-lifecycle.ts`, `packages/mcp-server/src/sandbox-activity.ts`, `packages/mcp-server/src/sandbox-finish.ts`, `packages/mcp-server/src/sandbox-extend.ts`, `packages/mcp-server/src/sandbox-outputs.ts`, `packages/mcp-server/src/sandbox-pull-requests.ts`, `packages/mcp-server/src/sandbox-account-change.ts`, `packages/mcp-server/src/server-workers.ts`, `packages/mcp-server/src/runtime-launch.ts`, `packages/mcp-server/src/runtime-resume.ts`, `packages/mcp-server/src/runtime-resume-placement.ts`, `packages/mcp-server/src/boat-runtime-resume.ts`, `packages/mcp-server/src/modal-runtime-resume.ts`, `packages/mcp-server/src/docker-runtime-lifecycle.ts`, `packages/mcp-server/src/docker-normal-launch.ts`, and every statement that writes `sandboxes`.
Authority: `docs/state-model.md`.

1. **Single status writer.** Put new TypeScript table writes with the owner in `scripts/ci/tables.ts`. Keep new and changed status writers in the sandbox lifecycle module. Changes to `sandboxes.status` and `lifecycle_generation` use a compare-and-set on the expected states and generation. Zero rows matched means you lost a race: re-read and decide. Never retry blindly or overwrite.
2. **Machine state is not turn activity.** Queued, dispatching and uncertain turn detail lives in the turn tables, never in new status values.
3. **One lease, one deadline per sandbox.** The worker running the current operation holds them. Provider adapters, collectors, exporters and side effects hold no lease and renew none. Do not add a lease, fence or `*_lease*` column; if you think you need one, write it in the design note and stop.
4. **Generation fences new work.** Every new or changed job, runtime command, provider call and completion write carries `(sandboxId, generation)`. A handler that sees a newer generation does nothing.
5. **Durable intent before an external call.** Record the phase before calling the provider and the outcome after. Every `await` after a durable write is a crash point; the design note says who finishes it.
6. **Unknown outcomes are observed, not assumed.** A timeout, lost response or crash is resolved by observing the provider and retrying idempotently, never by guessing. A missing App, image or host is not "sandbox gone".
7. **No new cleanup loop.** Do not add per-path cleanup loops, in-process retry timers or fire-and-forget promises to cover a crash. Make the operation reconcilable instead.
8. **Side effects never gate state.** Output capture, exports, webhooks, PR scans and image collection run after the transition, under their own deadline. They never delay a stop, delete or receipt. A timed-out side effect commits nothing.
9. **Readiness on the Armada runtime path comes only from runtime enrolment**, never from a provider observation, a host ACK or a job completing.
10. **No new claim loop.** New background work extends an existing lane in `packages/mcp-server/src/server-workers.ts`. Never write a new claim loop, outbox table or lane.
11. **Three providers.** A lifecycle change states its Boat × Modal × Docker behaviour. Staging proves Modal and Docker; Boat evidence is the coordinator's.

### Design note (required for every change in scope)
Written in the issue before code. It covers:
- the invariants above that the change touches;
- a state table: from, to, writer, trigger;
- the crash points and who finishes each;
- who else can act on the same sandbox and generation;
- the Boat × Modal × Docker matrix;
- what is out of scope.
Review checks the code against the note. A gap in the note is one finding, not one finding per crash point.

### Tests
- Each new crash point gets a test that injects the failure at that step, at the handler-plus-migrated-SQL boundary. No real provider, no child process, no sleep.

## Public surface

Scope: `packages/mcp-server/src/control.ts`, `packages/mcp-server/src/control-tool-routes.ts` and other control route files, `packages/mcp-server/src/tools.ts`, `packages/mcp-server/src/public-rest-routes.ts`, `packages/mcp-server/src/openapi.ts`, `packages/core/src/contract/launch.ts`, `packages/mcp-server/src/launch-request-schema.ts`, `packages/mcp-server/src/launch-response-schemas.ts`, and their callers in `packages/sdk`, `packages/cli`, `apps/dashboard`, `apps/ios` and `.agents/skills/armada`.
Authority: `docs/api/README.md`, `docs/sdk.md`.

1. **The schema is what the handler does.** Every shape a handler can return, including refusals, `retryAfter`, nulls and every provider variant, is in its output schema. A test passes the handler's real responses through the published schema.
2. **One schema per request and response.** Never write a second validator or TypeScript type for the same shape; import the existing one.
3. **No compatibility** (root rule 1). Replacing a route, tool or field deletes the old one. Older released clients may break.
4. **Admin operations** belong in the dashboard. Add no dedicated MCP tool or CLI command for them.
5. **The SDK is published.** Changing a public type updates `packages/sdk/test/npm-smoke.types.ts` and `docs/sdk.md` in the same PR.
6. **Errors.** Refusals carry a typed code from `packages/core/src/api-failure.ts`. The status tells a definite refusal from an uncertain outcome. Never copy upstream or proxy bodies into public messages.
7. **Generated artifacts are regenerated, never hand-edited**: `packages/mcp-server/openapi.json` (`bun scripts/generate-openapi.ts`) and the iOS harness (`bun scripts/generate-ios-harness.ts`).

### Breaking-change lines in the PR body
- `Surface changed:` the operations, and the callers updated.
- `Coordinator commands affected:` a list, or `none`.

### Tests
- One test per operation at the handler boundary, with a real schema parse. No HTTP server process.
- `scripts/armada-skill.test.ts` checks the skill against CLI help: fix the skill, do not loosen the test.

## Server SQL
- SQL in `packages/mcp-server/src/data.ts` and other server modules bypasses row-level security. Each query enforces the caller's visibility itself.
