// Command dispatch with every side effect injected, so commands can be tested
// without a network, a real clock or the user's environment.
import { dirname, join, resolve } from "node:path";
import { type ArmadaConfig, CONFIG_FILE, ConfigError, type Fetch, loadStatus, parseConfig } from "@armada/core";
import { renderStatus } from "./render.ts";

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string | null>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Token from the GitHub CLI (`gh auth token`), or null. */
  ghToken: () => string | null;
  fetch?: Fetch;
  now?: () => Date;
}

export const USAGE = `Usage: armada <command> [options]

Commands:
  status            Tickets in flight, tickets ready to start and pull requests waiting

Options:
  --json            Print the status as JSON
  --config <path>   Use this armada.toml instead of searching from the current directory
  -h, --help        Show this help

Environment:
  LINEAR_API_KEY    Linear API key (required)
  GITHUB_TOKEN      GitHub token; falls back to GH_TOKEN, then \`gh auth token\`
`;

class UsageError extends Error {}

interface Args {
  command: string | null;
  json: boolean;
  config: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, json: false, config: null, help: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--config") {
      const v = argv[++k];
      if (!v) throw new UsageError("--config needs a path");
      args.config = v;
    } else if (a?.startsWith("--config=")) args.config = a.slice("--config=".length);
    else if (a?.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (!args.command && a) args.command = a;
    else throw new UsageError(`unexpected argument ${a}`);
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
  const linearApiKey = io.env.LINEAR_API_KEY?.trim();
  if (!linearApiKey) throw new UsageError("LINEAR_API_KEY is not set. Create a personal API key in Linear settings.");
  const githubToken = io.env.GITHUB_TOKEN?.trim() || io.env.GH_TOKEN?.trim() || io.ghToken();
  const report = await loadStatus(config, {
    linearApiKey,
    githubToken: githubToken || null,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.now ? { now: io.now } : {}),
  });
  io.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report));
  return 0;
}

/** Runs one command; returns the process exit code (0 ok, 1 failure, 2 usage or configuration). */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help || !args.command) {
      (args.help ? io.stdout : io.stderr)(USAGE);
      return args.help ? 0 : 2;
    }
    if (args.command === "status") return await status(io, args);
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
