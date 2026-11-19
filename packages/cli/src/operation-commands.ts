import type { Command } from "./commands/command.ts";
import { operation } from "./operations.ts";

function mcpAuthorizationHelp(action: "connect" | "reconnect") {
  return `Usage: armada mcp ${action} <connection-id> [--org UUID] [--no-browser] [--timeout <seconds>] [--json]
${action === "reconnect" ? "Revoke existing authorization first, then start a new connection authorization." : "Start authorization for an existing MCP registry connection."}
Requires Armada login and server authorization. Select an organization with armada org use or --org UUID.
Use a connection ID from mcp list, not a sandbox ID.
Opens a server-issued authorization URL when supplied; --no-browser prints it to stderr.
--timeout is an integer from 0 to 600 seconds (default 300).
Zero still starts authorization and checks status; a URL alone is not success.
On timeout, inspect mcp status before retrying. Successful output is always JSON.
Example: armada mcp ${action} CONNECTION_UUID --org ORG_UUID --no-browser --timeout 300
`;
}

const runOperation: (command: "mcp" | "bind-credential") => Command["run"] = (command) => {
  return (rest, { auth, deps }) =>
    operation(
      command,
      rest,
      auth,
      (path) =>
        path
          ? (deps.readFile ?? ((p) => Bun.file(p).text()))(path)
          : (
              deps.readStdin ??
              (() => (process.stdin.isTTY ? Promise.reject(new Error("stdin required")) : Bun.stdin.text()))
            )(),
      () => (deps.readStdin ? deps.readStdin() : process.stdin.isTTY ? Promise.resolve("") : Bun.stdin.text()),
    );
};

export const mcp = {
  name: "mcp",
  summary: "Manage MCP connections",
  usage: {
    "mcp-bindings": `  armada mcp sandbox-connections <sandbox-uuid> [--org UUID] [--json]
                                           Read actual bound connection metadata, never mutate bindings`,
    mcp: `  armada mcp catalog|rename ID NAME|default ID on|off [--org UUID]
  armada mcp add NAME --service notion|linear [--scope personal|org] [--org UUID]
  armada mcp add NAME URL [--scope personal|org] [--org UUID]
                                           Public/OAuth URL shortcut; auto discovery, no secret argv
  armada mcp list|add|update|connect|status|reconnect|enable|disable|revoke|delete [id] [--org UUID] [--file JSON]`,
  },
  help: `Usage: armada mcp <command> [arguments]
Manage MCP registry connections and inspect sandbox bindings.
Use leaf --help/-h for exact flags. Operations require Armada login, server
authorization and organization selection with org use or --org UUID.
Registry:
  catalog  Read service metadata.
  list     List visible connections and IDs.
  add      Create by service, public URL or JSON definition.
  update   Update from a JSON definition; scope cannot change.
  rename   Rename a connection by ID.
  default  Set launch-default selection with positional on|off.
  enable   Enable the registry entry; check status for authorization state.
  disable  Disable without deleting the registry entry.
  delete   Delete the registry entry.
Authorization:
  status     Read a connection's status.
  connect    Authorize an existing connection.
  reconnect  Revoke first, then start authorization again.
  revoke     Revoke authorization, not registry deletion.
Sandbox:
  sandbox-connections  Read actual bound metadata using a sandbox UUID.
Registry IDs and sandbox UUIDs are different selectors. Help does not call MCP.
Keep authentication values in private files/stdin, never command arguments.
Example: armada mcp list --org ORG_UUID --json
Example: armada mcp add --help
`,
  subcommandHelp: {
    "mcp list": `Usage: armada mcp list [--org UUID] [--json]
List visible MCP registry connections after Armada login and server authorization.
Select an organization with armada org use or --org UUID.
Output is JSON even without --json. This is not a sandbox's bound-connection list.
Example: armada mcp list --org ORG_UUID --json
`,
    "mcp catalog": `Usage: armada mcp catalog [--org UUID] [--json]
Read the MCP service catalog after Armada login and server authorization.
Select an organization with armada org use or --org UUID.
Output is JSON even without --json; this command does not add a connection.
Example: armada mcp catalog --org ORG_UUID --json
`,
    "mcp status": `Usage: armada mcp status <connection-id> [--org UUID] [--json]
Read an MCP connection's status after Armada login and server authorization.
Use a connection ID from mcp list, not a sandbox ID.
Select an organization with armada org use or --org UUID. Output is always JSON.
Example: armada mcp status CONNECTION_UUID --org ORG_UUID --json
`,
    "mcp sandbox-connections": `Usage: armada mcp sandbox-connections <sandbox-UUID> [--org UUID] [--json]
Read actual bound MCP connection metadata for a sandbox after Armada login.
Requires server authorization and an organization selected with org use or --org UUID.
Use a sandbox UUID, not a registry connection ID. Output is always JSON.
This command does not mutate bindings.
Example: armada mcp sandbox-connections SANDBOX_UUID --org ORG_UUID --json
`,
    "mcp revoke": `Usage: armada mcp revoke <connection-id> [--org UUID] [--json]
Revoke an MCP connection's authorization after Armada login and server authorization.
Select an organization with org use or --org UUID; use an ID from mcp list.
Output is JSON even without --json. This is not mcp delete.
Example: armada mcp revoke CONNECTION_UUID --org ORG_UUID
`,
    "mcp rename": `Usage: armada mcp rename <connection-id> <name> [--org UUID] [--json]
Rename an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json.
Example: armada mcp rename CONNECTION_UUID work-tools --org ORG_UUID
`,
    "mcp default": `Usage: armada mcp default <connection-id> on|off [--org UUID] [--json]
Set whether an MCP connection is a launch default after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
The on/off choice is positional. This is not connection authorization.
Output is JSON even without --json.
Example: armada mcp default CONNECTION_UUID on --org ORG_UUID
`,
    "mcp enable": `Usage: armada mcp enable <connection-id> [--org UUID] [--json]
Enable an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json. Check mcp status for authorization state.
Example: armada mcp enable CONNECTION_UUID --org ORG_UUID
`,
    "mcp disable": `Usage: armada mcp disable <connection-id> [--org UUID] [--json]
Disable an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json. This is not registry deletion.
Example: armada mcp disable CONNECTION_UUID --org ORG_UUID
`,
    "mcp delete": `Usage: armada mcp delete <connection-id> [--org UUID] [--json]
Delete an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json. For authorization revocation, see mcp revoke.
Example: armada mcp delete CONNECTION_UUID --org ORG_UUID
`,
    "mcp add": `Usage: armada mcp add <name> <URL> [--scope personal|org] [--org UUID] [--json]
   or: armada mcp add <name> --service <service-id> [--scope personal|org] [--org UUID] [--json]
   or: armada mcp add [--file <path>] [--org UUID] [--json]
Create a registry connection after Armada login and server authorization.
Select an organization with org use or --org UUID.
URL shortcuts require a public/OAuth HTTP URL without credentials; keep stdin empty.
Do not combine NAME URL with --file or stdin JSON. Shortcut scope defaults to personal.
Use mcp catalog for service IDs. Full definitions are JSON objects from stdin or --file;
put scope in the definition, not --scope. Secrets belong in private files/stdin, never arguments.
Output is always JSON. This does not run mcp connect.
Example: armada mcp add work-tools --service notion --org ORG_UUID
Example: armada mcp add --file /private/connection.json --org ORG_UUID
`,
    "mcp update": `Usage: armada mcp update <connection-id> [--file <path>] [--org UUID] [--json]
Update a registry connection from a JSON object after Armada login and server authorization.
Select an organization with org use or --org UUID; use an ID from mcp list.
Read the object from stdin or --file. Keep authentication values out of command arguments.
Updates cannot change scope; --scope is not accepted. Output is always JSON.
Example: armada mcp update CONNECTION_UUID --file /private/connection.json --org ORG_UUID
`,
    "mcp connect": mcpAuthorizationHelp("connect"),
    "mcp reconnect": mcpAuthorizationHelp("reconnect"),
  },
  helpWhenBare: true,
  run: runOperation("mcp"),
} satisfies Command;

export const bindCredential = {
  name: "bind-credential",
  summary: "Recover a sandbox credential binding",
  usage: {
    "bind-credential": `  armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
                                           Owner-only legacy Modal binding recovery; stop safely first; no restart`,
  },
  help: `Usage: armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
Owner-only legacy Modal credential-binding recovery after Armada login.
Stop the sandbox safely before rebinding; this command does not restart it.
Use a sandbox ID from armada list and a credential-account UUID from creds list.
Do not pass secret credential values. Output is JSON even without --json.
Example: armada bind-credential SANDBOX_UUID --credential-id ACCOUNT_UUID --org ORG_UUID
`,
  run: runOperation("bind-credential"),
} satisfies Command;
