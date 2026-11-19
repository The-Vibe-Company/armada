import { hostCommand } from "../host-commands.ts";
import type { Command } from "./command.ts";

export default {
  name: "host",
  summary: "Manage registered Docker hosts",
  usage: {
    host: `  armada host install --server HTTPS_ORIGIN   Install on the Docker machine; one-use token on stdin, no login
  armada host status|uninstall [--server HTTPS_ORIGIN]  Local host wrappers; no login
  armada host add [--name NAME] [--org UUID]
  armada host list [--json] [--org UUID]
  armada host show HOST [--json] [--org UUID]
  armada host limits HOST [--cpus N] [--memory SIZE] [--max-sandboxes N | --auto] [--org UUID]
  armada host retention HOST --retention 24h [--org UUID]
  armada host revoke UUID [--org UUID]`,
  },
  help: `Usage: armada host <command> [arguments]
Manage Docker machines registered with Armada, not individual sandboxes.

Account commands (Armada login or ARMADA_TOKEN required):
  add      Register a machine and obtain a one-use installer command.
  list     Inspect host IDs, names, state and resources; supports --json.
  show     Inspect one host by UUID or exact name; supports --json.
  limits   Update host resource limits by UUID or exact name.
  revoke   Revoke a host registration by UUID.
Select an organization with armada org use or --org UUID.
Use UUIDs from host list when names are ambiguous.

Local machine commands (run on the Docker machine; no Armada login):
  install    Install/register the local host daemon using --server HTTPS_ORIGIN.
  status     Inspect the local host daemon.
  uninstall  Remove the local host installation.
For CLI install, supply the one-use registration token on stdin, never in argv.
Treat installer output as sensitive; do not paste it into shared logs.

Inspect a command's options with armada host <command> --help.
To launch on a registered host, use armada launch --provider docker.
Example: armada host list --org ORG_UUID --json
Example: armada host show workstation --org ORG_UUID
`,
  subcommandHelp: {
    "host list": `Usage: armada host list [--org UUID] [--json]
List registered Docker hosts after Armada login and server authorization.
Select an organization first or pass --org UUID. Use IDs/names with host show.
Example: armada host list --org ORG_UUID --json
`,
    "host show": `Usage: armada host show <UUID|name> [--org UUID] [--json]
Inspect one Docker host after Armada login and server authorization.
Select an organization first or pass --org UUID. Names must match exactly and be unambiguous.
A UUID can identify a revoked host; name lookup excludes revoked hosts.
Example: armada host show workstation --org ORG_UUID --json
`,
    "host retention": `Usage: armada host retention <UUID|name> --retention <duration> [--org UUID] [--json]
Only the member who added the Docker host can change retention.
Use 0 for next-sweep removal, or seconds/minutes/hours/days (24h, 30m, 7d), maximum 365d.
Applies at next check-in, including existing stopped sandbox deadlines.
--json returns {hostId, retentionSeconds}.
Example: armada host retention workstation --retention 24h
`,
    "host limits": `Usage: armada host limits <UUID|name> [--org UUID] [--json]
  [--cpus <N>] [--memory <size>] [--max-sandboxes <N>] [--auto]
Update Docker host policy after Armada login and server authorization.
Select an organization first or pass --org UUID. Supply at least one override or --auto.
Combine overrides as needed:
--cpus must be at least 0.01; --max-sandboxes must be a positive integer.
--auto resets all limits and cannot be combined with overrides.
Container changes apply on the next start or resume. Inspect with host show.
--json returns {hostId, ...requestedPolicy}.
Example: armada host limits workstation --org ORG_UUID --cpus 2 --memory 4GiB
`,
    "host revoke": `Usage: armada host revoke <UUID> [--org UUID] [--json]
Revoke a Docker host after Armada login and server authorization.
Select an organization first or pass --org UUID. Use a host UUID from host list, not a name.
--json returns {hostId, revoked:true}.
Example: armada host revoke HOST_UUID --org ORG_UUID
`,
    "host add": `Usage: armada host add [--name <name>] [--org <UUID>] [--json]
Register your Docker machine after Armada login. Select an organization first or pass --org.
Run the returned installer only on your intended host; its registration token is short-lived.
--json returns the registration receipt without waiting; protect its short-lived installer token.
Example: armada host add --name workstation
`,
  },
  helpWhenBare: true,
  async run(argv, { io, auth }) {
    return hostCommand(argv, { ...auth, ...io });
  },
} satisfies Command;
