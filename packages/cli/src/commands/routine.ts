import { routineCommand } from "../routine-commands.ts";
import { vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

function routineStateHelp(action: "enable" | "pause" | "delete") {
  const effect = {
    enable:
      "Enable scheduled launches as the routine owner. Selects the next occurrence, not an immediate manual launch.\nThe owner must still be eligible and the pinned template revision must be available.",
    pause:
      "Pause new launch admissions; already admitted runs may finish and running sandboxes are not stopped.\nUse routine enable with a fresh version to schedule future occurrences again.",
    delete:
      "Mark a routine deleted and stop new admissions; already admitted runs may finish.\nThis does not stop or delete running sandboxes. Keep the routine ID for routine runs history.",
  }[action];
  return `Usage: armada routine ${action} NAME|ID --expected-version N [--org NAME|UUID] [--json]
${effect}
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Organization-scoped changes require administrator permission.
Names must match exactly and identify one non-deleted routine; use an ID from routine list
if names collide. --expected-version is required, a positive integer up to 2147483647.
Copy the current version from routine show/list. Conflicts are not retried automatically;
inspect the current routine before deciding whether to apply the change again.
Human output shows metadata, status and the new version; --json emits the API response.
${action === "enable" ? "Use routine runs to inspect later admission and task outcomes; enabling is not task success." : "The API response includes admittedRunsMayFinish; a human warning is written to stderr."}
Example: armada routine ${action} ROUTINE_UUID --expected-version 2 --org ORG_UUID --json
`;
}

function routineDefinitionHelp(action: "create" | "update") {
  const creating = action === "create";
  return `Usage: armada routine ${action} ${creating ? "NAME" : "NAME|ID --expected-version N"} [configuration] [--org NAME|UUID] [--json]
${creating ? "Create a paused scheduled template launch; enable it separately to schedule its first occurrence." : "Update an existing routine, guarded by its current version. This is not a manual launch."}
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Organization-scoped writes require administrator permission.
${creating ? "--scope personal|org selects visibility; required with explicit --org. Otherwise scope defaults\nto personal in the selected organization. NAME supplies the name, not the JSON file." : "Names must match exactly and identify one non-deleted routine; use an ID from routine list\nif names collide. --expected-version is a required positive integer up to 2147483647.\nCopy it from routine show/list. A conflict is not retried; inspect before deciding to update.\nThe target keeps its owner and scope."}

Choose ONE configuration form (file and inline flags cannot be mixed):
${creating ? "  --file config.json\n  --template UUID --revision N (--prompt TEXT | --prompt-file PATH)\n    --cron EXPRESSION --timezone IANA_ZONE [--ttl 1h] [--max-runs-per-day N]\nJSON requires templateId, templateRevision, prompt, cron and timezone. Optional ttlSeconds\nand maxRunsPerDay default to 3600 and 24. --prompt-file reads UTF-8 without trimming;\nuse --prompt-file - for stdin. Template revision must be a positive integer." : "  --file config.json                     Replace ALL mutable configuration.\n  --cron EXPRESSION --timezone IANA_ZONE  Change only the schedule.\nUpdate JSON requires name, templateId, templateRevision, prompt, cron, timezone,\nttlSeconds and maxRunsPerDay. Missing fields are not retained. Inline updates retain\ncurrent mutable fields and send a complete replacement guarded by --expected-version."}
Neither JSON file accepts org, owner, scope or intervalHours.
Quote the standard five-field cron expression and use an IANA zone such as UTC or Europe/Paris.
Runs must stay at least ONE HOUR apart, including DST transitions. TTL is 5 minutes–24 hours;
maxRunsPerDay is 1–24 admitted launches. Prompts are readable configuration, never secrets.
${creating ? "Routines run as their owner, not whoever later inspects them." : "Updating an enabled routine selects its next matching occurrence; already admitted runs are not stopped."}
Human output shows metadata and version; --json emits the API response with item.
Example: armada routine ${action} ${creating ? "nightly --scope personal" : "ROUTINE_UUID --expected-version 2"} --file config.json --org ORG_UUID --json
`;
}

export default {
  name: "routine",
  summary: "Manage scheduled template launches",
  usage: {
    automation: `  armada routine --help                    Create, inspect, enable, pause and manage scheduled template launches`,
  },
  help: `Usage: armada routine <command> [arguments]
Manage scheduled template launches that run as the routine owner.

  create  Create a paused routine from file or inline configuration.
  list    List visible IDs, names, status, versions and next occurrences.
  show    Inspect configuration, prompt and current version.
  update  Replace configuration from file, or change only the inline schedule.
  enable  Schedule the next occurrence, not an immediate manual launch.
  pause   Stop new admissions; already admitted runs may finish.
  delete  Mark deleted; does not stop or delete running sandboxes.
  runs    Read the latest 100 decisions and original-prompt outcomes.

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada org use. Organization-scoped writes require administrator permission.
Use IDs from routine list when exact names collide; keep IDs for history after deletion.
Updates and state changes require --expected-version from routine show/list;
conflicts are not retried automatically. Prompts are readable configuration, not secrets.
Schedules use five-field cron and IANA time zones, with runs at least one hour apart.
Launch success is not task success; unknown is not success. Inspect routine runs.
Inspect a command's options with armada routine <command> --help.
Example: armada routine list --org ORG_UUID --json
Example: armada routine runs ROUTINE_UUID --org ORG_UUID --json
`,
  subcommandHelp: {
    "routine list": `Usage: armada routine list [--org NAME|UUID] [--json]
List visible scheduled template launches: IDs, names, scopes, status and versions.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Human output includes the schedule and next due time; paused routines have no next run.
--json emits the API response with an items array. Use IDs when exact names are ambiguous.
Use routine show for configuration and routine runs for admission/task outcomes.
Example: armada routine list --org ORG_UUID --json
`,
    "routine show": `Usage: armada routine show NAME|ID [--org NAME|UUID] [--json]
Inspect a scheduled template launch, including its version, schedule and prompt.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Names must match exactly and identify one non-deleted routine; use an ID from routine list
if names collide. Copy the current version before guarded updates or status changes.
Human output includes template version, TTL, daily cap, failures, pause reason and prompt.
Prompts are readable configuration, not a place for secrets; take care when sharing output.
--json emits the API response with item. This reads configuration, not run history.
Example: armada routine show ROUTINE_UUID --org ORG_UUID --json
`,
    "routine runs": `Usage: armada routine runs NAME|ID [--org NAME|UUID] [--json]
Read the latest 100 routine decisions and original-prompt outcomes.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Names must match exactly and identify one non-deleted routine. Use a routine ID from
routine list if names collide; use the ID to inspect history after deletion.
Human output includes scheduled time, admission state, task outcome, readable skip/failure
reasons and a sandbox ID when available. Launch success is not task success;
unknown or not observed is not success. --json emits the API response with an items array.
This does not trigger a scheduled run, wait for completion or stream sandbox logs.
Example: armada routine runs ROUTINE_UUID --org ORG_UUID --json
`,
    "routine enable": routineStateHelp("enable"),
    "routine pause": routineStateHelp("pause"),
    "routine delete": routineStateHelp("delete"),
    "routine create": routineDefinitionHelp("create"),
    "routine update": routineDefinitionHelp("update"),
  },
  helpWhenBare: true,
  useSelectedOrg: false,
  async run(argv, { auth, deps }) {
    return routineCommand(argv, vaultIo(auth, deps, true));
  },
} satisfies Command;
