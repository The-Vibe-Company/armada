import { templateCommand } from "../template-commands.ts";
import type { Command } from "./command.ts";

export default {
  name: "template",
  summary: "Inspect and launch versioned templates",
  usage: {
    templates: "  armada template list|get|launch          Inspect and launch published template versions",
  },
  help: `Usage: armada template <command> [arguments]
Inspect reusable launch definitions and launch their immutable template versions.

  list     List visible IDs, names, scopes, status and current versions.
  get      Inspect metadata or a selected version's definition with --json.
  launch   Launch a template version using a saved --request-key for safe retries.

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada login --org NAME|UUID. Templates may be personal or organization-scoped.
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
or armada login --org NAME|UUID. Find template IDs and current versions with template list/get.
Names must match exactly and identify one active template; use an ID if names collide.

Options:
  --revision N                           Positive version number; omission uses current.
  --prompt TEXT                          Override the launch prompt.
  --ttl <duration>                       Override lifetime, for example 30m.
  --size small|medium|large|xlarge        Override machine size.
  --repo REPO                            Override the initial repository.
  --model-account UUID                   Select an unpinned model account.
  --model-account-version N              Required with --model-account; positive integer.
  --keep-after-merge                     Disable automatic stopping after merged work.
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
    "template list": `Usage: armada template list [--org NAME|UUID] [--json]
List visible launch-template metadata: IDs, names, scope, status and current version.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada login --org NAME|UUID.
Use a template ID from this list when names collide across scopes.
--json emits the API response with an items array; human output is a compact table.
Use armada template get ID --json to inspect a definition, not list.
Example: armada template list --org ORG_UUID --json
`,
    "template get": `Usage: armada template get NAME|ID [--revision N] [--org NAME|UUID] [--json]
Inspect a visible launch template; omitted --revision selects its current version.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada login --org NAME|UUID.
Names must match exactly and identify one active template; use an ID from template list
when names collide across scopes. --revision is a positive integer.
Human output shows metadata and the selected version, not the definition.
--json emits the API response including item and revision with its definition.
Definitions contain references to variables and secrets, not raw secret values.
This reads a template; it does not publish, launch or resolve a frozen launch manifest.
Example: armada template get TEMPLATE_UUID --revision 1 --org ORG_UUID --json
`,
  },
  automaticJson: true,
  helpWhenBare: true,
  requireKnownSubcommand: true,
  async run(argv, { auth }) {
    return templateCommand(argv, auth);
  },
} satisfies Command;
