import { homedir } from "node:os";
import { join } from "node:path";
import { AuthError } from "@armada/auth";
import { filePreferences } from "./preferences.ts";
import { fileSessionStore } from "./session.ts";

export function profileDirectory(env: NodeJS.ProcessEnv): string {
  const root = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "armada");
  const name = env.ARMADA_PROFILE;
  if (name === undefined) return root;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new AuthError(
      "Profile names must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.",
      "usage",
    );
  return join(root, "profiles", name);
}

export function profileStores(env: NodeJS.ProcessEnv) {
  const dir = profileDirectory(env);
  return {
    session: fileSessionStore(join(dir, "session.json")),
    preferences: filePreferences(join(dir, "preferences.json")),
    emailPreferences: filePreferences(join(dir, "login-email.json")),
    launchPreferences: filePreferences(join(dir, "launch-preferences.json")),
  };
}

/** Global options stop at -- so prompt/command payloads are never rewritten. */
export function selectProfile(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const args: string[] = [];
  let selected: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      args.push(...argv.slice(i));
      break;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (selected !== undefined) throw new AuthError("Pass --profile only once.", "usage");
      selected = arg === "--profile" ? argv[++i] : arg.slice("--profile=".length);
      if (!selected || selected.startsWith("-")) throw new AuthError("Pass --profile NAME.", "usage");
    } else args.push(arg);
  }
  const effective: NodeJS.ProcessEnv = { ...env, ...(selected === undefined ? {} : { ARMADA_PROFILE: selected }) };
  profileDirectory(effective); // Validate before any filesystem or network access.
  return { args, env: effective };
}
