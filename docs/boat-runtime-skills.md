# Boat runtime skills staging check (#1161)

The opt-in Boat runtime now uses the **existing** launch `skills` pins and
`skipSkillDefaults` policy (environment → organization → personal → explicit
pin overrides). There is no public skill setup endpoint or second installer.
After enrolled readiness and before automatic MCP setup / first inference, the
launcher sends a private, epoch-fenced install command. Receipts are persisted
in `sandbox.skills`, just as for native launches. Failure stops the launch;
there is no SSH / Boat native runner fallback.

Qualified public pins install anonymously. Bare private pins use the existing
actor-scoped Skillpack credential in Armada's encrypted vault; it reaches only
the fixed foreground installer child's environment. It is not a model
credential, command argument, journal entry or API receipt. The guest validates
pinned lockfile/checksum/target/workspace receipts and adds native-equivalent
Git exclusions. Revocation/shutdown cancels the owned process group before the
runtime closes its journal. Old runtime artifacts refuse before key delivery.
Resume retains project files, including user edits, without reinstalling.
Arbitrary enrolled `exec` remains disabled.

## ONE staging launch, batched with MCP / GitHub / checkpoint / resume

Use the **armada-server staging HTTPS origin** and existing Armada login/token,
organization, golden and Codex credential inputs documented in
[the MCP check](boat-runtime-mcp.md). Choose one existing default-for-launch
remote MCP connection and read-only tool, the linked user's existing repository,
and two **existing** skills: one `org/slug@exact-version` public pin and one
`slug@exact-version` private pin. The private Skillpack PAT stays in the vault;
never put it in this command or a prompt. Use distinct skill slugs. Expected
substrings must be non-secret, stable text from each installed `SKILL.md`.
Existing skill defaults are deliberately enabled; this verifies the actual
launch policy, not an isolated manual install.

```bash
export ARMADA_RUNTIME_SKILLS_JSON='[{"reference":"PUBLIC_ORG/PUBLIC_SLUG@1.2.3","expect":"known non-secret public SKILL.md text"},{"reference":"PRIVATE_SLUG@2.3.4","expect":"known non-secret private SKILL.md text"}]'
# Replace uppercase placeholders with real, lowercase pins before running.
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --skills --mcp --github --resume
```

The existing `ARMADA_RUNTIME_MCP_CONNECTION_ID`, `ARMADA_RUNTIME_MCP_TOOL`,
`ARMADA_RUNTIME_MCP_ARGS_JSON`, `ARMADA_RUNTIME_MCP_EXPECT`, and
`ARMADA_RUNTIME_GITHUB_REPOSITORY=owner/repo` inputs are unchanged. Server and
pinned guest artifacts must come from the skills-capable revision:
`launch/options.boatRuntime.skillsVersion === 1`; artifacts are published by
the server image, **not** manually.

Expected: one sandbox allocation, four same-conversation prompts, one explicit
checkpoint/resume activation (epoch +1), two stops, no allocation retry. Before
the first prompt the response must contain both verified skill receipts. On
each prompt, including the first resumed one, archived `source: armada-runtime`
`message.tools` must contain successful `commandExecution` reads of both
`.agents/skills/<slug>/SKILL.md` with the expected file contents. The verifier
never sends those expected contents to the model. It also requires successful
MCP server/tool/exact-argument provenance, current-epoch GitHub credential
acquisition, original remembered token, terminal events and stopped history.
Final output includes `skills: verified`, `skillsAfterResume: verified`,
`mcpAfterResume: verified`, `githubAfterResume: verified` and `resume: verified`.
A receipt or model assertion alone is **not** parity proof. Stop on failure;
report the sandbox ID and reason rather than spending another Boat start.

Local tests exercise the real guest subprocess/Skillpack lockfile protocol
with an offline CLI peer, cancellation of descendants, Core default merging /
launch ordering and old-artifact/epoch/key-delivery guards. Real staging skill
parity remains pending the coordinator's check. Claude admission is a later
slice; this does not enable it or change native/default routing.
