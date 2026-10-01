// Command dispatch with every side effect injected, so commands can be tested
// without a network, a real clock or the user's environment.
import { dirname, join, resolve } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  CONFIG_FILE,
  ConfigError,
  LINEAR_KEY,
  LinearError,
  loadStatus,
  parseConfig,
  Refusal,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { authLogin, authLogout, authStatus, loadCredentials } from "./auth.ts";
import { brief } from "./brief.ts";
import { doctor } from "./doctor.ts";
import { answer, ask, inbox } from "./inbox.ts";
import { init } from "./init.ts";
import { type Io, missingKey, UsageError } from "./io.ts";
import { login, logout, whoami } from "./login.ts";
import { merge } from "./merge.ts";
import { statusAll } from "./projects.ts";
import { renderStatus } from "./render.ts";
import { CommandError } from "./repo.ts";
import { claim, currentTicket, release, report, statusEvents } from "./worker.ts";

export { authLogin } from "./auth.ts";
export type { Io } from "./io.ts";

/** Each command's help block, in the order of the full usage; `armada <command> --help` prints its own. */
const COMMAND_HELP: Record<string, string> = {
  status: `  status            Tickets in flight, tickets ready to start and pull requests waiting
  status --all      The same for every project registered by \`armada init\`
`,
  doctor: `  doctor            What this repository lacks to be run by Armada, with the fix for each,
                    and whether this terminal is signed in to Armada
`,
  init: `  init [--program-root <ISSUE-ID>] [--name <name>] [--slug <slug>]
                    Open one pull request that installs or updates it all, create the
                    missing Linear labels and register the project. The options are for
                    a repository without armada.toml (Linear issue at the program root)
`,
  claim: `  claim <ticket> --runtime <name> --handle <id> [--branch <name>]
        [--profile <name> [--reason <why>]]
                    Claim a ticket for this worker: In Progress, phase planning, runtime
                    label and an Agent claim comment; refused if another worker holds it.
                    --profile records the Conductor profile; one other than the ticket's
                    routed profile needs --reason. Prints the ticket's state afterwards
`,
  report: `  report <phase> [--message <text> | --message-file <path|->] [--pr <n|url>] [--sha <sha>]
                    Report a phase (planning, awaiting-approval, implementing, shipping,
                    blocked, ready-to-merge); the same phase again is a status update.
                    ready-to-merge needs --sha (full 40 characters, the PR head) and green CI.
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
  inbox: `  inbox [--wait [--timeout <seconds>]]
                    Coordinator: open questions, plans, requests, hand-backs and silent workers,
                    oldest first; records that the coordinator is at work. --wait returns
                    when a new item arrives or after --timeout (default 300 s). Needs a
                    sign-in to Armada
`,
  answer: `  answer <item|ticket> "<answer>"
                    Coordinator: record an answer already delivered in the worker's
                    session (runtime guide): resolves the question or plan and posts it on
                    the ticket. A ticket id answers its open questions and plans. Never calls a runtime
  answer --note <ticket|plan item> "<message>"
                    Coordinator: record a delivered note; an open plan is resolved
`,
  merge: `  merge <pr> [--ticket <id>] [--dry-run] [--no-lock]
                    Coordinator: check a handed-back pull request (hand-back SHA = head,
                    CLEAN, required checks green, no open review thread, base contained
                    or test-merged), squash-merge it pinned to that SHA under the merge
                    lock, close the ticket and list the workers to tell. Never deletes
                    the branch. --dry-run only runs the checklist. Signed in to Armada,
                    refused while Armada is down; --no-lock then merges without the lock.
`,
  brief: `  brief <ticket> [--profile <name> [--reason <why>]] [--prompt]
                    A new worker's launch prompt, the Conductor profile (agent, model,
                    effort) and the environment variables to pass, named, never shown.
                    The profile follows [[conductor.routing]] on the ticket's labels, then
                    default_profile; --profile overrides it, with --reason when it differs.
                    Signed in to Armada, the prompt starts with a one-time launch token, so
                    the worker needs no key. --prompt prints only the prompt, for \`--message-file -\`
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
const TICKET_OPTION = new Set(["report", "release", "ask", "merge"]);
const CONFIG_OPTION = new Set(["status", "claim", "report", "release", "ask", "inbox", "answer", "merge", "brief"]);
const JSON_OPTION = new Set([...CONFIG_OPTION, "doctor", "auth", "whoami"]);
const TICKET_HELP = `  --ticket <id>     Ticket for report, release and ask (default ARMADA_TICKET, then the git
                    branch) and for merge (default: the ticket the PR branch names)
`;

export const USAGE = `Usage: armada <command> [options]

Commands:
${Object.values(COMMAND_HELP).join("")}
Options:
  --json            Print the result as JSON
  --config <path>   Use this armada.toml instead of searching from the current directory
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
init, inbox and status --all need a sign-in; elsewhere, signed out, live activity
is not recorded and Linear stays the record.

Files:
  $XDG_CONFIG_HOME/armada (default ~/.config/armada)
    credentials        KEY=value lines, mode 0600, written by \`armada auth login\` and
                       \`armada login\` (the sign-in: ARMADA_SESSION_TOKEN or ARMADA_API_KEY)
    config.toml        personal defaults: language, [dashboard] url, [api] url
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
      ? "  --config <path>   Use this armada.toml instead of searching from the current directory\n"
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
  help: boolean;
  version: boolean;
  /** Options that take a value, other than --config. */
  options: Record<string, string>;
}

const VALUE_OPTIONS = [
  "runtime",
  "handle",
  "branch",
  "ticket",
  "message",
  "message-file",
  "pr",
  "sha",
  "reason",
  "program-root",
  "name",
  "slug",
  "profile",
  "options",
  "timeout",
  "launch-token",
  "api-url",
];
/** Options without a value, stored as "true". */
const FLAG_OPTIONS = ["dry-run", "no-lock", "prompt", "wait", "note", "api-key"];
/** Value options each command accepts. */
const COMMAND_OPTIONS: Record<string, string[]> = {
  claim: ["runtime", "handle", "branch", "profile", "reason"],
  report: ["ticket", "message", "message-file", "pr", "sha"],
  release: ["ticket", "reason"],
  ask: ["ticket", "options", "message", "message-file"],
  inbox: ["wait", "timeout"],
  answer: ["note", "message", "message-file"],
  init: ["program-root", "name", "slug"],
  merge: ["ticket", "dry-run", "no-lock"],
  brief: ["profile", "reason", "prompt"],
  login: ["api-key", "launch-token", "api-url"],
};

/** The worker commands a worker session signs in, on its own ticket. */
const WORKER_COMMANDS = new Set(["claim", "report", "release", "ask"]);

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null,
    rest: [],
    json: false,
    all: false,
    config: null,
    help: false,
    version: false,
    options: {},
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const named = a?.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    const name = named?.[1];
    if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (name && FLAG_OPTIONS.includes(name) && named?.[2] === undefined) args.options[name] = "true";
    else if (name && (name === "config" || VALUE_OPTIONS.includes(name))) {
      const v = named?.[2] ?? argv[++k];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      if (name === "config") args.config = v;
      else args.options[name] = v;
    } else if (a?.startsWith("-"))
      // Never the value: `--api-key=<key>` must not print the key.
      throw new UsageError(`unknown option ${name ? `--${name}${named?.[2] !== undefined ? "=…" : ""}` : a}`);
    else if (!args.command && a) args.command = a;
    else if (a) args.rest.push(a);
  }
  return args;
}

/** Finds armada.toml in `start` or the nearest parent directory. */
export async function findConfig(
  io: Io,
  explicit: string | null,
  command = "status",
): Promise<{ path: string; text: string }> {
  if (explicit) {
    const path = resolve(io.cwd, explicit);
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
  const { path, text } = await findConfig(io, args.config, "status");
  const config: ArmadaConfig = parseConfig(text, path);
  const { credentials } = await loadCredentials(io);
  const { linearApiKey, githubToken } = credentials;
  if (!linearApiKey) throw missingKey(LINEAR_KEY);
  const events = statusEvents(io, config, credentials);
  const report = await loadStatus(config, {
    linearApiKey,
    githubToken,
    ...(events ? { lastEvents: events } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.now ? { now: io.now } : {}),
  });
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
    if (name && (name === "config" || VALUE_OPTIONS.includes(name))) k++;
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

/** Runs one command; returns the process exit code (0 ok, 1 failure, 2 usage or configuration). */
export async function run(argv: string[], io: Io): Promise<number> {
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
    if (args.all && args.command !== "status") throw new UsageError(`--all does not apply to ${args.command}`);
    const worker = { claim, report, release, ask, inbox, answer }[args.command];
    if (worker) {
      const { path, text } = await findConfig(io, args.config, args.command);
      const config = parseConfig(text, path);
      const command = args.command;
      const scope = WORKER_COMMANDS.has(command)
        ? {
            command,
            project: config.project.slug,
            ticket: (stored: string[]) =>
              command === "claim"
                ? (args.rest[0]?.toUpperCase() ?? null)
                : currentTicket(io, config, args.options.ticket, stored),
          }
        : undefined;
      const { credentials } = await loadCredentials(io, scope ? { worker: scope } : {});
      return await worker(io, config, credentials, args);
    }
    if (args.command === "merge") {
      const { path, text } = await findConfig(io, args.config, "merge");
      const { credentials } = await loadCredentials(io);
      return await merge(io, parseConfig(text, path), credentials, args, path);
    }
    if (args.command === "brief") {
      const { path, text } = await findConfig(io, args.config, "brief");
      const { credentials } = await loadCredentials(io);
      return await brief(io, parseConfig(text, path), credentials, args, version);
    }
    if (args.command === "status") {
      noExtra(args.rest);
      return await (args.all ? statusAll(io, args.json) : status(io, args));
    }
    if (args.command === "doctor") {
      noExtra(args.rest);
      return await doctor(io, args.json, version);
    }
    if (args.command === "init") {
      noExtra(args.rest);
      return await init(io, {
        armadaVersion: version,
        programRoot: args.options["program-root"] ?? null,
        name: args.options.name ?? null,
        slug: args.options.slug ?? null,
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
    return err instanceof UsageError || err instanceof ConfigError ? 2 : 1;
  }
}
