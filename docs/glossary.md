# Armada glossary

Use these names in product copy. Command names, flags and API fields in code
examples use their literal spellings.

| Term | Meaning |
| --- | --- |
| **Snapshot** | A saved workspace used to start a sandbox. Build one for your provider or Docker host. The CLI command group is `armada snapshot`; the API and MCP use `golden` and names such as `golden_list`. The existing maintenance command `armada snapshot snapshot` scans and saves a prepared master sandbox. |
| **Sandbox** | The isolated environment where an agent works. Use the Armada sandbox ID for control requests. |
| **Agent** | The coding program running in a sandbox (Claude Code, Codex or OpenCode). Select its type with CLI `--agent` or the API's `harness` field. A conversation is the session with that agent; a turn is one prompt and its work. |
| **Model account** | A saved connection used to run an agent with a model. A **credential** is the authentication material for a connection, such as an API key or subscription login. Manage model accounts in **Models** or with `armada creds`. |
| **Template** | A reusable launch configuration. Publishing creates a **template version**. The API and CLI flags use `revision`, for example `--revision` and `--expected-revision`. |
| **Machines** | The dashboard destination for organization compute setup. **Cloud providers** is its Boat and Modal section. **Docker hosts** is its section for registered Linux machines running Docker. Use **Docker host** for one such machine. |
| **Sandbox provider** | The compute backend that runs a sandbox. Boat and Modal are cloud providers. Docker runs on a registered Docker host. |
| **Service token** | A revocable Armada bearer for an integration. A **viewer token** is a short-lived bearer scoped to a single sandbox's viewer routes. It acts as the service token that minted it, including for sends. |
