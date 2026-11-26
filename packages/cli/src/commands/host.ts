import { hostCommand } from "../host-commands.ts";
import type { Command } from "./command.ts";

export default {
  name: "host",
  summary: "Manage registered Docker hosts",
  usage: {
    hosts: `  armada host install --server HTTPS_ORIGIN  Install daemon on Docker host (token on stdin)
  armada host add [--name NAME] [--org ORG] [--json]
                                           Register a Docker host and print its installer
  armada host ls [HOST] [--org ORG] [--json]
                                           List or inspect registered Docker hosts
  armada host limits HOST [--cpus N] [--memory SIZE] [--max-sandboxes N | --auto] [--org ORG] [--json]
                                           Update host resource limits or reset with --auto
  armada host rm UUID [--org ORG] [--json] Revoke a Docker host registration`,
  },
  help: `Usage: armada host <command> [arguments]
Manage Docker machines registered with Armada.
  install  Install or upgrade the local daemon on the Docker machine.
  add      Register a machine and obtain a one-use installer command.
  ls       Inspect registered hosts, or select one by UUID or exact name.
  limits   Update host resource limits by UUID or exact name.
  rm       Revoke a host registration by UUID.
Pass --org UUID for server commands. For install, supply the one-use token on stdin.
Use armada host <command> --help for options.
To launch on a registered host, use armada new --provider docker.
Example: armada host ls --org ORG_UUID --json
`,
  subcommandHelp: {
    "host ls": `Usage: armada host ls [<UUID|name>] [--org UUID] [--json]
List registered hosts, or inspect one host. Exact name lookup excludes revoked hosts.
A UUID can identify a revoked host. Use UUIDs when names are ambiguous.
`,
    "host limits": `Usage: armada host limits <UUID|name> [--org UUID] [--json]
  [--cpus <N>] [--memory <size>] [--max-sandboxes <N>] [--auto]
Supply at least one override or --auto. --auto resets all limits.
--cpus must be at least 0.01. --max-sandboxes must be a positive integer.
Container changes apply on the next start or resume. Inspect with armada host ls HOST.
`,
    "host rm": `Usage: armada host rm <UUID> [--org UUID] [--json]
Revoke a Docker host registration. Use a UUID from armada host ls.
`,
    "host add": `Usage: armada host add [--name <name>] [--org UUID] [--json]
Register a machine and run the returned installer on that machine.
Protect the short-lived installer token in the output. --json returns the receipt without waiting.
`,
  },
  automaticJson: true,
  helpWhenBare: true,
  useSelectedOrg: true,
  async run(argv, { io, auth }) {
    return hostCommand(argv, { ...auth, ...io });
  },
} satisfies Command;
