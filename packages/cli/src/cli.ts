// Command dispatch with every side effect injected, so commands can be tested
// without a network, a real clock or the user's environment.
import { dirname, join, resolve } from "node:path";
import {
  type ArmadaConfig,
  CONFIG_FILE,
  ConfigError,
  LINEAR_KEY,
  loadStatus,
  missingKeyMessage,
  parseConfig,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { authLogin, authLogout, authStatus, loadCredentials } from "./auth.ts";
import { brief } from "./brief.ts";
import { doctor } from "./doctor.ts";
import { init } from "./init.ts";
import { type Io, UsageError } from "./io.ts";
import { merge } from "./merge.ts";
import { statusAll } from "./projects.ts";
import { renderStatus } from "./render.ts";
import { claim, release, report, statusEvents } from "./worker.ts";

export { authLogin } from "./auth.ts";
export type { Io } from "./io.ts";

export const USAGE = `Usage: armada <command> [options]

Commands:
  status            Tickets in flight, tickets ready to start and pull requests waiting
  status --all      The same for every project registered by \`armada init\`
  doctor            What this repository lacks to be run by Armada, with the fix for each
  init [--program-root <ISSUE-ID>] [--name <name>] [--slug <slug>]
                    Open one pull request that installs or updates it all, create the
                    missing Linear labels and register the project. The options are for
                    a repository without armada.toml (Linear issue at the program root)
  claim <ticket> --runtime <name> --handle <id> [--branch <name>]
                    Claim a ticket for this worker: In Progress, phase planning, runtime
                    label and an Agent claim comment; refused if another worker holds it
  report <phase> [--message <text> | --message-file <path|->] [--pr <n|url>] [--sha <sha>]
                    Report a phase (planning, awaiting-approval, implementing, shipping,
                    blocked, ready-to-merge); the same phase again is a status update.
                    ready-to-merge needs --sha (full 40 characters, the PR head) and green CI.
                    Prints what waits in this worker's inbox.
  release --reason <text>
                    Give the ticket back: agent labels removed, ticket moved back
  merge <pr> [--ticket <id>] [--dry-run] [--no-lock]
                    Coordinator: check a handed-back pull request (hand-back SHA = head,
                    CLEAN, required checks green, no open review thread, base contained
                    or test-merged), squash-merge it pinned to that SHA under the merge
                    lock, close the ticket and list the workers to tell. Never deletes
                    the branch. --dry-run only runs the checklist. Refused when Turso is
                    configured but down; --no-lock then merges without the lock.
  brief <ticket> [--profile <name>] [--prompt]
                    A new worker's launch prompt, the Conductor profile (agent, model,
                    effort) and the environment variables to pass, named, never shown.
                    --prompt prints only the prompt, for \`--message-file -\`
  auth login        Ask for the missing keys (hidden input) and store them on this machine
  auth status       Show which keys are set and where each comes from, never their values
  auth logout       Remove Armada's keys from this machine

Options:
  --json            Print the result as JSON
  --config <path>   Use this armada.toml instead of searching from the current directory
  --ticket <id>     Ticket for report and release (default ARMADA_TICKET, then the git
                    branch) and for merge (default: the ticket the PR branch names)
  -h, --help        Show this help
  -v, --version     Print the version

Keys (the environment always wins over the file):
  LINEAR_API_KEY       Linear API key (required by status, init, brief, claim, report,
                       release)
  ARMADA_TURSO_URL     Turso database URL (required by init and status --all; optional
                       elsewhere; a file: URL works locally)
  ARMADA_TURSO_TOKEN   Turso database token
  GITHUB_TOKEN         GitHub token; falls back to GH_TOKEN, then \`gh auth token\`
                       (merge also runs gh and git, with gh's own login)

Files:
  $XDG_CONFIG_HOME/armada (default ~/.config/armada)
    credentials        KEY=value lines, mode 0600, written by \`armada auth login\`
    config.toml        personal defaults: language, [turso] url, [dashboard] url
`;

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
];
/** Options without a value, stored as "true". */
const FLAG_OPTIONS = ["dry-run", "no-lock", "prompt"];
/** Value options each command accepts. */
const COMMAND_OPTIONS: Record<string, string[]> = {
  claim: ["runtime", "handle", "branch"],
  report: ["ticket", "message", "message-file", "pr", "sha"],
  release: ["ticket", "reason"],
  init: ["program-root", "name", "slug"],
  merge: ["ticket", "dry-run", "no-lock"],
  brief: ["profile", "prompt"],
};

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
    } else if (a?.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (!args.command && a) args.command = a;
    else if (a) args.rest.push(a);
  }
  return args;
}

/** Finds armada.toml in `start` or the nearest parent directory. */
export async function findConfig(io: Io, explicit: string | null): Promise<{ path: string; text: string }> {
  if (explicit) {
    const path = resolve(io.cwd, explicit);
    const text = await io.readFile(path);
    if (text === null) throw new UsageError(`${path} does not exist`);
    return { path, text };
  }
  for (let dir = resolve(io.cwd); ; dir = dirname(dir)) {
    const path = join(dir, CONFIG_FILE);
    const text = await io.readFile(path);
    if (text !== null) return { path, text };
    if (dirname(dir) === dir) break;
  }
  throw new UsageError(
    `no ${CONFIG_FILE} found in ${io.cwd} or any parent directory. Add one at the repository root (see README).`,
  );
}

async function status(io: Io, args: Args): Promise<number> {
  const { path, text } = await findConfig(io, args.config);
  const config: ArmadaConfig = parseConfig(text, path);
  const { credentials } = await loadCredentials(io);
  const { linearApiKey, githubToken } = credentials;
  if (!linearApiKey) throw new UsageError(missingKeyMessage(LINEAR_KEY));
  const events = statusEvents(config, credentials);
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

/** Runs one command; returns the process exit code (0 ok, 1 failure, 2 usage or configuration). */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.version) {
      io.stdout(`${version}\n`);
      return 0;
    }
    if (args.help || !args.command) {
      (args.help ? io.stdout : io.stderr)(USAGE);
      return args.help ? 0 : 2;
    }
    const allowed = COMMAND_OPTIONS[args.command] ?? [];
    for (const name of Object.keys(args.options))
      if (!allowed.includes(name)) throw new UsageError(`--${name} does not apply to ${args.command}`);
    if (args.all && args.command !== "status") throw new UsageError(`--all does not apply to ${args.command}`);
    const worker = { claim, report, release }[args.command];
    if (worker) {
      const { path, text } = await findConfig(io, args.config);
      const config = parseConfig(text, path);
      const { credentials } = await loadCredentials(io);
      return await worker(io, config, credentials, args);
    }
    if (args.command === "merge") {
      const { path, text } = await findConfig(io, args.config);
      const { credentials } = await loadCredentials(io);
      return await merge(io, parseConfig(text, path), credentials, args, path);
    }
    if (args.command === "brief") {
      const { path, text } = await findConfig(io, args.config);
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
    if (err instanceof UsageError || err instanceof ConfigError) {
      io.stderr(`armada: ${err.message}\n`);
      return 2;
    }
    io.stderr(`armada: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
