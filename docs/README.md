# Documentation

Choose a starting point below; these are selected guides, not an inventory of every document.

## Use

- [Onboarding](dave-onboarding.md): connect an organization, provider, model credentials and GitHub, then launch through the CLI or MCP.
- [Goldens](golden-create.md) and [build jobs](golden-build-jobs.md): create a workspace and track durable build outcomes.
- [Templates CLI](templates-cli.md): use published launch presets; consult its stated limits rather than assuming all proposed template features are available.
- [Armada skill installation](armada-skill-install.md): install the pinned tool-knowledge skill for your coding agent.
- [Organization invitations](cli-invitations.md): distinguish direct membership from invitations and explicit acceptance.

## Develop

- [Self-hosting and local development](self-hosting.md): configure and run the server and dashboard.
- [CLI/web parity](cli-web-parity.md) and [paging/JSON contract](cli-web-parity-556.md): complementary interface contracts.
- [API error codes](api-error-codes.md) and [event history](events-history.md): failure and event-stream contracts.
- [Template staging checklist](templates-staging.md): slice-specific operator validation, distinct from the user workflow and from [proposed template guarantees](design/templates-variables-secrets.md).

## Operate

- [GitHub App setup](github-app.md): configure sandbox GitHub identity.
- [Database migrations](database-migrations.md) and [releasing](releasing.md): operator-controlled schema history and package releases.
- [Post-deploy smoke](post-deploy-smoke.md): deployment validation, not proof that a deployment has already passed.
- [Work preservation](work-preservation.md), [Modal stop recovery](modal-stop-recovery.md) and [Modal builder recovery](modal-builder-recovery.md): preservation limits and authorized recovery.
- [Orchestrator troubleshooting](orchestrator-troubleshooting.md): retained compatibility/recovery guidance for existing orchestrator resources, not a new launcher workflow.

## Designs and historical evidence

The [original v2 specification](https://github.com/The-Vibe-Company/armada/issues/455), [design proposals](design/), [research](research/) and investigations such as [sandbox expiry](sandbox-expiry-investigation.md) retain design intent and operational evidence. Read their scope and status: a proposal, staging checklist or incident record is not a universal supported or deployed contract. These documents remain separate from the guides above.
