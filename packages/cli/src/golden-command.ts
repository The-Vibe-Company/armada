import {
  boatSnapshotName,
  type Caller,
  connectGolden,
  createGolden,
  type GoldenDeps,
  GoldenError,
  listGoldens,
  ProviderError,
  parseGoldenConfig,
  snapshotGolden,
  type Visibility,
} from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { goldenStoreFromDatabaseUrl } from "./golden-store.ts";
import type { Io } from "./run.ts";

export const GOLDEN_HELP = `golden commands:
  armada golden create <name> [--config <file>] [--repo <url>[@branch]]... [--init <cmd>]... [--private]
  armada golden connect <name>
  armada golden snapshot <name>
  armada golden list

create starts a build sandbox with none of the boat account's model credentials, clones the repos and runs init.
connect prints the shell for placing .env files in those checkouts.
snapshot freezes the sandbox under a name unique to this org and records it.
`;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface RunDeps {
  env?: Record<string, string | undefined>;
  store?: GoldenDeps["store"];
  provider?: GoldenDeps["provider"];
  sleep?: GoldenDeps["sleep"];
  readText?: (path: string) => Promise<string>;
}

type Invocation =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "connect"; name: string }
  | { kind: "snapshot"; name: string }
  | { kind: "create"; name: string; visibility: Visibility; configPath?: string; repoArgs: string[]; init: string[] };

/** `--repo url[@branch]`. The `@branch` suffix is only a branch when the rest is still a git URL. */
export function parseRepoArg(input: string): { url: string; branch?: string } {
  const at = input.lastIndexOf("@");
  if (at <= 0) return { url: input };
  const branch = input.slice(at + 1);
  const url = input.slice(0, at);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return { url: input };
  const scp = !url.includes("://") && url.includes(":") && url.slice(url.indexOf(":") + 1).includes("/");
  if (!url.includes("://") && !scp) return { url: input };
  return { url, branch };
}

export function parseGoldenArgv(argv: readonly string[]): Invocation {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (command === "list") {
    if (rest.length > 0) throw new UsageError("golden list takes no arguments");
    return { kind: "list" };
  }
  if (command === "connect" || command === "snapshot") {
    return { kind: command, name: singleName(rest, command) };
  }
  if (command !== "create") throw new UsageError(`unknown golden command '${command}'. Run 'armada golden --help'.`);
  return parseCreate(rest);
}

function singleName(argv: readonly string[], command: string): string {
  const name = argv[0];
  if (argv.length !== 1 || name === undefined || name.startsWith("-")) {
    throw new UsageError(`golden ${command} needs a name`);
  }
  return name;
}

function take(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new UsageError(`${flag} needs a value`);
  return value;
}

function parseCreate(argv: readonly string[]): Invocation {
  let name: string | undefined;
  let visibility: Visibility = "org";
  let configPath: string | undefined;
  const repoArgs: string[] = [];
  const init: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--private") {
      visibility = "private";
      continue;
    }
    if (token === "--config") {
      configPath = take(argv, index, "--config");
      index += 1;
      continue;
    }
    if (token === "--repo") {
      repoArgs.push(take(argv, index, "--repo"));
      index += 1;
      continue;
    }
    if (token === "--init") {
      init.push(take(argv, index, "--init"));
      index += 1;
      continue;
    }
    if (token.startsWith("-")) throw new UsageError(`unknown flag '${token}'`);
    if (name !== undefined) throw new UsageError("golden create takes one name");
    name = token;
  }
  if (name === undefined) throw new UsageError("golden create needs a name");
  if (configPath !== undefined && (repoArgs.length > 0 || init.length > 0)) {
    throw new UsageError("pass either --config or --repo and --init");
  }
  if (configPath === undefined && repoArgs.length === 0) throw new UsageError("golden create needs --config or --repo");
  const create: Invocation = { kind: "create", name, visibility, repoArgs, init };
  if (configPath !== undefined) create.configPath = configPath;
  return create;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new GoldenError("invalid_config", `set ${name}`);
  return value;
}

function callerFrom(env: Record<string, string | undefined>): Caller {
  const orgId = env.ARMADA_ORG_ID;
  const userId = env.ARMADA_USER_ID;
  const role = env.ARMADA_ROLE;
  if (!orgId || !userId || (role !== "admin" && role !== "member")) {
    throw new GoldenError("invalid_config", "set ARMADA_ORG_ID, ARMADA_USER_ID and ARMADA_ROLE (admin or member)");
  }
  return { orgId, userId, role };
}

function context(deps: RunDeps): { caller: Caller; golden: GoldenDeps; readText: (path: string) => Promise<string> } {
  const env = deps.env ?? process.env;
  const caller = callerFrom(env);
  const store = deps.store ?? goldenStoreFromDatabaseUrl(required(env.ARMADA_DATABASE_URL, "ARMADA_DATABASE_URL"));
  const provider = deps.provider ?? createBoatProvider({ apiKey: required(env.BOAT_API_KEY, "BOAT_API_KEY") });
  return {
    caller,
    golden: { store, provider, sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))) },
    readText: deps.readText ?? ((path) => Bun.file(path).text()),
  };
}

/**
 * The real process wires boat and Postgres. Tests pass `store` and `provider`.
 * `BOAT_API_KEY` only calls the API; it is never sent into the sandbox.
 */
export async function runGolden(argv: readonly string[], io: Io, deps: RunDeps): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseGoldenArgv(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`armada: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (invocation.kind === "help") {
    io.out(GOLDEN_HELP);
    return 0;
  }
  try {
    const ctx = context(deps);
    switch (invocation.kind) {
      case "list": {
        const rows = await listGoldens(ctx.caller, ctx.golden);
        io.out(rows.length === 0 ? "no goldens\n" : rows.map(formatList).join(""));
        return 0;
      }
      case "connect": {
        const connected = await connectGolden(ctx.caller, invocation.name, ctx.golden);
        const repos = connected.repos
          .map((repo) => `repo ${repo.directory} ${repo.branch ?? "default"} ${repo.path}\n`)
          .join("");
        io.out(
          `golden ${connected.golden.name} ${connected.golden.visibility}\nsandbox ${connected.sandboxId}\nstate ${connected.state}\nworkspace ${connected.workspace}\n${repos}shell boat ssh ${connected.sandboxId}\n`,
        );
        return 0;
      }
      case "snapshot": {
        const snapped = await snapshotGolden(ctx.caller, invocation.name, ctx.golden);
        io.out(`snapshotted ${snapped.golden.name}\nboat-snapshot ${snapped.snapshotName}\nstatus ${snapped.status}\n`);
        return 0;
      }
      case "create": {
        const raw = invocation.configPath
          ? JSON.parse(await readConfig(ctx.readText, invocation.configPath))
          : { repos: invocation.repoArgs.map(parseRepoArg), init: invocation.init };
        const config = parseGoldenConfig(raw);
        const created = await createGolden(
          { caller: ctx.caller, name: invocation.name, visibility: invocation.visibility, config },
          ctx.golden,
        );
        io.out(
          `created ${created.golden.name} ${created.golden.visibility}\nsandbox ${created.sandboxId}\nsnapshot-name ${boatSnapshotName(created.golden)}\n`,
        );
        return 0;
      }
      default:
        return 2;
    }
  } catch (error) {
    if (error instanceof GoldenError || error instanceof ProviderError) {
      io.err(`armada: ${error.message}\n`);
      return 1;
    }
    if (error instanceof SyntaxError) {
      io.err("armada: config file is not JSON\n");
      return 1;
    }
    throw error;
  }
}

async function readConfig(readText: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await readText(path);
  } catch {
    throw new GoldenError("invalid_config", `config file could not be read: ${path}`);
  }
}

function formatList(row: {
  name: string;
  visibility: Visibility;
  boatSnapshotId: string | null;
  ownerId: string;
}): string {
  return `${row.name} ${row.visibility} ${row.boatSnapshotId ? "saved" : "unsaved"} ${row.ownerId}\n`;
}
