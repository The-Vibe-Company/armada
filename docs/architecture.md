# Armada architecture

Armada launches and controls coding agents. Clients own workflow orchestration,
including waiting, coordinating other agents and deciding when to launch more work.

## Target

1. Run one TypeScript/Bun server backed by PostgreSQL. Keep the CLI and SDK API-only.
2. Run Claude Code, Codex and OpenCode through the Armada runtime on every provider.
   Bind each sandbox to one conversation and explicit credentials, and support pinned stdio MCP servers.
3. Use one machine contract for Boat, Modal and Docker, with capability-based decisions
   and an inventory reaper for machines that have no live database owner.
4. Run lifecycle operations through a durable jobs runner with one lease and one
   deadline per sandbox. Fence work by generation and reconcile unknown provider outcomes.
5. Give sandbox state one writer and model turn activity separately from machine state.
6. Persist events across deploys and push them to consumers over SSE.
7. Define each public operation once. Project the contract into REST, OpenAPI, MCP,
   SDK and CLI, with dashboard administration and an API escape hatch in the CLI.
8. Select from ordered account pools, track health until reset, enforce USD monthly
   budgets at admission and generate one model catalog.
9. Admit authenticated inbound triggers and schedule routines through the same jobs runner.
10. Keep the Docker daemon outbound-only. Make Modal snapshots optional only if
    measurements show that cold initialization can meet the launch target.

## Modules in the current tree

| Module | Files and directories |
|---|---|
| Sandbox lifecycle | `packages/mcp-server/src/sandbox-lifecycle.ts`, `packages/mcp-server/src/sandbox-activity.ts`, `packages/mcp-server/src/sandbox-finish.ts`, `packages/mcp-server/src/sandbox-extend.ts`, `packages/mcp-server/src/sandbox-outputs.ts`, `packages/mcp-server/src/sandbox-pull-requests.ts`, `packages/mcp-server/src/sandbox-account-change.ts`, `packages/mcp-server/src/server-workers.ts`, `packages/mcp-server/src/runtime-launch.ts`, `packages/mcp-server/src/runtime-resume.ts`, `packages/mcp-server/src/runtime-resume-placement.ts`, `packages/mcp-server/src/boat-runtime-resume.ts`, `packages/mcp-server/src/modal-runtime-resume.ts`, `packages/mcp-server/src/docker-runtime-lifecycle.ts`, `packages/mcp-server/src/docker-normal-launch.ts`, `packages/mcp-server/src/provider-reaper.ts` |
| Runtime | `packages/agent-runtime/src/main.ts`, `packages/agent-runtime/src/journal.ts`, `packages/agent-runtime/src/claude.ts`, `packages/agent-runtime/src/codex.ts`, `packages/agent-runtime/src/acp.ts` |
| Providers | `packages/core/src/sandbox-provider.ts`, `packages/provider-boat`, `packages/provider-modal` |
| Docker host | `packages/docker-host/src/daemon.ts`, `packages/docker-host/src/service.ts`, `packages/docker-host/src/container-inventory.ts` |
| Contract and surface | `packages/core/src/index.ts`, `packages/mcp-server/src/control.ts`, `packages/mcp-server/src/tools.ts`, `packages/mcp-server/src/openapi.ts`, `packages/sdk`, `packages/cli`, `apps/dashboard`, `apps/ios` |
| Accounts | `packages/core/src/credentials.ts`, `packages/core/src/models.ts`, `packages/core/src/account-binding-policy.ts`, `packages/mcp-server/src/runtime-account-admission.ts`, `packages/mcp-server/src/model-usage.ts` |

The server assembles HTTP, MCP, provider adapters and workers in
`packages/mcp-server/src/serve.ts`. The runtime owns sandbox-local agent
execution, while the server owns access and persistence.

## Deployment overlap

Delete replaced public surfaces and update their callers in the same ticket.
Three contracts retain an N/N−1 overlap: database objects, the runtime protocol
and the Docker host daemon protocol. First deploy code that no longer uses the
database object and confirm older processes have exited. Ship the drop in a
later deploy. See [deployment draining](deployment-draining.md) and
the [migration checklist](database-migrations.md).

## Status by step

| Step | Current state |
|---|---|
| 0 · Foundations | Runtime and Docker host connections already carry work, and a provider reaper and break-glass launch guide exist. Several reads still poll. |
| 1 · Runtime parity | The Armada runtime and the provider-run Boat and Modal paths coexist. Docker uses the runtime. |
| 2a · Machines and jobs | Provider lifecycle and launch paths still use provider-specific adapters and separate worker lanes. |
| 2b · Public contract | REST, MCP, OpenAPI, SDK and CLI have separate definitions with some shared schemas. |
| 3 · State and events | Server modules persist lifecycle and turn data. Consumers still use cursor reads and polling. |
| 4 · Accounts | Explicit bindings, admission checks, usage records and model catalogs exist. Ordered pools and USD budgets are target work. |
| 5 · Triggers and routines | Scheduled routines have a dedicated worker. Goldens use provider snapshots; Docker also supports plain images. |
