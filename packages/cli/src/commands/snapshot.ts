import { snapshotCommand } from "../run.ts";
import type { Command } from "./command.ts";

export default {
  name: "snapshot",
  summary: "Manage provider-scoped snapshots",
  usage: {
    snapshots: `  armada snapshot create <name> (--repo <url>[@branch] ... | --config <file>) [--init <cmd> ...]
                               [--setup <local-file>] [--provider boat|modal] [--private] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
                                           Server-orchestrated: builds, scans and saves the snapshot on the
                                           server over your own GitHub connection. No BOAT_API_KEY needed.
                                           --setup reads a local script and sends its content to run after
                                           cloning, before the scan.
  armada snapshot update <name> (--add-repo <url>[@branch] ... | --replace --repo <url>[@branch] ... | --replace --config <file>) [--init <cmd> ...]
                               [--setup <local-file>] [--provider boat|modal] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
                                           Rebuild the existing snapshot in place. One snapshot may contain
                                           many repositories; visibility and ownership stay unchanged.
                                           Use --add-repo to append safely, preserving stored repositories and init commands.
                                           --repo/--config require --replace: they replace the ENTIRE config, even if no repos are dropped.
                                           Create/update admit a durable job, then poll for up to --timeout
                                           seconds (default 60, max 600; 0 returns after admission).
                                           Disconnecting never resubmits or cancels the job.
  armada snapshot build-cancel <job-id> [--org <org>] [--json]  Cancel your queued, never-started build
  armada snapshot build-find <name> [--provider boat|modal] [--org <org>] [--json]
                                           Find the latest visible active build without a job ID or admission key.
  armada snapshot build-status <job-id>      Read the authenticated durable build status
  armada snapshot build-status --idempotency-key <key> --org <org>
                                           Recover an uncertain admission using the saved key.
  armada snapshot capabilities [--provider boat|modal] [--org UUID] [--json]
                                           Server-authoritative snapshot capacity; null means unbounded/unknown
  armada snapshot size-policy <name> [--provider boat|modal] [--org <org>] [--file <JSON|->] [--json]
                                           Inspect defaults, or replace the entire policy from a file/stdin.
                                           Version 1: {"version":1,"golden":null,"repositories":{}}
                                           Repository keys are configured directories. A null default and an empty map
                                           clear defaults. Scoped to this provider snapshot, future launches only.
  armada snapshot create <name> --provider docker --host UUID|NAME --org UUID
                               (--config <file> | --repo <url>[@branch] ... [--init <cmd> ...]) [--private] [--request-id UUID] [--json]
                                           Build a host-local snapshot from the official Armada image and your repos/setup.
                                           No image input. Reuse --request-id with identical input after an unknown outcome.
  armada snapshot list [--provider boat|modal|docker] [--org UUID] [--json]
                                           Snapshots you can see; Docker requires --org.
  armada snapshot get UUID --provider docker --org UUID [--json]
                                           Read snapshot build state; launch ready snapshots with launch --provider docker --agent codex --golden UUID.
  armada snapshot rebuild UUID --provider docker --org UUID [--request-id UUID] [--json]
                                           Build a new snapshot from saved repos/setup on its original host; keep the old one.`,
    "snapshot-admin": `  armada snapshot retirement dry-run|reconcile <snapshot-id> [--limit 1-50] [--org UUID]
  armada snapshot remove <name|snapshot-id> [--provider boat|modal] [--org UUID] [--json]
                                           Names must match one visible snapshot; use provider/org or snapshot list --json to disambiguate.
                                           Remove from launch selection; retain children and provider artifacts
  armada snapshot visibility <snapshot-id> --visibility private|org [--org UUID]`,
  },
  help: `Usage: armada snapshot <command> [arguments]
Manage provider-scoped snapshots. Use a leaf command with --help or -h for syntax.
Boat/Modal:
  create       Build a snapshot from repositories/config.
  update       Append repositories or explicitly replace the complete config.
  build-find   Find an active build by name.
  build-status Inspect a job or recover admission using its saved key.
  build-cancel Cancel your queued, never-started build.
  capabilities Read server-authoritative capacity.
  size-policy  Inspect or replace future-launch size defaults.
  remove       Remove from launch selection, retaining children/provider artifacts.
  visibility   Change visibility using the snapshot record ID.
  retirement dry-run|reconcile  Review history and reconcile reviewed receipts.
Docker:
  create       Build a host-local snapshot (--provider docker, host/org required).
  get          Read saved build state.
  rebuild      Build a new snapshot on the original host, keeping the old one.
Shared:
  list         List visible snapshots; Docker requires an organization UUID.
Operations require Armada login and server authorization; help does not.
The legacy golden spelling is accepted; guidance uses snapshot.
Example: armada snapshot list --provider modal --json
Example: armada snapshot create --help
`,
  subcommandHelp: {
    "snapshot retirement": `Usage: armada snapshot retirement dry-run|reconcile <snapshot-UUID> [options]
Review historical candidates with dry-run; apply reviewed receipts with reconcile.
Use each subcommand with --help for exact flags.
Example: armada snapshot retirement dry-run SNAPSHOT_UUID --json
`,
    "snapshot retirement dry-run": `Usage: armada snapshot retirement dry-run <snapshot-UUID> [--limit <1-50>] [--org UUID] [--json]
Review bounded historical snapshot retirement candidates after Armada login.
Requires server owner/admin authorization. Limit defaults to 20; output is always JSON.
Use the snapshot record UUID, not a sandbox ID or provider artifact ID.
Review the results and receipts before using retirement reconcile. No provider mutation in this review.
Example: armada snapshot retirement dry-run SNAPSHOT_UUID --org ORG_UUID --limit 20
`,
    "snapshot retirement reconcile": `Usage: armada snapshot retirement reconcile <snapshot-UUID> [--file <path>] [--limit <1-50>] [--org UUID] [--json]
Reconcile reviewed history and enqueue eligible retirement work after Armada login and authorization.
Supply reviewed dry-run JSON via stdin or --file; do not invent receipts.
The JSON must contain 1–50 valid receipts in results. Limit defaults to 20.
Omit --file for stdin; --file - is not the stdin spelling for this command.
Server rechecks authority, history and references; eligible work is queued, not proof of deletion.
Output is always JSON. Use the snapshot record UUID, not a provider artifact ID.
Example: armada snapshot retirement reconcile SNAPSHOT_UUID --org ORG_UUID --file reviewed.json
`,
    "snapshot create": `Usage: armada snapshot create <name> (--repo <url>[@branch] ... | --config <file>)
  [--init <command> ...] [--setup <local-file>] [--provider boat|modal]
  [--private] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>] [--json]
Docker: armada snapshot create <name> --provider docker --host UUID|NAME --org UUID
  (--config <file> | --repo <url>[@branch] ... [--init <command> ...])
  [--private] [--request-id UUID] [--json]
--config cannot be combined with --repo or --init; include init commands in the JSON file.
Docker builds a host-local snapshot; --setup and durable-job flags above are Boat/Modal only.
Boat/Modal --timeout defaults to 60 seconds (0 returns after admission, maximum 600).
Save --idempotency-key to recover uncertain admission with snapshot build-status.
Requires Armada login, a connected provider and GitHub repository authorization.
Builds, scans and snapshots on the server; do not include secrets in setup.
Example: armada snapshot create starter --provider modal --repo https://github.com/octocat/Hello-World --org my-team
`,
    "snapshot update": `Usage: armada snapshot update <name> (--add-repo <url>[@branch] ... | --replace --repo <url>[@branch] ... | --replace --config <file>)
  [--init <command> ...] [--setup <local-file>] [--provider boat|modal]
  [--org <org>] [--idempotency-key <key>] [--timeout <seconds>] [--json]
--config cannot be combined with --repo or --init; include init commands in the JSON file.
Rebuild a snapshot in place after Armada login; ownership and visibility stay unchanged.
Use --add-repo to append while preserving stored repositories and init commands.
Do not combine --add-repo with --replace, --repo, --config, --init or --setup.
--replace replaces the ENTIRE config; include every repository and init command to keep.
--setup reads a local script. Never include secrets in setup or snapshot contents.
--timeout defaults to 60 seconds (0 returns after admission, maximum 600).
Disconnecting does not cancel or resubmit; inspect snapshot build-status before retrying.
Docker update is not supported; use snapshot rebuild for a new Docker snapshot.
Example: armada snapshot update starter --add-repo https://github.com/octocat/Hello-World --provider modal --org my-team
`,
    "snapshot build-find": `Usage: armada snapshot build-find <name> [--provider boat|modal] [--org <org>] [--json]
Find the latest visible active build when you have no job ID or admission key.
Requires Armada login. No match does not rule out a reservation needing administrator investigation.
Example: armada snapshot build-find starter --provider modal --json
`,
    "snapshot build-status": `Usage: armada snapshot build-status <job-id> [--org <org>] [--json]
   or: armada snapshot build-status --idempotency-key <key> --org <org> [--json]
Read durable build status, or recover uncertain admission using its saved key.
Requires Armada login. Output is JSON; failed or recovery-required builds exit 1.
Example: armada snapshot build-status --idempotency-key saved-build-key --org my-team
`,
    "snapshot build-cancel": `Usage: armada snapshot build-cancel <job-id> [--org <org>] [--json]
Cancel your queued, never-started build. Requires Armada login.
Started builds cannot be cancelled with this command. Inspect status before retrying an uncertain operation.
Example: armada snapshot build-cancel build-id --org my-team
`,
    "snapshot list": `Usage: armada snapshot list [--provider boat|modal|docker] [--org <org>] [--json]
List snapshots visible to you after Armada login; use --provider to filter.
Docker snapshots require --org UUID.
Use --json for structured output and reusable snapshot IDs.
Example: armada snapshot list --provider modal --org my-team --json
`,
    "snapshot capabilities": `Usage: armada snapshot capabilities [--provider boat|modal] [--org <org>] [--json]
Read server-authoritative snapshot capacity after Armada login.
A null maximum means unbounded or unknown, not zero available snapshots.
Docker is not supported by this command.
Example: armada snapshot capabilities --provider modal --org my-team --json
`,
    "snapshot remove": `Usage: armada snapshot remove <name-or-id> [--provider boat|modal] [--org <org>] [--json]
Remove a snapshot after Armada login and server authorization.
Names must identify one visible snapshot. Disambiguate with --provider and --org,
or use the exact ID from armada snapshot list --json.
Example: armada snapshot remove starter --provider modal --org my-team
`,
    "snapshot visibility": `Usage: armada snapshot visibility <id> --visibility private|org [--org <org>] [--json]
Change snapshot visibility after Armada login and server authorization.
Use the snapshot ID from armada snapshot list --json, not its display name.
Example: armada snapshot visibility SNAPSHOT_UUID --visibility private --org my-team
`,
    "snapshot get": `Usage: armada snapshot get <snapshot-UUID> --provider docker --org UUID [--json]
Inspect a Docker snapshot's saved build state after Armada login.
Get the snapshot ID from armada snapshot list --provider docker --org UUID --json.
Output is JSON even without --json. Boat/Modal do not support this command.
Example: armada snapshot get SNAPSHOT_UUID --provider docker --org ORG_UUID
`,
    "snapshot rebuild": `Usage: armada snapshot rebuild <snapshot-UUID> --provider docker --org UUID [--request-id UUID] [--json]
Build a new Docker snapshot from saved repositories/setup on its original host.
Requires Armada login and server authorization; the old snapshot stays unchanged.
A request ID is generated if omitted and printed to stderr before submission.
After an unknown outcome, inspect that ID; retry with the same --request-id.
Use a request UUID different from the original snapshot UUID.
Example: armada snapshot rebuild SNAPSHOT_UUID --provider docker --org ORG_UUID --request-id NEW_UUID
`,
    "snapshot size-policy": `Usage: armada snapshot size-policy <name> [--provider boat|modal] [--org <org>] [--file <JSON|->] [--json]
Inspect snapshot machine-size defaults, or replace them with a versioned JSON object.
Requires Armada login; changes affect future launches only, not existing machines.
Omit --file to inspect. Use --file - to read replacement JSON from stdin.
Replacement is complete, not a patch: include every default you want to keep.
Output is JSON, including the version and configured repository selectors.
Example: armada snapshot size-policy starter --provider modal --org my-team
Example: armada snapshot size-policy starter --provider modal --file policy.json
`,
  },
  helpWhenBare: true,
  async run(argv, { io, deps }) {
    return snapshotCommand(argv, io, deps);
  },
} satisfies Command;
