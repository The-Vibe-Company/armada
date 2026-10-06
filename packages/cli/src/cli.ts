// Command dispatch with every side effect injected, so commands can be tested
// without a network, a real clock or the user's environment.
import { basename, dirname, join, resolve } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  CONFIG_FILE,
  ConfigError,
  LINEAR_KEY,
  LinearError,
  loadStatus,
  machinePaths,
  parseConfig,
  Refusal,
  readWatchProjects,
  skillsBehind,
  skillsBehindLine,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { apiOf } from "./api.ts";
import { attachCommand } from "./attach.ts";
import { authLogin, authLogout, authStatus, loadCredentials } from "./auth.ts";
import { brief } from "./brief.ts";
import { ciWhy } from "./ci.ts";
import { digest } from "./digest.ts";
import { doctor } from "./doctor.ts";
import { heartbeat } from "./heartbeat.ts";
import { hold } from "./hold.ts";
import { answer, ask, inbox } from "./inbox.ts";
import { init } from "./init.ts";
import { httpOptions, type Io, missingKey, UsageError } from "./io.ts";
import { launch } from "./launch.ts";
import { setupLocal } from "./local-setup.ts";
import { login, logout, whoami } from "./login.ts";
import { merge } from "./merge.ts";
import { recordPresence } from "./presence.ts";
import { statusAll } from "./projects.ts";
import { NOTICE_COMMANDS, noticeRelease } from "./release.ts";
import { renderStatus } from "./render.ts";
import { CommandError, fsRepoView, gitRoot, requireExec } from "./repo.ts";
import { reserveCommand, unreserveCommand } from "./reserve.ts";
import { stop } from "./runtime.ts";
import { runCommand, secretsCommand } from "./secrets.ts";
import { printSkill, updateSkills } from "./skills.ts";
import { requireSpecCoordinator, specCommand } from "./spec.ts";
import { upgrade } from "./upgrade.ts";
import { askOwner, done, namedTicket, validate } from "./validate.ts";
import { hookStop, stopWatch, watch } from "./watch.ts";
import { claim, currentTicket, release, report, statusLive } from "./worker.ts";

export { authLogin } from "./auth.ts";
export type { Io } from "./io.ts";

/** Each command's help block, in the order of the full usage; `armada <command> --help` prints its own. */
const COMMAND_HELP: Record<string, string> = {
  reserve: `  reserve <key> [--value <v> | --next [--floor <n>]] [--note <text>] [--ticket <id>]
  reserve --list    Show shared resources held or permanently used after merge.
                    Requires Armada; ask the coordinator if it is unavailable.
`,
  unreserve: `  unreserve <key> [--ticket <id>]
                    Free this ticket's open reservations of a key.
`,
  ci: `  ci why <pr|url> [--json]
  ci why --sha <sha> | --branch <branch> [--json]
                    Explain failing checks on this head: test names, first errors, links
                    and runner problems. Needs a GitHub token only (Actions read for logs).
`,
  attach: `  attach <ticket> <file|url>... [--caption <text>] [--for <item>]
                    Privately attach PNG, JPEG, WebP or GIF images (up to 2 MB each),
                    or HTTPS links. Prints a dashboard URL for each attachment.
                    --for keeps a free reference for an owner validation item
`,
  heartbeat: `  heartbeat --every 5m --parent <agent-pid> [--background] [--ticket <id>] [--handle <id>]
                    Keep the current worker session alive through Armada only, with no
                    Linear comment. Stops with the parent or the released/revoked session.
                    --background detaches from the command shell and keeps a PID file
`,
  spec: `  spec add "<name>" [--at <position>] [--apply]
  spec renumber [--apply]
                    Coordinator: create a spec under the program root with the In short
                    template. Plain append creates immediately if no titles must change.
                    --at and renumber preview changes; --apply writes them sequentially.
                    [tracker] spec_titles = "N/M" opts into updating every total.
`,
  digest: `  digest [--since <ISO|4h>] [--lang en|fr] [--send] [--json]
                    Print the current project's owner summary since its last digest.
                    --send posts it through Organization > Notifications; no address is released.
`,
  status: `  status            Tickets in flight, tickets ready to start and pull requests waiting
  status --all      The same for every project registered by \`armada init\`
`,
  setup: `  setup local       Open local harness panes for the owner to answer first-run questions,
                    choose ask/full permissions once, and check the selected models.
                    Requires an interactive terminal; --json reports that requirement
`,
  doctor: `  doctor            What this repository lacks to be run by Armada, with the fix for each,
                    and whether this terminal is signed in to Armada. Local herdr profiles
                    check tools and harness sign-in; offers official installs with y/N.
                    No terminal, CI and --json only print fixes and never install.
                    For harness first-run questions, the owner runs armada setup local
`,
  upgrade: `  upgrade           Install the newest Armada npm serves, verify armada --version,
                    then check setup with the upgraded doctor. Waits up to five publication
                    checks over about two minutes. Runs armada init --merge only for
                    outdated setup. Requires armada.toml at the selected Git root;
                    workers keep their launch's pinned version
`,
  init: `  init [--program-root <ISSUE-ID>] [--name <name>] [--slug <slug>] [--no-stop-hook] [--merge]
                    Open one pull request that installs or updates it all, create the
                    missing Linear labels and register the project. The options are for
                    a repository without armada.toml (Linear issue at the program root).
                    It asks before adding the Claude Code stop hook to the repository's
                    .claude/settings.json (yes without a terminal); --no-stop-hook skips it
                    Reuses armada/setup across versions and closes legacy armada/init-* PRs.
                    --merge waits for the normal merge checks and merges only setup paths
`,
  skill: `  skill <name> [<file>]
                    Print instructions from this Armada version (default SKILL.md).
                    No checkout, sign-in or network needed; linked files use their relative path
`,
  skills: `  skills update     Update all bundled skills, links and skills-lock.json in the current
                    checkout, and ignore shipping artifacts. No sign-in required; review
                    and commit the changes on your branch. Project settings stay as they are
`,
  claim: `  claim <ticket> --runtime <name> --handle <id> [--branch <name>]
        [--profile <name> [--reason <why>]] [--validation <n,...> --validation-reason <why>]
                    Claim a ticket for this worker: In Progress, phase planning, runtime
                    label and an Agent claim comment; refused if another worker holds it.
                    --profile records the Conductor profile; one other than the ticket's
                    routed profile needs --reason. --validation records the owner-validation
                    rules the coordinator judged apply. Prints the ticket's state afterwards
`,
  report: `  report <phase> [--message <text> | --message-file <path|->] [--pr <n|url>] [--sha <sha>]
        [--plan <text> | --plan-file <path|->] [--paths <comma list>] [--shipped-with "ship-pr-dev"|"fallback: <reason>"] [--stage review|ci]
                    Report a phase (planning, awaiting-approval, implementing, shipping,
                    blocked, ready-to-merge, awaiting-validation); the same phase again is a
                    status update; armada validate is how a worker enters awaiting-validation.
                    --plan posts the plan as its own block under a one-line status (the
                    message's first line, else the plan's); awaiting-approval sends it to
                    the coordinator's inbox.
                    ready-to-merge needs --sha (full 40 characters, the PR head) and green CI.
                    --stage is shipping only: review at independent review, ci after it passes.
                    --shipped-with names the shipping path in its hand-back and inbox.
                    Prints the ticket's state and what waits in this worker's inbox.
`,
  release: `  release --reason <text>
                    Give the ticket back: agent labels removed, ticket moved back
`,
  ask: `  ask "<question>" [--options "<a> | <b>"] [--ticket <id>]
                    Worker: ask the coordinator. The phase becomes blocked, the question
                    goes on the ticket and in the coordinator's inbox. Then stop and wait
                    for the answer in your session, and report the phase you resume
`,
  validate: `  validate [<ticket>] "<what to check>" [--attach <file|url>]... [--caption <text>]
        [--choices "<a> | <b>"]
                    Ask the owner to validate on Armada's Validations page, with the
                    attachments (images up to 2 MB, HTTPS links). Prints the approval link.
                    Worker: its own ticket; the phase becomes awaiting-validation: stop until
                    the coordinator relays the owner's decision. Coordinator: any ticket.
                    The owner's buttons are Approve and Request changes, or the --choices
`,
  "ask-owner": `  ask-owner <ticket> "<question>" --choices "<a> | <b>"
                    Coordinator: escalate a question or a plan to the owner, with its
                    choices. Prints the approval link; the owner's pick arrives in the inbox
`,
  done: `  done <ticket>     Coordinator: close a ticket whose newest validation the owner approved,
                    with no pull request (a design ticket): the design and the owner's note
                    are posted on it, it moves to Done, agent labels removed, session ended
`,
  hold: `  hold [--json]
  hold add "<reason>"
  hold clear <id> --reason "<why>"
                    Pause this project's merges until cleared, shared with every coordinator.
                    Merge a fix with --through-hold "<why>"; the hold stays open.`,
  inbox: `  inbox [--wait [--timeout <seconds>]]
                    Coordinator: open questions, plans, requests, hand-backs and silent workers,
                    oldest first; records that the coordinator is at work. --wait returns
                    when a new item arrives or after --timeout (default 300 s); \`armada watch\`
                    is the way to keep listening. Needs a sign-in to Armada
`,
  watch: `  watch             Coordinator: run in the background while workers are in flight. Waits
                    until something needs you (a question, plan, request, hand-back or silent
                    worker you have not seen), prints it and exits; exits "nothing to watch"
                    when no worker is in flight and nothing is open. An Armada
                    outage does not end it: it keeps asking. One per project on
                    this machine. Needs a sign-in to Armada
  watch --follow    Stream lines without exiting on new items; --json prints NDJSON.
                    --since <cursor> resumes events; defaults to this machine's cursor.
                    --tickets A-1,B-2 and --kinds question,hand-back filter the stream.
                    --kinds all also prints claims, reports, releases and merges.
                    --all follows the whole project (the default).
                    --mine needs "Show each coordinator only its own work" (not yet available).
                    --for <minutes> ends either watch cleanly with a resume command.
  watch --stop      Stop only this project's verified watch and release its lock. Local,
                    no sign-in needed. Never stop a watch just to read inbox or status
`,
  stop: `  stop <ticket> [--merged-pr <url>] [--claim-key <key>]
                    Archive a Conductor workspace after release or merge. Herdr worktrees must be clean and fully pushed.
                    Merge recovery prints --merged-pr and --claim-key to protect replacement workers;
                    copy the complete command. Ordinary stop retains its existing behavior.
`,
  answer: `  answer <item|ticket> "<answer>"
                    Coordinator: deliver to a herdr or Conductor worker and record the answer.
                    For Claude Code, deliver with the runtime guide first. Resolves the question or
                    plan and posts it on the ticket. A ticket id also answers a live herdr block.
                    A hand-back id can clear a merged/closed PR or a Done/Canceled ticket
  answer --note <ticket|plan item> "<message>"
                    Coordinator: deliver and record a note; a targeted open plan is resolved
`,
  merge: `  merge --when-green <pr...> [--no-ticket] [--keep-open] [--through-hold <why>] [--reason <why>]
                    Queue handed-back pull requests durably in order. Checks/behind-base,
                    owner decisions and merge holds may wait; rule failures refuse now.
                    --reason is required with [policy] merge_approval. --keep-open records
                    intent for the drain to keep the ticket open; --through-hold records
                    why a fix may pass the shared merge hold. Queuing does not drain.
                    Next: armada merge --drain (in the background).
  merge queue [--json]
                    List open entries in order and entries finished in the last day.
  merge queue remove <pr>
                    Remove a queued entry; an entry currently merging cannot be removed.
                    To pause merges, use armada hold add "<why>".
  merge <pr> [--ticket <id> | --no-ticket] [--dry-run] [--no-lock] [--wait [--timeout <min>]]
        [--reason <why>] [--through-hold <why>] [--ask-owner --reason <why>] [--no-archive]
                    Coordinator: check a handed-back pull request (hand-back SHA = head,
                    CLEAN, required checks green, no open review thread, base contained
                    or test-merged), squash-merge it pinned to that SHA under the merge
                    lock, close the ticket and list the workers to tell. Never deletes
                    the branch. After GitHub confirms the merge, archives the worker's
                    Armada workspace; --no-archive leaves it open. Cleanup failures print
                    an armada stop command and do not fail the merge.
                    --dry-run only runs the checklist. Signed in to Armada,
                    refused while Armada is down; --no-lock skips the lock and hold check.
                    Open holds refuse merges; --through-hold "<why>" lets a fix through
                    and records each hold id and the reason on the merged ticket.
                    --wait (--timeout in minutes, default 30): a head behind its base is
                    updated on GitHub (a merge commit, no force-push) and its checks waited
                    for, without the lock; a red check or a conflict stops it. A head that
                    is the hand-back with only the base merged in counts as the hand-back.
                    --no-ticket: a pull request no ticket owns (armada init, a release);
                    on a ticket-named branch, --reason is required and posted on the PR;
                    the ticket and its worker stay unchanged, with nothing written to Linear.
                    With [policy] merge_approval, judge each pull request: --reason "<why>"
                    merges on its own; --ask-owner --reason "<why>" merges nothing, asks the
                    owner (PR, files, CI, preview, screenshots) and prints the approval link.
                    A pull request the owner was asked about merges only once they approved
                    that exact head (or it with only the base merged in).
`,
  launch: `  launch <ticket> [--runtime conductor|herdr] [--profile <name> [--reason <why>]]
        [--notes <file|->] [--validation <n|none>] [--dry-run] [--json]
                    Check the ticket, choose its profile and launch one worker with its
                    one-time sign-in brief. Runtime defaults to the chosen profile;
                    Claude Code profiles point to armada brief and the Agent tool.
                    --pre-approve --reason "<why>" adds the plan-approved label before launch
                    --notes adds coordinator context from a file or stdin (at most 16 KB).
                    Pending launches and active workers are refused before a token exists.
                    Conductor uses explicit profile settings and receives the brief through stdin;
                    stdout prints its workspace, session and link, never the token.
                    Herdr creates a persistent local worktree; --harness must match its profile.
                    --dry-run prints settings and preflight and creates nothing.
  launch <ticket> --when-unblocked [--profile <name>] [--after <blocker>]
                    Remember a launch until all Linear blockers close. --after asserts an
                    existing blocker; it never adds a dependency. Status shows the request.
  launch revoke <ticket>
                    Cancel the newest pending launch through Armada, including a worker
                    signed in but not claimed. A claimed launch needs armada release instead
`,
  brief: `  brief <ticket> [--pre-approve --reason <why>] [--profile <name> [--reason <why>]] [--prompt [--profile-line]]
        [--validation none | --validation <n,...> --validation-reason <why>]
                    --pre-approve requires --reason and adds the configured plan-approved label
                    only with --prompt; previews say what would change. needs-approval labels refuse it
                    A new worker's launch prompt, the Conductor profile (agent, model,
                    effort) and the environment variables to pass, named, never shown.
                    The profile follows [[conductor.routing]] on the ticket's labels, then
                    profiles' when rules ask the coordinator to choose with --profile and
                    --reason. Only projects without when fall back to default_profile.
                    Signed in to Armada, the prompt starts with a one-time launch token, so
                    the worker needs no key. --prompt prints only the prompt, for \`--message-file -\`
                    Human and --json views mint nothing. --prompt --profile-line also
                    prints the profile and its reason on stderr, leaving stdout unchanged.
                    With [[policy.validation]] rules, judge which apply: --validation none,
                    or their numbers and why; the prompt then tells the worker what to show
`,
  secrets: `  secrets           The project's secrets for workers: names, project or organization,
                    who set each and when; never a value. Needs a sign-in to Armada
  secrets set <NAME> [--org] [--value-stdin | --from-env <VAR>]
                    Coordinator (owner or admin): set one for this project, or with --org
                    for every project. The value comes from a hidden prompt, standard input
                    or a variable of this environment, never from the command line
  secrets unset <NAME> [--org]
                    Coordinator: unset one; workers no longer get it from their next command
  secrets export --file <path> [--only <A,B>]
                    Write them to a dotenv file (mode 0600) for a tool that reads one;
                    refused for a path git tracks or does not ignore
  secrets get <NAME>
                    Print one value, for a person: it is then visible in any transcript.
                    An agent uses \`armada run\` or \`secrets export\` instead
`,
  run: `  run [--only <A,B>] -- <command> [args...]
                    Run a command with the project's secrets in its environment (they win
                    over variables of the same name, named on stderr): tests, builds, dev
                    servers. Nothing is written to disk or printed. Exits with its code
`,
  hook: `  hook stop         Claude Code's Stop hook, installed by \`armada init\`: a coordinator
                    cannot end its turn while workers are in flight and no \`armada watch\`
                    runs for the project in this checkout. Reads only local files;
                    ARMADA_STOP_HOOK=off turns it off
`,
  login: `  login             Sign this terminal in to Armada: confirm the code it shows in the browser
  login --api-key   Sign a headless coordinator in with an organization API key, read from a
                    hidden prompt or standard input (ARMADA_API_KEY in the environment also works)
  login --launch-token <token> [--api-url <url>]
                    Worker: exchange the one-time token of the launch message for a worker
                    session, which claims, reports, asks and releases that ticket only
`,
  whoami: `  whoami            The person or API key this terminal is signed in as, and its organization
`,
  logout: `  logout            Sign this terminal out of Armada: revoke its session, remove it from the machine
`,
  auth: `  auth login        Ask for the missing keys (hidden input) and store them on this machine
  auth status       Show which keys are set and where each comes from, never their values
  auth logout       Remove Armada's keys from this machine
`,
};

/** Commands that take --ticket, --config and --json. */
const TICKET_OPTION = new Set([
  "report",
  "release",
  "ask",
  "validate",
  "merge",
  "secrets",
  "run",
  "reserve",
  "unreserve",
]);
const CONFIG_OPTION = new Set([
  "reserve",
  "unreserve",
  "ci",
  "digest",
  "attach",
  "status",
  "spec",
  "secrets",
  "run",
  "claim",
  "report",
  "release",
  "ask",
  "validate",
  "ask-owner",
  "done",
  "hold",
  "inbox",
  "watch",
  "answer",
  "stop",
  "merge",
  "brief",
  "launch",
  "setup",
  "upgrade",
]);
const JSON_OPTION = new Set([
  "skills",
  ...[...CONFIG_OPTION].filter((c) => c !== "run" && c !== "attach" && c !== "upgrade"),
  "doctor",
  "auth",
  "whoami",
]);
const TICKET_HELP = `  --ticket <id>     Ticket for report, release and ask (default ARMADA_TICKET, then the git
                    branch) and for merge (default: the ticket the PR branch names)
`;

export const USAGE = `Usage: armada <command> [options]

Commands:
${Object.values(COMMAND_HELP).join("")}
Options:
  --json            Print the result as JSON
  --config <path>   Use this armada.toml (overrides ARMADA_CONFIG and --project)
  --project <slug>  Use the checkout this machine last watched for the project
                    Config order: --config, ARMADA_CONFIG, --project, nearest armada.toml
${TICKET_HELP}  -h, --help        Show this help; \`armada <command> --help\` shows one command
  -v, --version     Print the version

Keys (the environment first, then Armada when signed in, then the file):
  LINEAR_API_KEY       Linear API key (required by status, init, brief, claim, report,
                       release, ask and answer)
  GITHUB_TOKEN         GitHub token; falls back to GH_TOKEN, then \`gh auth token\`
                       (merge also runs gh and git, with gh's own login)
  ARMADA_API_KEY       Organization API key: signs a headless coordinator in to Armada
  ARMADA_API_URL       The Armada to sign in to (default https://armada.thevibecompany.co)

The fleet's live data (claims, reports, the inbox, the merge lock, the project
registry) is reached through Armada with the sign-in: no database key is needed.
init, inbox, watch and status --all need a sign-in; elsewhere, signed out, live
activity is not recorded and Linear stays the record.

Files:
  $XDG_CONFIG_HOME/armada (default ~/.config/armada)
    credentials        KEY=value lines, mode 0600, written by \`armada auth login\` and
                       \`armada login\` (the sign-in: ARMADA_SESSION_TOKEN or ARMADA_API_KEY)
    config.toml        personal defaults: language, [dashboard] url, [api] url
    watch/<project>.*  the project's watch: its lock, what you were shown, who is in flight
    releases.json      daily release notices in status/inbox, with version and time.
                       Only required CLI/setup upgrades interrupt armada watch
`;

/** The help of one command, or null for a command Armada does not know. */
export function commandHelp(command: string): string | null {
  const block = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!block) return null;
  const options = [
    JSON_OPTION.has(command)
      ? `  --json            Print the result as JSON${command === "auth" ? " (auth status)" : ""}\n`
      : "",
    CONFIG_OPTION.has(command)
      ? "  --config <path>   Use this armada.toml (overrides ARMADA_CONFIG and --project)\n  --project <slug>  Use the checkout this machine last watched for the project\n                    Config order: --config, ARMADA_CONFIG, --project, nearest armada.toml\n"
      : "",
    TICKET_OPTION.has(command) ? TICKET_HELP : "",
    "  -h, --help        Show this help (`armada --help` lists every command)\n",
  ];
  return `Usage: armada ${command} [options]\n\n${block}\nOptions:\n${options.join("")}`;
}

interface Args {
  command: string | null;
  /** Positional arguments after the command. */
  rest: string[];
  json: boolean;
  all: boolean;
  config: string | null;
  project: string | null;
  help: boolean;
  version: boolean;
  /** Options that take a value, other than --config and --project. */
  options: Record<string, string>;
  /** Everything after `--`, untouched: the command `armada run` runs. Null without `--`. */
  passthrough: string[] | null;
}

const VALUE_OPTIONS = [
  "value",
  "floor",
  "since",
  "tickets",
  "kinds",
  "merged-pr",
  "claim-key",
  "at",
  "every",
  "parent",
  "runtime",
  "harness",
  "handle",
  "branch",
  "ticket",
  "message",
  "message-file",
  "plan",
  "plan-file",
  "paths",
  "pr",
  "sha",
  "shipped-with",
  "stage",
  "through-hold",
  "reason",
  "program-root",
  "name",
  "slug",
  "profile",
  "options",
  "timeout",
  "launch-token",
  "api-url",
  "only",
  "file",
  "from-env",
  "caption",
  "for",
  "attach",
  "choices",
  "validation",
  "validation-reason",
  "through-hold",
  "notes",
  "after",
  "since",
  "lang",
];
/** Options without a value, stored as "true". */
const FLAG_OPTIONS = [
  "when-unblocked",
  "send",
  "next",
  "list",
  "pre-approve",
  "follow",
  "mine",
  "apply",
  "stop",
  "background",
  "dry-run",
  "no-lock",
  "no-ticket",
  "when-green",
  "keep-open",
  "no-archive",
  "prompt",
  "profile-line",
  "wait",
  "note",
  "api-key",
  "no-stop-hook",
  "merge",
  "org",
  "value-stdin",
  "ask-owner",
];
/** Value options each command accepts. */
const COMMAND_OPTIONS: Record<string, string[]> = {
  reserve: ["ticket", "value", "next", "floor", "note", "list"],
  unreserve: ["ticket"],
  ci: ["sha", "branch"],
  digest: ["since", "lang", "send"],
  spec: ["at", "apply"],
  attach: ["caption", "for"],
  heartbeat: ["every", "parent", "background", "ticket", "handle"],
  claim: ["runtime", "handle", "branch", "profile", "reason", "validation", "validation-reason"],
  report: ["ticket", "message", "message-file", "plan", "plan-file", "pr", "sha", "shipped-with", "stage", "paths"],
  release: ["ticket", "reason"],
  ask: ["ticket", "options", "message", "message-file"],
  inbox: ["wait", "timeout"],
  watch: ["stop", "follow", "since", "tickets", "kinds", "mine", "for"],
  stop: ["merged-pr", "claim-key"],
  answer: ["note", "message", "message-file"],
  init: ["program-root", "name", "slug", "no-stop-hook", "merge"],
  hold: ["reason"],
  merge: [
    "ticket",
    "no-ticket",
    "no-archive",
    "dry-run",
    "no-lock",
    "wait",
    "timeout",
    "reason",
    "ask-owner",
    "when-green",
    "keep-open",
    "through-hold",
  ],
  brief: ["pre-approve", "profile", "reason", "prompt", "profile-line", "validation", "validation-reason"],
  launch: [
    "pre-approve",
    "runtime",
    "harness",
    "profile",
    "reason",
    "validation",
    "validation-reason",
    "dry-run",
    "notes",
    "when-unblocked",
    "after",
  ],
  validate: ["ticket", "attach", "caption", "choices", "message", "message-file"],
  "ask-owner": ["choices"],
  login: ["api-key", "launch-token", "api-url"],
  secrets: ["ticket", "org", "value-stdin", "from-env", "file", "only"],
  run: ["ticket", "only"],
};

/** The worker commands a worker session signs in, on its own ticket. */
const WORKER_COMMANDS = new Set(["claim", "report", "release", "ask", "validate"]);

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null,
    rest: [],
    json: false,
    all: false,
    config: null,
    project: null,
    help: false,
    version: false,
    options: {},
    passthrough: null,
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--") {
      args.passthrough = argv.slice(k + 1);
      break;
    }
    const named = a?.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    const name = named?.[1];
    if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (
      name &&
      FLAG_OPTIONS.includes(name) &&
      !(name === "note" && args.command === "reserve") &&
      named?.[2] === undefined
    )
      args.options[name] = "true";
    else if (
      name &&
      (name === "config" ||
        name === "project" ||
        VALUE_OPTIONS.includes(name) ||
        (name === "note" && args.command === "reserve"))
    ) {
      const v = named?.[2] ?? argv[++k];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      if (name === "config") args.config = v;
      else if (name === "project") {
        if (!v.trim()) throw new UsageError("--project needs a non-empty slug");
        args.project = v;
      }
      // `--attach` repeats: one value per line.
      else if ((name === "attach" || name === "paths") && args.options[name] !== undefined)
        args.options[name] += `\n${v}`;
      else args.options[name] = v;
    } else if (a?.startsWith("-"))
      // Never the value: `--api-key=<key>` must not print the key.
      throw new UsageError(`unknown option ${name ? `--${name}${named?.[2] !== undefined ? "=…" : ""}` : a}`);
    else if (!args.command && a) args.command = a;
    else if (a) args.rest.push(a);
  }
  return args;
}

/** Resolves explicit config, environment, watched project, then the nearest armada.toml. */
export async function findConfig(
  io: Io,
  explicit: string | null,
  command = "status",
  project: string | null = null,
): Promise<{ path: string; text: string }> {
  let selected = explicit || io.env.ARMADA_CONFIG?.trim();
  if (!selected && project) {
    const paths = machinePaths(io.env);
    const known = paths ? await readWatchProjects(paths) : [];
    const checkout = known.find((p) => p.project === project);
    if (!checkout)
      throw new UsageError(
        `unknown project "${project}". Known projects on this machine: ${[...new Set(known.map((p) => p.project))].sort().join(", ") || "none"}`,
        `armada ${command} --config <file>, with the path of an ${CONFIG_FILE}`,
      );
    selected = join(checkout.root, CONFIG_FILE);
  }
  if (selected) {
    const path = resolve(io.cwd, selected);
    const text = await io.readFile(path);
    if (text === null)
      throw new UsageError(
        `${path} does not exist`,
        `armada ${command} --config <file>, with the path of an ${CONFIG_FILE}`,
      );
    return { path, text };
  }
  for (let dir = resolve(io.cwd); ; dir = dirname(dir)) {
    const path = join(dir, CONFIG_FILE);
    const text = await io.readFile(path);
    if (text !== null) return { path, text };
    if (dirname(dir) === dir) break;
  }
  throw new UsageError(
    `no ${CONFIG_FILE} found in ${io.cwd} or any parent directory, so this is not a repository Armada runs`,
    `armada init to set this repository up, armada ${command} --config <file> to use another ${CONFIG_FILE}, or armada status --all to see the registered projects`,
  );
}

async function status(io: Io, args: Args): Promise<number> {
  const { path, text } = await findConfig(io, args.config, "status", args.project);
  const config: ArmadaConfig = parseConfig(text, path);
  const { credentials } = await loadCredentials(io, { project: config.project.slug });
  const { linearApiKey, githubToken } = credentials;
  await recordPresence(io, config, credentials);
  if (!linearApiKey) throw missingKey(LINEAR_KEY);
  const live = statusLive(io, config, credentials);
  const report = await loadStatus(config, {
    linearApiKey,
    githubToken,
    ...(live ?? {}),
    ...httpOptions(io),
    ...(io.now ? { now: io.now } : {}),
  });
  const behind = await skillsBehind(fsRepoView(dirname(path))).catch(() => null);
  if (behind) report.warnings.push(skillsBehindLine(behind, version));
  io.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report));
  return 0;
}

function noExtra(rest: string[]) {
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
}

/** The command `argv` names (its first positional argument), even when parsing it failed. */
function commandOf(argv: string[]): string | null {
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k] ?? "";
    const name = a.match(/^--([a-z-]+)$/)?.[1];
    if (name && (name === "config" || name === "project" || VALUE_OPTIONS.includes(name))) k++;
    else if (!a.startsWith("-")) return a;
  }
  return null;
}

/** What to run after an error: the error's own next step, else the command's help. */
function nextStep(err: unknown, command: string | null): string | null {
  if (err instanceof Refusal) return err.next;
  if (err instanceof ArmadaApiError) return err.next;
  if (err instanceof UsageError)
    return err.next ?? (command ? `armada ${command} --help` : "armada --help, which lists every command");
  if (err instanceof ConfigError) return "armada doctor, once the file is fixed (it checks the whole setup)";
  if (err instanceof LinearError && /HTTP 401/.test(err.message)) return "armada auth status";
  if (err instanceof LinearError && /unreachable|HTTP 5\d\d/.test(err.message))
    return "the same command again once Linear answers";
  if (err instanceof CommandError) return "armada doctor, which checks this repository's setup";
  return null;
}

/**
 * Runs one command; returns the process exit code (0 ok, 1 failure, 2 usage or
 * configuration). A coordinator command then says once when a newer Armada is out.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  const code = await dispatch(argv, io);
  const command = commandOf(argv);
  if (command && NOTICE_COMMANDS.has(command))
    await (async () => {
      const args = parseArgs(argv);
      if (args.all) return await noticeRelease(io, version);
      const { path } = await findConfig(io, args.config, command, args.project);
      await noticeRelease(io, version, fsRepoView(dirname(path)));
    })().catch(() => {});
  return code;
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.version) {
      io.stdout(`${version}\n`);
      return 0;
    }
    if (args.help) {
      io.stdout((args.command && commandHelp(args.command)) || USAGE);
      return 0;
    }
    if (!args.command) {
      io.stderr(USAGE);
      return 2;
    }
    const allowed = COMMAND_OPTIONS[args.command] ?? [];
    for (const name of Object.keys(args.options))
      if (!allowed.includes(name)) throw new UsageError(`--${name} does not apply to ${args.command}`);
    if (args.all && args.command !== "status" && args.command !== "watch")
      throw new UsageError(`--all does not apply to ${args.command}`);
    if (args.passthrough && args.command !== "run")
      throw new UsageError(`-- does not apply to ${args.command}: only \`armada run\` runs a command`);
    if (args.command === "secrets" || args.command === "run") {
      const { path, text } = await findConfig(io, args.config, args.command, args.project);
      const config = parseConfig(text, path);
      // Fetching: the worker session of this ticket when the machine holds one, else this terminal's
      // sign-in. Setting is the coordinator's, never a worker session's, even on a machine that holds one.
      const sets = args.command === "secrets" && ["set", "unset"].includes(args.rest[0] ?? "");
      const { credentials } = await loadCredentials(io, {
        armada: false,
        ...(sets
          ? {}
          : {
              worker: {
                command: args.command,
                project: config.project.slug,
                ticket: (stored: string[]) => currentTicket(io, config, args.options.ticket, stored),
              },
            }),
      });
      return await (args.command === "run" ? runCommand : secretsCommand)(io, config, credentials, args);
    }
    if (args.command === "attach") {
      const { path, text } = await findConfig(io, args.config, "attach", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, {
        armada: false,
        worker: { command: "attach", project: config.project.slug, ticket: () => args.rest[0]?.toUpperCase() ?? null },
      });
      return await attachCommand(io, config, credentials, args);
    }
    if (args.command === "reserve" || args.command === "unreserve") {
      const { text } = await findConfig(io, args.config, args.command, args.project);
      const config = parseConfig(text);
      const { credentials } = await loadCredentials(io, {
        armada: false,
        worker: {
          command: args.command,
          project: config.project.slug,
          ticket: (stored) => {
            try {
              return currentTicket(io, config, args.options.ticket, stored);
            } catch (error) {
              if (args.options.list === "true" && !args.options.ticket && !io.env.ARMADA_TICKET && !stored.length)
                return null;
              throw error;
            }
          },
        },
      });
      return await (args.command === "reserve" ? reserveCommand : unreserveCommand)(io, config, credentials, args);
    }
    if (args.command === "heartbeat") {
      const { path, text } = await findConfig(io, args.config, "heartbeat", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, {
        armada: false,
        worker: {
          command: "heartbeat",
          project: config.project.slug,
          ticket: (stored) => currentTicket(io, config, args.options.ticket, stored),
        },
      });
      return await heartbeat(io, config, credentials, { ...args, config: path });
    }
    if (args.command === "ci") {
      const { path, text } = await findConfig(io, args.config, "ci", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, { armada: false });
      return await ciWhy(io, config, credentials, args);
    }
    if (args.command === "digest") {
      const { path, text } = await findConfig(io, args.config, "digest", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, { armada: false });
      return await digest(io, config, credentials, args);
    }
    const worker = { hold, claim, report, release, ask, inbox, answer, stop, validate, "ask-owner": askOwner, done }[
      args.command
    ];
    if (worker) {
      const { path, text } = await findConfig(io, args.config, args.command, args.project);
      const config = parseConfig(text, path);
      const command = args.command;
      // `validate <ticket> "<what>"` is the coordinator's form: the terminal's sign-in, never a worker session.
      const workerScope =
        WORKER_COMMANDS.has(command) && !(command === "validate" && namedTicket(args.rest, args.options));
      const scope = workerScope
        ? {
            command,
            project: config.project.slug,
            ticket: (stored: string[]) =>
              command === "claim"
                ? (args.rest[0]?.toUpperCase() ?? null)
                : currentTicket(io, config, args.options.ticket, stored),
          }
        : undefined;
      const { credentials } = await loadCredentials(io, scope ? { worker: scope } : { project: config.project.slug });
      if (command === "inbox") await recordPresence(io, config, credentials);
      return await worker(command === "stop" ? { ...io, cwd: dirname(path) } : io, config, credentials, args);
    }
    if (args.command === "watch") {
      const { path, text } = await findConfig(io, args.config, "watch", args.project);
      const config = parseConfig(text, path);
      if (args.options.stop === "true") {
        if (args.rest.length) throw new UsageError(`unexpected argument ${args.rest[0]}`);
        return await stopWatch(io, config.project.slug, args.json);
      }
      const { credentials } = await loadCredentials(io, { armada: false, project: config.project.slug });
      await recordPresence(io, config, credentials);
      return await watch(io, config, credentials, args, path);
    }
    if (args.command === "hook")
      return await hookStop(io, args.rest, (at) =>
        findConfig({ ...at, env: { ...at.env, ARMADA_CONFIG: undefined } }, null, "hook"),
      );
    if (args.command === "merge") {
      const { path, text } = await findConfig(io, args.config, "merge", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, { project: config.project.slug });
      await recordPresence(io, config, credentials);
      return await merge(io, config, credentials, args, path);
    }
    if (args.command === "spec") {
      const { text } = await findConfig(io, args.config, "spec", args.project);
      const config = parseConfig(text);
      // Identify this checkout's worker before requesting any coordinator keys.
      const local = await loadCredentials(io, {
        armada: false,
        worker: {
          command: "spec",
          project: config.project.slug,
          ticket: (stored) => currentTicket(io, config, undefined, stored),
        },
      });
      requireSpecCoordinator(local.credentials);
      const { credentials } = await loadCredentials(io, { project: config.project.slug });
      return await specCommand(io, config, credentials, args);
    }
    if (args.command === "brief") {
      const { path, text } = await findConfig(io, args.config, "brief", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, { project: config.project.slug });
      if (args.options.prompt === "true") await recordPresence(io, config, credentials);
      return await brief(io, config, credentials, args, version, path);
    }
    if (args.command === "setup") {
      const { path, text } = await findConfig(io, args.config, "setup", args.project);
      return await setupLocal(io, parseConfig(text, path), path, args);
    }
    if (args.command === "launch") {
      const { path, text } = await findConfig(io, args.config, "launch", args.project);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io, { project: config.project.slug });
      return await launch(io, config, credentials, args, version, path);
    }
    if (args.command === "status") {
      noExtra(args.rest);
      return await (args.all ? statusAll(io, args.json) : status(io, args));
    }
    if (args.command === "doctor") {
      noExtra(args.rest);
      return await doctor(io, args.json, version);
    }
    if (args.command === "upgrade") {
      noExtra(args.rest);
      if (args.json) throw new UsageError("--json does not apply to upgrade");
      const { path } = await findConfig(io, args.config, "upgrade", args.project);
      const { credentials } = await loadCredentials(io, { armada: false });
      if (
        credentials.armadaSignIn?.kind === "worker" ||
        (!credentials.armadaSignIn && credentials.workerTickets.length) ||
        io.env.ARMADA_TICKET?.trim()
      )
        throw new UsageError("workers keep their launch's pinned version; the coordinator runs armada upgrade");
      const root = await gitRoot(requireExec(io), dirname(path));
      if (basename(path) !== CONFIG_FILE || root !== dirname(path))
        throw new UsageError(
          "armada upgrade needs armada.toml at the selected repository's Git root; use that checkout's armada.toml",
        );
      if (credentials.armadaSignIn)
        try {
          await apiOf(io, credentials.armadaApi.url).whoami(credentials.armadaSignIn);
        } catch (err) {
          if (!(err instanceof ArmadaApiError)) throw err;
          if (err.signedOut) throw err;
          // A minimum-version refusal supplies the required target in its headers.
        }
      return await upgrade(io, version, root);
    }
    if (args.command === "skill") return printSkill(io, args.rest);
    if (args.command === "skills") {
      if (args.rest.length !== 1 || args.rest[0] !== "update") throw new UsageError("skills needs a command: update");
      return await updateSkills(io, version, args.json);
    }
    if (args.command === "init") {
      noExtra(args.rest);
      return await init(io, {
        armadaVersion: version,
        programRoot: args.options["program-root"] ?? null,
        name: args.options.name ?? null,
        slug: args.options.slug ?? null,
        stopHook: args.options["no-stop-hook"] === "true" ? false : null,
        merge: args.options.merge === "true",
      });
    }
    if (args.command === "login" || args.command === "logout" || args.command === "whoami") {
      // An extra argument may be a pasted key: it is refused without being quoted.
      if (args.rest.length)
        throw new UsageError(
          `${args.command} takes no argument${args.command === "login" ? ": an API key is read from a hidden prompt or standard input, never from the command line" : ""}`,
        );
      if (args.command === "login")
        return await login(io, {
          apiKey: args.options["api-key"] === "true",
          launchToken: args.options["launch-token"] ?? null,
          apiUrl: args.options["api-url"] ?? null,
        });
      if (args.command === "logout") return await logout(io);
      return await whoami(io, args.json);
    }
    if (args.command === "auth") {
      const [sub, ...extra] = args.rest;
      noExtra(extra);
      if (sub === "login") return await authLogin(io);
      if (sub === "status") return await authStatus(io, args.json);
      if (sub === "logout") return await authLogout(io);
      throw new UsageError(sub ? `unknown auth command "${sub}"` : "auth needs a command: login, status or logout");
    }
    throw new UsageError(`unknown command "${args.command}"`);
  } catch (err) {
    const command = commandOf(argv);
    const next = nextStep(err, command && Object.hasOwn(COMMAND_HELP, command) ? command : null);
    io.stderr(`armada: ${err instanceof Error ? err.message : String(err)}\n${next ? `Next: ${next}\n` : ""}`);
    return err instanceof UsageError ||
      err instanceof ConfigError ||
      (err instanceof Refusal && err.cause instanceof UsageError)
      ? 2
      : 1;
  }
}
