# Armada glossary

Use these names in product copy. Command names, flags and API fields in code
examples use their literal spellings.

| Term | Meaning |
| --- | --- |
| **Snapshot** | A saved workspace used to start a sandbox. Build one for your provider or Docker host. The CLI command group is `armada snapshot`; the API uses paths such as `/api/v1/golden/list`, and MCP launch takes a `golden` field. |
| **Sandbox** | The isolated environment where an agent works. Use the Armada sandbox ID for control requests. |
| **Agent** | The coding program running in a sandbox (Claude Code, Codex, OpenCode or Antigravity). Select its type with CLI `--agent` or the API's `harness` field. A conversation is the session with that agent; a turn is one prompt and its work. |
| **Model account** | A saved connection used to run an agent with a model. A **credential** is the authentication material for a connection, such as an API key or subscription login. Manage model accounts in **Models** or with `armada account`. |
| **Template** | A reusable launch configuration. Publishing creates a **template version**. The API uses `revision` and the CLI uses `--revision` to select a version. |
| **Variable** | Readable key-value configuration stored in **Variables** (personal or organization-scoped) and injected into sandboxes as environment variables via templates or Docker launches. Anyone who can use it can view its value. |
| **Secret** | Write-only, encrypted key-value configuration stored in **Variables** and injected into sandboxes as environment variables via templates or Docker launches. Its value is never shown again after storage; keep model provider keys in **Models**. |
| **Tool (MCP)** | An external MCP server connected in **Tools** that agents inside sandboxes can call. Attach tools to templates or select them at launch (`--connections`). Distinct from Armada's own `/mcp` endpoint used by external clients to drive Armada. |
| **Skill** | A reusable instruction pack loaded by an agent at launch to perform a specific kind of task, pinned as `slug@version` from Skillpack. Manage private Skillpack credentials in **Skills**. |
| **Routine** | A recurring schedule in **Routines** that launches a pinned template version on a five-field cron cadence (with an IANA time zone) as its owner. |
| **Inbound trigger** | An organization-admin webhook endpoint in **Inbound triggers** that launches a saved template automatically when matching external events arrive. |
| **Machines** | The dashboard destination for organization compute setup. **Cloud providers** is its Boat and Modal section. **Docker hosts** is its section for registered Linux machines running Docker. Use **Docker host** for one such machine. |
| **Sandbox provider** | The compute backend that runs a sandbox. Boat and Modal are cloud providers. Docker runs on a registered Docker host. |
| **Service token** | A revocable Armada bearer for an integration. A **viewer token** is a short-lived bearer scoped to a single sandbox's viewer routes. It acts as the service token that minted it, including for sends. |
| **Armada API key** | The dashboard name (under **Your connections → Armada API keys**) for an organization-scoped **service token** used by CLIs, scripts, and external MCP clients (`ARMADA_TOKEN`) to launch and manage sandboxes. |
