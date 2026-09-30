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
import pkg from "../package.json" with { type: "json" };
import { authLogin, authLogout, authStatus, loadCredentials } from "./auth.ts";
import { type Io, UsageError } from "./io.ts";
import { renderStatus } from "./render.ts";

export { authLogin } from "./auth.ts";
export type { Io } from "./io.ts";

export const USAGE = `Usage: armada <command> [options]

Commands:
  status            Tickets in flight, tickets ready to start and pull requests waiting
  auth login        Ask for the missing keys (hidden input) and store them on this machine
  auth status       Show which keys are set and where each comes from, never their values
  auth logout       Remove Armada's keys from this machine

Options:
  --json            Print the status as JSON
  --config <path>   Use this armada.toml instead of searching from the current directory
  -h, --help        Show this help
  -v, --version     Print the version

Keys (the environment always wins over the file):
  LINEAR_API_KEY       Linear API key (required by status)
  ARMADA_TURSO_URL     Turso database URL
  ARMADA_TURSO_TOKEN   Turso database token
  GITHUB_TOKEN         GitHub token; falls back to GH_TOKEN, then \`gh auth token\`

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
  config: string | null;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, rest: [], json: false, config: null, help: false, version: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a === "--config") {
      const v = argv[++k];
      if (!v) throw new UsageError("--config needs a path");
      args.config = v;
    } else if (a?.startsWith("--config=")) args.config = a.slice("--config=".length);
    else if (a?.startsWith("-")) throw new UsageError(`unknown option ${a}`);
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
  const { linearApiKey, githubToken } = (await loadCredentials(io)).credentials;
  if (!linearApiKey) throw new UsageError(missingKeyMessage(LINEAR_KEY));
  const report = await loadStatus(config, {
    linearApiKey,
    githubToken,
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
      io.stdout(`${pkg.version}\n`);
      return 0;
    }
    if (args.help || !args.command) {
      (args.help ? io.stdout : io.stderr)(USAGE);
      return args.help ? 0 : 2;
    }
    if (args.command === "status") {
      noExtra(args.rest);
      return await status(io, args);
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
