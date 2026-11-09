import { GoldenError } from "@armada/core";

const BOOLEAN = new Set(["--private", "--json", "--all", "--follow", "--no-browser", "--no-connections"]);
const VALUE = new Set([
  "--since",
  "--limit",
  "--idempotency-key",
  "--connections",
  "--visibility",
  "--conversation",
  "--cwd",
  "--prompt-id",
  "--timeout",
  "--repo",
  "--init",
  "--config",
  "--agent",
  "--ttl",
  "--org",
  "--role",
  "--file",
  "--model",
  "--reasoning-effort",
  "--provider",
  "--name",
  "--setup",
]);

export interface Args {
  positionals: string[];
  /** Repeatable options keep every value, in order. Boolean options map to an empty list. */
  options: Map<string, string[]>;
}

export function parseArgs(
  argv: readonly string[],
  additionalValues: readonly string[] = [],
  additionalBooleans: readonly string[] = [],
): Args {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw new GoldenError("invalid_config", `Unknown option '${arg}'.`);
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (BOOLEAN.has(key) || additionalBooleans.includes(key)) {
      if (eq !== -1) throw new GoldenError("invalid_config", `${key} takes no value.`);
      options.set(key, []);
      continue;
    }
    if (!VALUE.has(key) && !additionalValues.includes(key))
      throw new GoldenError("invalid_config", `Unknown option '${key}'.`);
    const value = eq === -1 ? argv[index + 1] : arg.slice(eq + 1);
    if (eq === -1) index += 1;
    if (value === undefined || value.startsWith("--")) {
      throw new GoldenError("invalid_config", `${key} needs a value.`);
    }
    const list = options.get(key) ?? [];
    list.push(value);
    options.set(key, list);
  }
  return { positionals, options };
}

export function flag(args: Args, name: string): boolean {
  return args.options.has(name);
}

export function values(args: Args, name: string): string[] {
  return args.options.get(name) ?? [];
}

export function single(args: Args, name: string): string | undefined {
  const list = values(args, name);
  if (list.length > 1) throw new GoldenError("invalid_config", `${name} can only be set once.`);
  return list[0];
}
