import { applicationVaultCommand } from "../application-vault-commands.ts";
import { vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

function vaultSetHelp(resource: "vars" | "secrets") {
  return `Usage: armada ${resource} set NAME [--file PATH] [--scope personal|org] [--org NAME|UUID] [--json]
Create a new ${resource === "vars" ? "readable application variable" : "write-only application secret"}, not a model/provider credential.
Set creates an entry, not an update; duplicate names conflict.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
--scope personal|org selects visibility. Explicit --org requires explicit --scope;
without --org, scope defaults to personal in the selected organization.
Only administrators can create organization-scoped entries.

Values come only from piped stdin or --file PATH, never command arguments.
Provide UTF-8 input; content is preserved without trimming and is not echoed or cached.
Do not embed sensitive values in shell commands or shared logs. Protect local input files.
${resource === "vars" ? "Variables are readable, not secrets: vars read can print their values and launch manifests\nmay contain them. Use secrets set for sensitive application values." : "Secret values are write-only: there is no read, reveal or export operation.\nUse secrets rotate with an ID and expected version to replace an existing active value."}
Human output shows metadata only; --json emits {item: metadata}, never the submitted value.
Use ${resource} list for IDs and versions. This command does not deliver values to a sandbox.
Example: armada ${resource} set ${resource === "vars" ? "APP_REGION" : "APP_PASSWORD"} --file /private/input.txt --scope personal --org ORG_UUID --json
`;
}

function secretLifecycleHelp(action: "rotate" | "revoke" | "delete") {
  const effect = {
    rotate:
      "Replace the stored value of an active application secret, not a model/provider credential.\nProvide replacement UTF-8 content only through piped stdin or --file PATH, never argv.\nInput is preserved without trimming, not echoed or cached. Protect local input files.",
    revoke:
      "Revoke an application secret and clear its stored value. Revocation is terminal;\na revoked secret cannot be rotated back to active. Delete it before reusing its name.",
    delete:
      "Mark an application secret deleted and clear its stored value, allowing name reuse.\nThis is not sandbox deletion or upstream credential revocation.",
  }[action];
  return `Usage: armada secrets ${action} ID --expected-version N ${action === "rotate" ? "[--file PATH] " : ""}[--org NAME|UUID] [--json]
${effect}
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Use an ID and current version from secrets list, not a secret name.
--expected-version is required and must be a positive safe integer. A stale version is
refused, not retried automatically; inspect metadata before deciding to try again.
Only administrators can mutate organization-scoped secrets; the ID determines scope.
Human output shows metadata only; --json emits {item: metadata}, never secret values.
Secrets have no read, reveal or export operation. No sandbox delivery or upstream
credential rotation is performed by this command.
Example: armada secrets ${action} SECRET_UUID --expected-version 2 ${action === "rotate" ? "--file /private/replacement.txt " : ""}--org ORG_UUID --json
`;
}

function vaultFamilyHelp(resource: "vars" | "secrets") {
  return `Usage: armada ${resource} <command> [arguments]
Manage ${resource === "vars" ? "readable application variables" : "write-only application secrets"}, not model/provider credentials.

${resource === "vars" ? "  set   Create a new variable from stdin or file, not an update.\n  list  Inspect visible metadata and IDs without values.\n  read  Print a value by ID, exactly without adding a newline; --json includes value." : "  set     Create a new secret from stdin or file, not an update.\n  list    Inspect visible metadata, IDs and versions, never values.\n  rotate  Replace an active secret value, guarded by --expected-version.\n  revoke  Terminally revoke and clear the stored value; no reactivation.\n  delete  Mark deleted and clear the value, allowing name reuse."}

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada org use. Explicit --org on set requires --scope personal|org;
otherwise set defaults to personal in the selected organization.
Lists include your personal entries and visible organization entries.
Only administrators can mutate organization-scoped entries; IDs determine scope.
Values come from piped stdin or --file, never arguments; protect local input files.
${resource === "vars" ? "Variables are readable, not secrets, and values may appear in launch manifests.\nUse secrets for sensitive application values." : "Secrets have no read, reveal or export operation. Guarded changes use IDs and current\nversions from secrets list. On version conflicts inspect before deciding to retry."}
Lists and writes emit metadata only, including with --json.
These management commands do not deliver values to sandboxes or rotate upstream credentials.
Inspect a command's options with armada ${resource} <command> --help.
Example: armada ${resource} list --org ORG_UUID --json
Example: armada ${resource} set ${resource === "vars" ? "APP_REGION" : "APP_PASSWORD"} --file /private/input.txt --scope personal --org ORG_UUID --json
`;
}

export const vars = {
  name: "vars",
  summary: "Manage readable application variables",
  usage: {
    vault: `  armada vars --help                       Readable variables: set/list/read; stdin/file writes only`,
  },
  help: vaultFamilyHelp("vars"),
  subcommandHelp: {
    "vars list": `Usage: armada vars list [--org NAME|UUID] [--json]
List readable application-variable metadata, not values or model credentials.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Includes your personal entries and visible organization entries. Use IDs from this list
with vars read; names are not accepted as read selectors.
Human output is compact metadata; --json emits {items:[...]} with safe scalar metadata only.
Readable variables are not secrets. Use secrets for sensitive application values.
Example: armada vars list --org ORG_UUID --json
`,
    "vars read": `Usage: armada vars read ID [--org NAME|UUID] [--json]
Read an application-variable value by ID from vars list, not by name.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Your personal entries and authorized organization entries are readable; variables are not secrets.
Default stdout is the value exactly, without adding a newline. --json emits
{item: metadata, value: string} followed by a newline. Take care when sharing or piping values.
This does not read an application secret, export model credentials or deliver values to a sandbox.
Example: armada vars read VARIABLE_UUID --org ORG_UUID --json
`,
    "vars set": vaultSetHelp("vars"),
  },
  helpWhenBare: true,
  useSelectedOrg: false,
  async run(argv, { auth, deps }) {
    return applicationVaultCommand("vars", argv, vaultIo(auth, deps, true));
  },
} satisfies Command;

export const secrets = {
  name: "secrets",
  summary: "Manage write-only application secrets",
  usage: {
    vault: `  armada secrets --help                    Write-only application secrets: set/list/rotate/revoke/delete`,
  },
  help: vaultFamilyHelp("secrets"),
  subcommandHelp: {
    "secrets list": `Usage: armada secrets list [--org NAME|UUID] [--json]
List application-secret metadata, never secret values or model credentials.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Includes your personal entries and visible organization entries. IDs and versions are used
by guarded rotate/revoke/delete operations; list itself makes no changes.
Human output is compact metadata; --json emits {items:[...]} with safe scalar metadata only.
Secrets have no read, reveal or export operation. Use vars read only for readable variables.
Example: armada secrets list --org ORG_UUID --json
`,
    "secrets set": vaultSetHelp("secrets"),
    "secrets rotate": secretLifecycleHelp("rotate"),
    "secrets revoke": secretLifecycleHelp("revoke"),
    "secrets delete": secretLifecycleHelp("delete"),
  },
  helpWhenBare: true,
  useSelectedOrg: false,
  async run(argv, { auth, deps }) {
    return applicationVaultCommand("secrets", argv, vaultIo(auth, deps, true));
  },
} satisfies Command;
