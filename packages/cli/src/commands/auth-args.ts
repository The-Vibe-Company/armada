import { AuthError } from "@armada/auth";

interface AuthArgs {
  position: string[];
  flags: Map<string, string>;
}

export function parseAuth(argv: readonly string[]) {
  const position: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      position.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      position.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw new AuthError(`Unknown flag ${arg}.`, "usage");
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "json") {
      if (eq !== -1) throw new AuthError("--json takes no value.", "usage");
      flags.set("json", "true");
      continue;
    }
    if (name.length === 0) throw new AuthError("Unknown flag.", "usage");
    const value = eq === -1 ? argv[index + 1] : arg.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith("--")) throw new AuthError(`Missing value for --${name}.`, "usage");
      index += 1;
    }
    if (value === undefined) throw new AuthError(`Missing value for --${name}.`, "usage");
    flags.set(name, value);
  }
  return { position, flags } satisfies AuthArgs;
}

export function authFlag(flags: Map<string, string>, name: string) {
  const value = flags.get(name);
  if (value === undefined) throw new AuthError(`Missing value for --${name}.`, "usage");
  return value;
}

export function rejectUnknown(flags: Map<string, string>, allowed: readonly string[]) {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new AuthError(`Unknown flag --${name}.`, "usage");
  }
}
