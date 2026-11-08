import { AuthError, assertProvider } from "@armada/auth";
import {
  configFromFlags,
  connectGolden,
  createGolden,
  GOLDEN_ROOT,
  type GoldenActor,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  type GoldenStore,
  type Provider,
  ProviderError,
  parseGoldenConfig,
  snapshotGolden,
  VERSION,
  type Visibility,
} from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { flag, parseArgs, single, values } from "./args.ts";
import {
  type AuthIo,
  loginCommand,
  logoutCommand,
  productionAuthIo,
  tokenCreate,
  tokenList,
  tokenRevoke,
} from "./auth-commands.ts";
import { openSupabaseGoldens } from "./supabase.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface Deps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  provider?: Provider;
  store?: GoldenStore;
  actor?: GoldenActor;
  sandboxPolls?: number;
  snapshotPolls?: number;
  /** Set by auth tests. Otherwise login talks to Supabase and stores the session on this machine. */
  auth?: AuthIo;
}

const HELP = `armada ${VERSION}: launch coding agents on boat.dev

Usage:
  armada --version                         Print the version
  armada --help                            Show this help
  armada golden create <name> (--repo <url>[@branch] ... | --config <file>) [--init <cmd> ...] [--private]
  armada golden connect <name>             Open the master sandbox to place .env files
  armada golden snapshot <name>            Freeze the master sandbox
  armada golden list [--json]              Goldens you can see
  armada login [--provider github|google]
  armada logout
  armada token create [--org <name>] [--label <label>]
  armada token list
  armada token revoke <id>

Environment:
  ARMADA_SUPABASE_URL, ARMADA_SUPABASE_ANON_KEY, ARMADA_ACCESS_TOKEN, ARMADA_ORG
                                           Golden commands, as the signed-in user
  SUPABASE_URL, SUPABASE_ANON_KEY          armada login
`;

/** Runs one command line and returns the process exit code. */
export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  try {
    return await dispatch(argv, io, deps);
  } catch (error) {
    if (error instanceof GoldenError) {
      io.err(`armada: ${error.message}\n`);
      return error.code === "invalid_config" ? 2 : 1;
    }
    if (error instanceof ProviderError) {
      io.err(`armada: ${error.message}\n`);
      return 1;
    }
    if (error instanceof AuthError) {
      io.err(`armada: ${error.message}\n`);
      return error.code === "usage" ? 2 : 1;
    }
    throw error;
  }
}

async function dispatch(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "--version":
    case "-v":
      io.out(`${VERSION}\n`);
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      io.out(HELP);
      return 0;
    case "golden":
      return golden(rest, io, deps);
    case "login":
      return login(rest, io, deps);
    case "logout":
      return logout(rest, io, deps);
    case "token":
      return tokenCommand(parseAuth(rest), authOf(io, deps));
    default:
      io.err(`armada: unknown command '${command}'. Run 'armada --help'.\n`);
      return 2;
  }
}

async function golden(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    io.out(HELP);
    return subcommand === undefined ? 2 : 0;
  }
  const args = parseArgs(rest);
  const limits = {
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.sandboxPolls !== undefined ? { sandboxPolls: deps.sandboxPolls } : {}),
    ...(deps.snapshotPolls !== undefined ? { snapshotPolls: deps.snapshotPolls } : {}),
  };
  switch (subcommand) {
    case "create":
      return create(args.positionals, args, io, deps, limits);
    case "connect":
      return connect(args.positionals, io, deps, limits);
    case "snapshot":
      return snapshot(args.positionals, io, deps, limits);
    case "list":
      return list(args, io, deps);
    default:
      io.err(`armada: unknown command 'golden ${subcommand}'. Run 'armada --help'.\n`);
      return 2;
  }
}

type Limits = {
  sleep?: (ms: number) => Promise<void>;
  sandboxPolls?: number;
  snapshotPolls?: number;
};

async function create(
  positionals: string[],
  args: ReturnType<typeof parseArgs>,
  io: Io,
  deps: Deps,
  limits: Limits,
): Promise<number> {
  const name = oneName(positionals);
  const config = await readConfig(args, deps);
  const visibility: Visibility = flag(args, "--private") ? "private" : "org";
  const { provider, store, actor } = await boatContext(deps);
  const created = await createGolden(provider, store, actor, { name, visibility, config }, limits);
  const dirs = created.golden.config.repos.map((repo) => repo.dir).join(", ");
  io.out(
    [
      `Created golden ${created.golden.name} (${created.golden.visibility}).`,
      `Sandbox: ${created.sandboxId}`,
      `Boat snapshot name: ${created.snapshotName}`,
      `Repos: ${dirs} in ${GOLDEN_ROOT}.`,
      `The sandbox has none of the boat account's credentials.`,
      `Place .env files with 'armada golden connect ${created.golden.name}', then 'armada golden snapshot ${created.golden.name}'.`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function connect(positionals: string[], io: Io, deps: Deps, limits: Limits): Promise<number> {
  const name = oneName(positionals);
  const { provider, store, actor } = await boatContext(deps);
  const { golden: record, sandbox } = await connectGolden(provider, store, actor, name, limits);
  const repos = record.config.repos
    .map((repo) => `  ${repo.dir}  ${GOLDEN_ROOT}/${repo.dir}  ${repo.branch}`)
    .join("\n");
  const shell = sandbox.sshEndpoint
    ? `SSH: ssh -p ${portOf(sandbox.sshEndpoint)} user@${hostOf(sandbox.sshEndpoint)}\nboat ssh ${sandbox.id}`
    : `Shell: boat ssh ${sandbox.id}`;
  io.out(
    [
      `Golden ${record.name} (${record.visibility}) is ready for setup.`,
      `Sandbox: ${sandbox.id}`,
      shell,
      "Repos:",
      repos,
      "The sandbox has none of the boat account's credentials. Put .env files in the repo directories, then snapshot.",
      "",
    ].join("\n"),
  );
  return 0;
}

async function snapshot(positionals: string[], io: Io, deps: Deps, limits: Limits): Promise<number> {
  const name = oneName(positionals);
  const { provider, store, actor } = await boatContext(deps);
  const saved = await snapshotGolden(provider, store, actor, name, limits);
  io.out(`Snapshotted golden ${saved.golden.name}.\nSaved snapshot: ${saved.snapshotName}\n`);
  return 0;
}

async function list(args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  if (args.positionals.length > 0) throw new GoldenError("invalid_config", "golden list takes no name.");
  const { store, actor } = await session(deps);
  const rows = await store.list(actor.orgId);
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(rows.map(jsonGolden), null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.out("No goldens.\n");
    return 0;
  }
  io.out(`${rows.map(line).join("\n")}\n`);
  return 0;
}

function line(row: GoldenRecord): string {
  const snapshot = row.boatSnapshotId ? "snapshot" : "no snapshot";
  const repos = row.config.repos.length === 1 ? "1 repo" : `${row.config.repos.length} repos`;
  return `${row.name}  ${row.visibility}  ${snapshot}  ${repos}`;
}

function jsonGolden(row: GoldenRecord) {
  return {
    name: row.name,
    visibility: row.visibility,
    ownerId: row.ownerId,
    boatSnapshotId: row.boatSnapshotId,
    boatSandboxId: row.boatSandboxId,
    repos: row.config.repos.length,
    config: row.config,
  };
}

async function readConfig(args: ReturnType<typeof parseArgs>, deps: Deps): Promise<GoldenConfig> {
  const file = single(args, "--config");
  const repos = values(args, "--repo");
  const init = values(args, "--init");
  if (file && (repos.length > 0 || init.length > 0)) {
    throw new GoldenError("invalid_config", "Pass either --config or --repo and --init, not both.");
  }
  if (file) {
    const read = deps.readFile ?? ((path: string) => Bun.file(path).text());
    let text: string;
    try {
      text = await read(file);
    } catch {
      throw new GoldenError("invalid_config", `Could not read config file '${file}'.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GoldenError("invalid_config", `Config file '${file}' is not JSON.`);
    }
    return parseGoldenConfig(parsed);
  }
  return configFromFlags(repos, init);
}

function oneName(positionals: string[]): string {
  const name = positionals[0];
  if (name === undefined || positionals.length !== 1) {
    throw new GoldenError("invalid_config", "Give exactly one golden name.");
  }
  return name;
}

async function session(deps: Deps): Promise<{ store: GoldenStore; actor: GoldenActor }> {
  if (deps.store && deps.actor) return { store: deps.store, actor: deps.actor };
  const opened = await openSupabaseGoldens(deps.env ?? process.env, deps.fetch ?? fetch);
  return { store: deps.store ?? opened.store, actor: deps.actor ?? opened.actor };
}

async function boatContext(deps: Deps): Promise<{ provider: Provider; store: GoldenStore; actor: GoldenActor }> {
  const { store, actor } = await session(deps);
  const provider = deps.provider ?? boatProvider(deps.env ?? process.env, deps.fetch ?? fetch, deps.sleep);
  return { provider, store, actor };
}

function boatProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  sleep?: (ms: number) => Promise<void>,
): Provider {
  const apiKey = env.BOAT_API_KEY;
  if (!apiKey) {
    throw new GoldenError(
      "invalid_config",
      "Set BOAT_API_KEY. Armada does not use credentials stored on the boat.dev account.",
    );
  }
  return createBoatProvider({
    apiKey,
    fetch: fetchImpl,
    ...(sleep ? { sleep } : {}),
  });
}

function hostOf(endpoint: string): string {
  return endpoint.slice(0, endpoint.lastIndexOf(":"));
}

function portOf(endpoint: string): string {
  return endpoint.slice(endpoint.lastIndexOf(":") + 1);
}

async function login(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseAuth(argv);
  rejectUnknown(parsed.flags, ["provider"]);
  if (parsed.position.length > 0) throw new AuthError("Run armada login --help.", "usage");
  const provider = parsed.flags.has("provider") ? assertProvider(authFlag(parsed.flags, "provider")) : undefined;
  await loginCommand(authOf(io, deps), provider);
  return 0;
}

async function logout(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseAuth(argv);
  rejectUnknown(parsed.flags, []);
  if (parsed.position.length > 0) throw new AuthError("Run armada logout.", "usage");
  await logoutCommand(authOf(io, deps));
  return 0;
}

async function tokenCommand(parsed: AuthArgs, auth: AuthIo): Promise<number> {
  const sub = parsed.position[0];
  const extra = parsed.position[1];
  switch (sub) {
    case "create":
      rejectUnknown(parsed.flags, ["org", "label"]);
      if (extra !== undefined) throw new AuthError("Run armada token create --org <name> --label <label>.", "usage");
      await tokenCreate(auth, parsed.flags.get("org"), parsed.flags.get("label"));
      return 0;
    case "list":
      rejectUnknown(parsed.flags, []);
      if (extra !== undefined) throw new AuthError("Run armada token list.", "usage");
      await tokenList(auth);
      return 0;
    case "revoke":
      rejectUnknown(parsed.flags, []);
      if (!extra || parsed.position.length > 2) throw new AuthError("Run armada token revoke <id>.", "usage");
      await tokenRevoke(auth, extra);
      return 0;
    default:
      throw new AuthError("Run armada token create, list, or revoke.", "usage");
  }
}

interface AuthArgs {
  position: string[];
  flags: Map<string, string>;
}

function parseAuth(argv: readonly string[]): AuthArgs {
  const position: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      position.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      position.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name.length === 0) throw new AuthError("Unknown flag.", "usage");
    const value = eq === -1 ? argv[index + 1] : arg.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith("--")) throw new AuthError(`Missing value for --${name}.`, "usage");
      index += 1;
    }
    if (value === undefined) throw new AuthError(`Missing value for --${name}.`, "usage");
    flags.set(name, value);
  }
  return { position, flags };
}

function authFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new AuthError(`Missing value for --${name}.`, "usage");
  return value;
}

function rejectUnknown(flags: Map<string, string>, allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new AuthError(`Unknown flag --${name}.`, "usage");
  }
}

function authOf(io: Io, deps: Deps): AuthIo {
  return deps.auth ?? productionAuthIo(io, deps.env ?? process.env);
}
