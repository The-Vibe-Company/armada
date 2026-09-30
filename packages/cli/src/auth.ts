// `armada auth login|status|logout`: Armada's keys on this machine. No value
// is ever printed; output names keys, sources and file paths only.
import {
  type CredentialSource,
  type CredentialStore,
  type Credentials,
  ensurePersonalConfig,
  type MachinePaths,
  machinePaths,
  missingKeys,
  type PersonalConfig,
  readCredentialStore,
  readPersonalConfig,
  resolveCredentials,
  STORED_KEYS,
  storeIsExposed,
  updateCredentialStore,
} from "@armada/core";
import { type Io, UsageError } from "./io.ts";

export interface Machine {
  /** Null when neither HOME nor XDG_CONFIG_HOME is set. */
  paths: MachinePaths | null;
  store: CredentialStore | null;
  personal: { exists: boolean; config: PersonalConfig } | null;
}

export async function loadMachine(io: Io): Promise<Machine> {
  const paths = machinePaths(io.env);
  if (!paths) return { paths, store: null, personal: null };
  const [store, personal] = await Promise.all([
    readCredentialStore(paths.credentials),
    readPersonalConfig(paths.config),
  ]);
  return { paths, store, personal };
}

/** Resolves every key from the environment, the machine store and the GitHub CLI. */
export async function loadCredentials(io: Io): Promise<{ machine: Machine; credentials: Credentials }> {
  const machine = await loadMachine(io);
  const credentials = resolveCredentials({
    env: io.env,
    ghToken: io.ghToken,
    ...(machine.store ? { store: machine.store.values } : {}),
    ...(machine.personal ? { personal: machine.personal.config } : {}),
  });
  return { machine, credentials };
}

const describeSource = (s: CredentialSource): string => {
  switch (s.kind) {
    case "env":
      return `environment (${s.variable})`;
    case "store":
      return "credentials file";
    case "config":
      return `personal config (${s.key})`;
    case "gh":
      return "GitHub CLI login (gh auth token)";
  }
};

const octal = (mode: number) => `0${mode.toString(8).padStart(3, "0")}`;

function requirePaths(paths: MachinePaths | null): MachinePaths {
  if (paths) return paths;
  throw new UsageError(
    `neither HOME nor XDG_CONFIG_HOME is set, so there is no place to store keys on this machine. Set ${STORED_KEYS.map((k) => k.variable).join(", ")} in the environment instead.`,
  );
}

function storeWarnings(machine: Machine): string[] {
  const store = machine.store;
  if (!store?.exists) return [];
  const warnings: string[] = [];
  if (storeIsExposed(store) && store.mode !== null)
    warnings.push(`${store.path} can be read by other users (mode ${octal(store.mode)}); run: chmod 600 ${store.path}`);
  for (const line of store.invalidLines)
    warnings.push(`${store.path} line ${line} is not KEY=value; it is kept but ignored`);
  return warnings;
}

/**
 * Asks for every missing key, hidden when secret, and saves the answers in the
 * credentials file. Asks nothing when every key is already set, and refuses to
 * prompt without a terminal. `armada init` runs this first.
 */
export async function authLogin(io: Io): Promise<number> {
  const { machine, credentials } = await loadCredentials(io);
  const missing = missingKeys(credentials);
  if (!missing.length) {
    io.stdout("Every Armada key is already set. Run `armada auth status` to see where each comes from.\n");
    return 0;
  }
  const paths = requirePaths(machine.paths);
  if (!io.interactive || !io.prompt) {
    const width = Math.max(...missing.map((k) => k.variable.length));
    io.stderr(
      `armada: auth login needs an interactive terminal. Set these environment variables instead:\n${missing
        .map((k) => `  ${k.variable.padEnd(width)}  ${k.label}: ${k.hint}`)
        .join("\n")}\nor add them as KEY=value lines to ${paths.credentials} (mode 0600).\n`,
    );
    return 2;
  }

  io.stderr(
    `Armada keeps its keys in ${paths.credentials}, readable only by you.\nLeave an answer empty to skip it.\n`,
  );
  const updates: Record<string, string> = {};
  for (const key of missing) {
    io.stderr(`\n${key.label}: ${key.hint}\n`);
    const answer = await io.prompt(`${key.variable}${key.secret ? " (hidden)" : ""}: `, { hidden: key.secret });
    if (answer === null) {
      io.stderr("Cancelled. Nothing was saved.\n");
      return 130;
    }
    const value = answer.trim();
    if (value) updates[key.variable] = value;
  }

  const saved = Object.keys(updates);
  if (saved.length) {
    await updateCredentialStore(paths, updates);
    io.stdout(`\nSaved ${saved.join(", ")} in ${paths.credentials}.\n`);
    if (await ensurePersonalConfig(paths)) io.stdout(`Created ${paths.config} for your personal defaults.\n`);
  } else io.stdout("\nNothing saved.\n");
  const skipped = missing.filter((k) => !saved.includes(k.variable)).map((k) => k.variable);
  if (skipped.length) io.stdout(`Still missing: ${skipped.join(", ")}. Run \`armada auth login\` again to add them.\n`);
  return 0;
}

export interface AuthStatus {
  schemaVersion: 1;
  keys: { variable: string; label: string; present: boolean; source: CredentialSource | null }[];
  credentialsFile: { path: string; exists: boolean; mode: string | null } | null;
  personalConfig: { path: string; exists: boolean } | null;
  /** The sign-in to Armada, without its token: `armada whoami` asks the server who it is. */
  signIn: {
    api: { url: string; source: CredentialSource | { kind: "default" } };
    method: "session" | "api-key" | null;
    source: CredentialSource | null;
  };
  warnings: string[];
}

export function buildAuthStatus(machine: Machine, credentials: Credentials): AuthStatus {
  const keys = [
    ...STORED_KEYS.map((k) => ({ variable: k.variable, label: k.label, source: credentials.sources[k.name] })),
    { variable: "GITHUB_TOKEN", label: "GitHub token", source: credentials.sources.githubToken },
  ].map((k) => ({ ...k, present: k.source !== null }));
  return {
    schemaVersion: 1,
    keys,
    credentialsFile: machine.store
      ? {
          path: machine.store.path,
          exists: machine.store.exists,
          mode: machine.store.mode === null ? null : octal(machine.store.mode),
        }
      : null,
    personalConfig:
      machine.paths && machine.personal ? { path: machine.paths.config, exists: machine.personal.exists } : null,
    signIn: {
      api: credentials.armadaApi,
      method: credentials.armadaSignIn?.kind ?? null,
      source: credentials.armadaSignIn?.source ?? null,
    },
    warnings: storeWarnings(machine),
  };
}

export function renderAuthStatus(status: AuthStatus): string {
  const width = Math.max(...status.keys.map((k) => k.variable.length));
  const lines = ["Armada keys"];
  for (const k of status.keys) {
    const where = k.source
      ? describeSource(k.source)
      : k.variable === "GITHUB_TOKEN"
        ? "set GITHUB_TOKEN or run `gh auth login`"
        : `set ${k.variable} or run \`armada auth login\``;
    lines.push(`  ${k.variable.padEnd(width)}  ${(k.present ? "set" : "missing").padEnd(7)}  ${where}`);
  }
  lines.push("");
  const file = status.credentialsFile;
  lines.push(
    file
      ? `Credentials file  ${file.path}${file.exists ? ` (mode ${file.mode})` : " (not created yet)"}`
      : "Credentials file  none: neither HOME nor XDG_CONFIG_HOME is set",
  );
  if (status.personalConfig)
    lines.push(
      `Personal config   ${status.personalConfig.path}${status.personalConfig.exists ? "" : " (not created yet)"}`,
    );
  for (const w of status.warnings) lines.push(`! ${w}`);
  const { signIn } = status;
  const api = signIn.api.source.kind === "default" ? "built in" : describeSource(signIn.api.source);
  lines.push("", "Armada sign-in", `  API        ${signIn.api.url} (${api})`);
  lines.push(
    signIn.method && signIn.source
      ? `  Signed in  with ${signIn.method === "session" ? "the session of `armada login`" : "an organization API key"}, from the ${describeSource(signIn.source)}; \`armada whoami\` shows who`
      : "  Signed in  no: run `armada login`, or set ARMADA_API_KEY on a headless coordinator",
  );
  return `${lines.join("\n")}\n`;
}

export async function authStatus(io: Io, json: boolean): Promise<number> {
  const { machine, credentials } = await loadCredentials(io);
  const status = buildAuthStatus(machine, credentials);
  io.stdout(json ? `${JSON.stringify(status, null, 2)}\n` : renderAuthStatus(status));
  return 0;
}

/** Removes Armada's keys from the credentials file; every other line stays. */
export async function authLogout(io: Io): Promise<number> {
  const paths = requirePaths(machinePaths(io.env));
  // Only the credentials file: a broken config.toml must not block removing keys.
  const store = await readCredentialStore(paths.credentials);
  // Any KEY= line counts, even a malformed one: logout must not leave a secret behind.
  const stored = STORED_KEYS.filter((k) => store.assigned.includes(k.variable));
  if (!stored.length) {
    io.stdout(`No Armada key is stored in ${paths.credentials}.\n`);
  } else {
    await updateCredentialStore(paths, Object.fromEntries(STORED_KEYS.map((k) => [k.variable, null])));
    io.stdout(`Removed ${stored.map((k) => k.variable).join(", ")} from ${paths.credentials}.\n`);
  }
  const fromEnv = STORED_KEYS.filter((k) => io.env[k.variable]?.trim()).map((k) => k.variable);
  if (fromEnv.length)
    io.stdout(`Still set in the environment, and still used: ${fromEnv.join(", ")}. Unset them to stop using them.\n`);
  return 0;
}
