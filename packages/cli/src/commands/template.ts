import { templateCommand } from "../template-commands.ts";
import { vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

function templateDefinitionHelp(action: "create" | "publish") {
  const creating = action === "create";
  return `Usage: armada template ${action} ${creating ? "NAME" : "NAME|ID --expected-revision N"} [definition input] [--org NAME|UUID] [--json]
${creating ? "Create a launch template with its first immutable version." : "Publish a new immutable version of an existing launch template, not a partial patch."}
Requires Armada login or ARMADA_TOKEN. Select an organization with --org or armada org use.
${creating ? "--scope personal|org selects visibility; with explicit --org it is required.\nWithout explicit --org, scope defaults to personal in the selected organization." : "Names must match exactly and identify one active template; use an ID from template list\nif names collide. The target keeps its existing scope.\n--expected-revision is a required positive integer from template get/list.\nA stale version is refused; inspect the current definition before deciding to republish."}
Organization-scoped writes require administrator permission.

Choose ONE complete definition input (file and definition flags cannot be mixed):
  --file definition.json                 Definition object, not an API envelope.
  --golden UUID --provider boat|modal --agent claude|codex|opencode
  --host UUID --provider docker --agent claude|codex|opencode
--golden is the existing snapshot selector. Docker --host requires a UUID, not a name;
it selects the official environment, not a host-local snapshot. Boat supports Claude/Codex.

Optional definition flags (not combined with --file):
  --model ID --reasoning-effort LEVEL
  --connection UUID                      Repeat for multiple MCP connections.
  --variable KEY:UUID:VERSION            Repeat for readable variable references.
  --secret KEY:UUID:VERSION              Repeat for secret references, never raw values.
  --skill PIN                           Repeat for multiple skills.
  --model-account UUID --model-account-version N   Pin an account and positive version.
No local environment expansion. Frozen launch manifests are resolved at launch, not publication.
Readable values can appear in launch manifests; do not use variables for secrets.
Human output shows metadata and current revision; --json emits the API response.
Example: armada template ${action} ${creating ? "nightly --scope personal" : "TEMPLATE_UUID --expected-revision 2"} --file definition.json --org ORG_UUID --json
`;
}

export default {
  name: "template",
  summary: "Manage versioned launch templates",
  usage: { automation: `  armada template --help                   Manage templates and launch published versions` },
  help: `Usage: armada template <command> [arguments]
Manage reusable launch definitions and their immutable template versions.

  create   Create a template from a JSON definition file or definition flags.
  list     List visible IDs, names, scopes, status and current versions.
  get      Inspect metadata or a selected version's definition with --json.
  publish  Publish a complete new version, guarded by --expected-revision.
  delete   Mark a template deleted, guarded by --expected-revision.
  launch   Launch a template version using a saved --request-key for safe retries.

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada org use. Templates may be personal or organization-scoped;
organization-scoped writes require administrator permission.
Use IDs from template list when exact names collide across scopes.
Definitions store variable/secret references; do not put raw secret values in them.
References resolve into frozen manifests at launch, not publication.
After an unknown launch outcome, keep the same request key and body; do not start
a new attempt. See template launch --help for resolved-ID recovery.
Inspect a command's full options with armada template <command> --help.
Example: armada template list --org ORG_UUID --json
Example: armada template get TEMPLATE_UUID --revision 1 --org ORG_UUID --json
`,
  subcommandHelp: {
    "template launch": `Usage: armada template launch NAME|ID --request-key KEY [--revision N] [options]
Launch an existing template, resolving its references into a frozen launch manifest.
Requires Armada login or ARMADA_TOKEN; select an organization with --org NAME|UUID
or armada org use. Find template IDs and current versions with template list/get.
Names must match exactly and identify one active template; use an ID if names collide.

Options:
  --revision N                           Positive version number; omission uses current.
  --prompt TEXT                          Override the launch prompt.
  --ttl <duration>                       Override lifetime, for example 30m.
  --size small|medium|large|xlarge        Override machine size.
  --repo REPO                            Override the initial repository.
  --model-account UUID                   Select an unpinned model account.
  --model-account-version N              Required with --model-account; positive integer.
  --org NAME|UUID                        Organization selector.
  --json                                 Accepted; launch always emits JSON on stdout.
A template version's pinned model account cannot be overridden. No inline environment values
or local environment expansion are supported; definitions hold variable/secret references.

--request-key is required: 1–128 ASCII letters, digits, dots, underscores, colons or hyphens.
Save the key before submission. After an unknown outcome, retry the SAME key and body,
including organization, template version and overrides; never invent a new key for that attempt.
Name-based launch prints the resolved template ID to stderr before submission. Use that ID
for recovery, so a later rename or deletion cannot prevent the original request's replay.
Example: armada template launch TEMPLATE_UUID --request-key audit_run_1 --revision 2 --org ORG_UUID --json
`,
    "template delete": `Usage: armada template delete NAME|ID --expected-revision N [--org NAME|UUID] [--json]
Mark a launch template deleted; this command is not sandbox deletion.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
An organization-scoped template requires administrator permission.
Names must match exactly and identify one active template. Use an ID from template list
when names collide across scopes.
--expected-revision is required and must be a positive integer. Copy the current version
from template get or template list; a stale version is refused, not retried automatically.
On a conflict, inspect the template again before deciding whether to delete the newer version.
Human output shows template metadata and deleted status; --json emits the API response with item.
Example: armada template delete TEMPLATE_UUID --expected-revision 2 --org ORG_UUID --json
`,
    "template list": `Usage: armada template list [--org NAME|UUID] [--json]
List visible launch-template metadata: IDs, names, scope, status and current version.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Use a template ID from this list when names collide across scopes.
--json emits the API response with an items array; human output is a compact table.
Use armada template get ID --json to inspect a definition, not list.
Example: armada template list --org ORG_UUID --json
`,
    "template get": `Usage: armada template get NAME|ID [--revision N] [--org NAME|UUID] [--json]
Inspect a visible launch template; omitted --revision selects its current version.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Names must match exactly and identify one active template; use an ID from template list
when names collide across scopes. --revision is a positive integer.
Human output shows metadata and the selected version, not the definition.
--json emits the API response including item and revision with its definition.
Definitions contain references to variables and secrets, not raw secret values.
This reads a template; it does not publish, launch or resolve a frozen launch manifest.
Example: armada template get TEMPLATE_UUID --revision 1 --org ORG_UUID --json
`,
    "template create": templateDefinitionHelp("create"),
    "template publish": templateDefinitionHelp("publish"),
  },
  helpWhenBare: true,
  useSelectedOrg: false,
  async run(argv, { auth, deps }) {
    return templateCommand(argv, vaultIo(auth, deps, true));
  },
} satisfies Command;
