// `armada auth login|status|logout`: Armada's keys on this machine. No value
// is ever printed; output names keys, sources and file paths only. Also where
// every command gets its keys (`loadCredentials`): the environment, then the
// organization's keys from Armada when signed in, then the credentials file.
// A worker command on a ticket this machine holds a worker session for always
// asks Armada, which renews the session, enforces its ticket and refuses a
// revoked worker: that refusal stops the command.
import {
  ArmadaApiError,
  type ArmadaKeys,
  type ArmadaKeysAnswer,
  type CredentialSource,
  type CredentialStore,
  type Credentials,
  ensurePersonalConfig,
  type KeysFallback,
  type KeysPurpose,
  type MachinePaths,
  machinePaths,
  missingKeys,
  type PersonalConfig,
  RETIRED_VARIABLES,
  readCredentialStore,
  readKeysFallback,
  readPersonalConfig,
  resolveCredentials,
  STORED_KEYS,
  storedWorkers,
  storeIsExposed,
  updateCredentialStore,
  writeKeysFallback,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { type Io, UsageError } from "./io.ts";

export interface Machine {
  /** Null when neither HOME nor XDG_CONFIG_HOME is set. */
  paths: MachinePaths | null;
  store: CredentialStore | null;
  personal: { exists: boolean; config: PersonalConfig } | null;
  keysFallback: KeysFallback | null;
}

export async function loadMachine(io: Io): Promise<Machine> {
  const paths = machinePaths(io.env);
  if (!paths) return { paths, store: null, personal: null, keysFallback: null };
  const [store, personal, keysFallback] = await Promise.all([
    readCredentialStore(paths.credentials),
    readPersonalConfig(paths.config),
    readKeysFallback(paths),
  ]);
  return { paths, store, personal, keysFallback };
}

const _hhmm = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Keys Armada could give that the environment does not set: only then is Armada asked. */
const wantsArmada = (env: Io["env"]) => !env.LINEAR_API_KEY?.trim();

const KEYS_RETRY_MS = 5 * 60_000;
const KEYS_WARNING_MS = 60 * 60_000;

async function rememberKeysFallback(machine: Machine, fallback: KeysFallback | null): Promise<void> {
  machine.keysFallback = fallback;
  if (machine.paths) await writeKeysFallback(machine.paths, fallback).catch(() => {});
}

/**
 * The organization's Linear key from Armada, kept in memory only. Armada
 * unreachable or refusing: fall back only when this machine has a usable
 * Linear key; otherwise preserve the credential-fetch error. Armada keeping
 * no keys (503) is not worth a warning: the terminal then works as before.
 * A worker cut off, ended, or out of its
 * ticket stops here, whatever keys the machine has, and so does a CLI older
 * than Armada expects, with the one line that upgrades it.
 */
async function fromArmada(
  io: Io,
  machine: Machine,
  credentials: Credentials,
  purpose: KeysPurpose | null,
): Promise<ArmadaKeys | null> {
  const signIn = credentials.armadaSignIn;
  if (!signIn) return null;
  const canRemember = signIn.kind !== "worker" && !!credentials.linearApiKey && machine.paths !== null;
  const now = (io.now?.() ?? new Date()).getTime();
  const previous = machine.keysFallback;
  const age = previous ? now - Date.parse(previous.failedAt) : null;
  if (canRemember && age !== null && age >= 0 && age < KEYS_RETRY_MS) return null;
  let answer: ArmadaKeysAnswer;
  try {
    answer = await apiOf(io, credentials.armadaApi.url).credentials(signIn, purpose);
  } catch (err) {
    if (!(err instanceof ArmadaApiError)) throw err;
    if ((err.signedOut || err.status === 403) && signIn.kind === "worker") throw err;
    // Older than the server expects: its one upgrade line, rather than a run on a reading it cannot trust.
    if (err.upgrade) throw err;
    if (err.status === 503 && (signIn.kind === "worker" || err.message.includes(": this Armada keeps no keys")))
      return null;
    if (!credentials.linearApiKey) throw err;
    const retryable = err.status === null || err.status === 401 || err.status === 429 || err.status >= 500;
    if (canRemember && retryable) {
      const warningAge = previous ? now - Date.parse(previous.warnedAt) : null;
      const warn = warningAge === null || warningAge < 0 || warningAge >= KEYS_WARNING_MS;
      const at = new Date(now).toISOString();
      const reason = `${err.message}${err.next ? `. Next: ${err.next}` : ""}`;
      await rememberKeysFallback(machine, { reason, failedAt: at, warnedAt: warn ? at : (previous?.warnedAt ?? at) });
      if (warn)
        io.stderr(
          `! Armada gave no keys (${err.message}); using this machine's key. Said once an hour; armada auth status shows the source.${err.next ? ` Next: ${err.next}` : ""}\n`,
        );
      return null;
    }
    if (err.status === 503) return null; // Without a machine store, retain the existing behavior.
    io.stderr(`! Armada gave no keys (${err.message}); using this machine's${err.next ? `. Next: ${err.next}` : ""}\n`);
    return null;
  }
  if (signIn.kind !== "worker") await rememberKeysFallback(machine, null);
  for (const w of answer.warnings) io.stderr(`! Armada: ${w}\n`);
  return {
    linearApiKey: answer.linear
      ? {
          value: answer.linear.apiKey,
          detail:
            answer.linear.scope === "own"
              ? "your own key"
              : answer.linear.scope === "project" && purpose
                ? `the key of the project ${purpose.project}`
                : `the key of ${answer.organization.name}`,
        }
      : null,
  };
}

/**
 * A worker command (claim, report, ask, release): which ticket it acts on,
 * given the tickets this machine holds worker sessions for; null when it
 * cannot tell (the command then says so itself).
 */
export interface WorkerScope {
  command: string;
  /** The project of armada.toml: a worker session of another project is refused. */
  project: string;
  ticket: (stored: string[]) => string | null;
}

/**
 * Resolves every key from the environment, Armada (when signed in, and only
 * for the keys the environment does not set), the machine store and the
 * GitHub CLI. Commands that need no key (login, whoami, logout) pass
 * `armada: false`. A worker command passes its `worker` scope: the worker
 * session of its ticket, when the machine holds one, signs it in. A command
 * run in a project passes its `project`: that project's own Linear key wins.
 */
export async function loadCredentials(
  io: Io,
  { armada = true, worker, project }: { armada?: boolean; worker?: WorkerScope; project?: string } = {},
): Promise<{ machine: Machine; credentials: Credentials }> {
  const machine = await loadMachine(io);
  let ticket: string | null = null;
  if (worker)
    try {
      ticket = worker.ticket(storedWorkers(machine.store?.values ?? {}).map((w) => w.ticket));
    } catch {
      ticket = null;
    }
  let gh: string | null | undefined;
  const sources = {
    env: io.env,
    // Asked once, however many times the keys are resolved.
    ghToken: () => {
      if (gh === undefined) gh = io.ghToken();
      return gh;
    },
    ...(machine.store ? { store: machine.store.values } : {}),
    ...(machine.personal ? { personal: machine.personal.config } : {}),
    ticket,
  };
  const local = resolveCredentials(sources);
  const signIn = local.armadaSignIn;
  // The project the command acts on: its own Linear key, when it keeps one, wins (THE-859).
  const scoped = worker?.project ?? project;
  const purpose: KeysPurpose | null =
    worker && ticket
      ? { command: worker.command, project: worker.project, ticket }
      : scoped
        ? { project: scoped }
        : null;
  if (signIn?.kind === "worker" && armada) {
    if (signIn.project !== worker?.project)
      throw new UsageError(
        `the worker session of ${signIn.ticket} is for the project ${signIn.project}, not ${worker?.project} (armada.toml): this repository is not its own`,
        `cd into the repository of ${signIn.project}`,
      );
    // Always asked, even when the environment has every key: the session is renewed, and checked.
    const keys = await fromArmada(io, machine, local, purpose);
    return { machine, credentials: keys ? resolveCredentials({ ...sources, armada: keys }) : local };
  }
  if (!armada || !signIn || !wantsArmada(io.env)) return { machine, credentials: local };
  const keys = await fromArmada(io, machine, local, purpose);
  return { machine, credentials: keys ? resolveCredentials({ ...sources, armada: keys }) : local };
}

export const describeSource = (s: CredentialSource): string => {
  switch (s.kind) {
    case "env":
      return `environment (${s.variable})`;
    case "store":
      return "credentials file";
    case "armada":
      return `Armada: ${s.detail}`;
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
  armadaKeys: { lastFailure: string | null; lastFailureAt: string | null };
  keys: { variable: string; label: string; present: boolean; source: CredentialSource | null }[];
  credentialsFile: { path: string; exists: boolean; mode: string | null } | null;
  personalConfig: { path: string; exists: boolean } | null;
  /** The sign-in to Armada, without its token: `armada whoami` asks the server who it is. */
  signIn: {
    api: { url: string; source: CredentialSource | { kind: "default" } };
    method: "session" | "api-key" | null;
    source: CredentialSource | null;
    /** The tickets this machine holds a worker session for. */
    workers: string[];
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
    armadaKeys: {
      lastFailure: machine.keysFallback?.reason ?? null,
      lastFailureAt: machine.keysFallback?.failedAt ?? null,
    },
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
      // A worker session signs in only its own ticket's commands, never auth status.
      method: credentials.armadaSignIn?.kind === "worker" ? null : (credentials.armadaSignIn?.kind ?? null),
      source: credentials.armadaSignIn?.kind === "worker" ? null : (credentials.armadaSignIn?.source ?? null),
      workers: credentials.workerTickets,
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
  if (status.armadaKeys.lastFailure)
    lines.push(`Last keys failure  ${status.armadaKeys.lastFailureAt}: ${status.armadaKeys.lastFailure}`);
  for (const w of status.warnings) lines.push(`! ${w}`);
  const { signIn } = status;
  const api = signIn.api.source.kind === "default" ? "built in" : describeSource(signIn.api.source);
  lines.push("", "Armada sign-in", `  API        ${signIn.api.url} (${api})`);
  lines.push(
    signIn.method && signIn.source
      ? `  Signed in  with ${signIn.method === "session" ? "the session of `armada login`" : "an organization API key"}, from the ${describeSource(signIn.source)}; \`armada whoami\` shows who`
      : "  Signed in  no: run `armada login`, or set ARMADA_API_KEY on a headless coordinator",
  );
  if (signIn.workers.length)
    lines.push(
      `  Workers    ${signIn.workers.join(", ")}: the worker session of \`armada login --launch-token\` signs in that ticket's claim, report, ask and release`,
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
  const variables = [...STORED_KEYS.map((k) => k.variable), ...RETIRED_VARIABLES];
  const stored = variables.filter((v) => store.assigned.includes(v));
  if (!stored.length) {
    io.stdout(`No Armada key is stored in ${paths.credentials}.\n`);
  } else {
    await updateCredentialStore(paths, Object.fromEntries(variables.map((v) => [v, null])));
    io.stdout(`Removed ${stored.join(", ")} from ${paths.credentials}.\n`);
  }
  const fromEnv = STORED_KEYS.filter((k) => io.env[k.variable]?.trim()).map((k) => k.variable);
  if (fromEnv.length)
    io.stdout(`Still set in the environment, and still used: ${fromEnv.join(", ")}. Unset them to stop using them.\n`);
  return 0;
}
