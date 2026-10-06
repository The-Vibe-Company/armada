// `armada secrets` and `armada run` (THE-859): the secrets a project's workers
// need to build and test (an LLM provider key, a test database URL), kept in
// Armada, never in a worker's environment at launch. A worker fetches them
// with its worker session, for its own project only; the coordinator sets
// them with its own sign-in. In the order the worker skill recommends:
// `run` hands them to one command's environment, `secrets export` writes a
// 0600 dotenv file git ignores, and `secrets get` prints one value, with a
// warning, for a person. A value is never taken from the command line, and
// nothing here prints one except `get`. Every fetch is a release Armada records.
import { dirname, relative, resolve } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  formatDotenvValue,
  type ListedSecret,
  projectOf,
  type SecretScope,
  secretNameRefusal,
  writePrivateFile,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { type Io, UsageError } from "./io.ts";
import { commandRedactor, credentialSecrets } from "./redact.ts";

export interface SecretsArgs {
  /** Positional arguments after the command: the subcommand, then its name. */
  rest: string[];
  options: Record<string, string>;
  json: boolean;
  /** What follows `--`: the command `armada run` runs. */
  passthrough: string[] | null;
}

const NAME_HINT = "upper snake case, e.g. OPENAI_API_KEY";
const hhmm = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** The sign-in secrets go through: the worker session of this ticket, else the terminal's. */
function signInOf(config: ArmadaConfig, credentials: Credentials) {
  const signIn = credentials.armadaSignIn;
  if (!signIn)
    throw new UsageError(
      "not signed in to Armada: a project's secrets are kept there",
      "armada login (a worker: the `armada login --launch-token` line of its launch message)",
    );
  if (signIn.kind === "worker" && signIn.project !== config.project.slug)
    throw new UsageError(
      `the worker session of ${signIn.ticket} is for the project ${signIn.project}, not ${config.project.slug} (armada.toml): this repository is not its own`,
      `cd into the repository of ${signIn.project}`,
    );
  return signIn;
}

/** `--only A,B`: the names asked for; null for every one. */
function onlyOf(v: string | undefined): string[] | null {
  if (v === undefined) return null;
  const names = v
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) throw new UsageError(`--only takes secret names separated by commas, ${NAME_HINT}`);
  const refusal = names.map(secretNameRefusal).find(Boolean);
  if (refusal) throw new UsageError(`--only: ${refusal}`);
  return [...new Set(names)];
}

/** The one secret name a subcommand takes. Anything else is refused without being quoted: it may be a value. */
function nameOf(rest: string[], sub: string): string {
  const [name, ...extra] = rest;
  if (extra.length)
    throw new UsageError(
      `secrets ${sub} takes one name: a value is never given on the command line, where it would stay in the shell history and in transcripts`,
      sub === "set" ? "armada secrets set <NAME>, then type the value at the hidden prompt" : null,
    );
  if (!name) throw new UsageError(`secrets ${sub} needs a secret name, ${NAME_HINT}`);
  const refusal = secretNameRefusal(name);
  if (refusal) throw new UsageError(refusal);
  return name;
}

/** The value of `secrets set`: from a variable of this environment, standard input or a hidden prompt; null when cancelled. */
async function secretValue(io: Io, name: string, options: Record<string, string>): Promise<string | null> {
  const variable = options["from-env"];
  const stdin = options["value-stdin"] === "true";
  if (variable !== undefined && stdin) throw new UsageError("--from-env and --value-stdin: one or the other");
  if (variable !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new UsageError("--from-env takes a variable name");
    const value = io.env[variable];
    if (!value) throw new UsageError(`${variable} is not set in this environment, so ${name} was not set`);
    return value;
  }
  if (stdin) {
    if (!io.readStdin) throw new UsageError("standard input cannot be read here");
    // One trailing line break is the end of the line, not the value.
    const value = (await io.readStdin()).replace(/\r?\n$/, "");
    if (!value) throw new UsageError(`standard input was empty, so ${name} was not set`);
    return value;
  }
  if (!io.interactive || !io.prompt)
    throw new UsageError(
      `no terminal to ask for the value of ${name}`,
      `--value-stdin to read it from standard input, or --from-env <VAR> to take it from a variable of this environment`,
    );
  const value = await io.prompt(`${name} (hidden): `, { hidden: true });
  if (value === null) return null;
  if (!value) throw new UsageError(`no value given, so ${name} was not set`);
  return value;
}

function renderList(config: ArmadaConfig, secrets: ListedSecret[]): string {
  const p = config.project.slug;
  if (!secrets.length)
    return `No secret for workers is set for ${p}.\nNext: armada secrets set <NAME> (an owner or admin), or the Keys page of Armada\n`;
  const width = Math.max(...secrets.map((s) => s.name.length));
  const lines = [`Secrets for workers of ${p} (names only; values stay in Armada)`];
  for (const s of secrets)
    lines.push(
      `  ${s.name.padEnd(width)}  ${s.scope.padEnd(12)}  set by ${s.setBy}, ${hhmm(s.setAt)}${s.overridden ? " (the project's own wins)" : ""}`,
    );
  return `${lines.join("\n")}\n`;
}

/** Whether git tracks `path`, or does not ignore it: either way an export there would end up in a commit. */
async function exportRefusal(io: Io, path: string): Promise<string | null> {
  if (!io.exec) return "git cannot be run here to check that the file is ignored";
  const cwd = dirname(path);
  const tracked = await io.exec("git", ["ls-files", "--error-unmatch", "--", path], { cwd }).catch(() => null);
  if (tracked?.code === 0) return `git tracks ${path}: secrets written there would be committed`;
  const ignored = await io.exec("git", ["check-ignore", "-q", "--", path], { cwd }).catch(() => null);
  if (ignored?.code === 0) return null;
  if (ignored?.code === 1) return `git does not ignore ${path}: secrets written there could be committed`;
  return `git cannot tell whether ${path} is ignored (is it in a git repository?)`;
}

/** `armada secrets [list|set|unset|get|export]`. */
export async function secretsCommand(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: SecretsArgs,
): Promise<number> {
  const [sub = "list", ...rest] = args.rest;
  const signIn = signInOf(config, credentials);
  const api = apiOf(io, credentials.armadaApi.url);
  const project = projectOf(config);
  const p = config.project.slug;
  const allowed: Record<string, string[]> = {
    list: [],
    set: ["org", "value-stdin", "from-env"],
    unset: ["org"],
    get: [],
    export: ["file", "only"],
  };
  const options = allowed[sub];
  if (!options) throw new UsageError(`unknown secrets command "${sub}": list, set, unset, get or export`);
  for (const name of Object.keys(args.options))
    if (name !== "ticket" && !options.includes(name))
      throw new UsageError(`--${name} does not apply to secrets ${sub}`);
  if (args.json && sub !== "list") throw new UsageError(`--json does not apply to secrets ${sub}`);
  const scope: SecretScope = args.options.org === "true" ? "organization" : "project";
  const where = scope === "project" ? `the project ${p}` : "every project of the organization";

  if (sub === "list") {
    if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
    const secrets = await api.listSecrets(signIn, project);
    io.stdout(
      args.json
        ? `${JSON.stringify({ schemaVersion: 1, project: p, secrets }, null, 2)}\n`
        : renderList(config, secrets),
    );
    return 0;
  }
  if (sub === "set") {
    const name = nameOf(rest, "set");
    const value = await secretValue(io, name, args.options);
    if (value === null) {
      io.stderr(`Cancelled. ${name} was not set.\n`);
      return 130;
    }
    await api.setSecret(signIn, { project, name, value, scope });
    io.stdout(`Set ${name} for ${where}. Workers get it on their next command.\n`);
    return 0;
  }
  if (sub === "unset") {
    const name = nameOf(rest, "unset");
    const deleted = await api.unsetSecret(signIn, { project, name, scope });
    io.stdout(deleted ? `Unset ${name} for ${where}.\n` : `${name} was not set for ${where}: nothing changed.\n`);
    return 0;
  }
  if (sub === "get") {
    const name = nameOf(rest, "get");
    const release = await api.releaseSecrets(signIn, project, [name]);
    for (const w of release.warnings) io.stderr(`! Armada: ${w}\n`);
    const found = release.secrets.find((s) => s.name === name);
    if (!found) throw new UsageError(`${name} is not set for ${p}`, "armada secrets, which lists the names set");
    io.stderr(
      `! The value of ${name} is now visible in this terminal, and in any transcript that reads this output. An agent never runs this: it uses \`armada run -- <command>\` or \`armada secrets export --file <path>\`.\n`,
    );
    io.stdout(`${found.value}\n`);
    return 0;
  }
  // export
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
  const file = args.options.file;
  if (!file) throw new UsageError("secrets export needs --file <path>, a file git ignores (e.g. .env.local)");
  const path = resolve(io.cwd, file);
  const refusal = await exportRefusal(io, path);
  if (refusal) throw new UsageError(refusal, "a path git ignores, e.g. .env.local listed in .gitignore");
  const release = await api.releaseSecrets(signIn, project, onlyOf(args.options.only));
  for (const w of release.warnings) io.stderr(`! Armada: ${w}\n`);
  if (release.missing.length) io.stderr(`! Not set for ${p}: ${release.missing.join(", ")}\n`);
  // A dotenv line holds no line break: such a value (a PEM key) goes through `armada run` only.
  const written = release.secrets.filter((s) => !/[\r\n\0]/.test(s.value));
  const skipped = release.secrets.filter((s) => !written.includes(s));
  if (skipped.length)
    io.stderr(
      `! Not written: ${skipped.map((s) => s.name).join(", ")}, whose value spans several lines; \`armada run -- <command>\` hands ${skipped.length === 1 ? "it" : "them"} over\n`,
    );
  const lines = [
    `# The secrets for workers of ${p}, written by \`armada secrets export\`. Never commit this file.`,
    ...written.map((s) => `${s.name}=${formatDotenvValue(s.name, s.value)}`),
  ];
  await writePrivateFile(path, `${lines.join("\n")}\n`);
  const names = written.map((s) => s.name);
  io.stdout(
    `Wrote ${names.length} secret${names.length === 1 ? "" : "s"} of ${p} to ${relative(io.cwd, path) || path} (mode 0600)${names.length ? `: ${names.join(", ")}` : ""}.\n`,
  );
  return 0;
}

/** `armada run [--only A,B] -- <command> [args...]`: one command with the project's secrets in its environment. */
export async function runCommand(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: SecretsArgs,
): Promise<number> {
  if (args.rest.length) throw new UsageError(`unexpected argument ${args.rest[0]}: the command goes after --`);
  const [command, ...commandArgs] = args.passthrough ?? [];
  if (!command) throw new UsageError("run needs a command after --, e.g. armada run -- bun test");
  if (!io.spawn) throw new UsageError("this terminal cannot run a command");
  const signIn = signInOf(config, credentials);
  const release = await apiOf(io, credentials.armadaApi.url).releaseSecrets(
    signIn,
    projectOf(config),
    onlyOf(args.options.only),
  );
  for (const w of release.warnings) io.stderr(`! Armada: ${w}\n`);
  if (release.missing.length) io.stderr(`! Not set for ${config.project.slug}: ${release.missing.join(", ")}\n`);
  const values = Object.fromEntries(release.secrets.map((s) => [s.name, s.value]));
  // Armada's value wins over a variable of the same name: the names are said, never a value.
  const overridden = release.secrets.map((s) => s.name).filter((n) => io.env[n] !== undefined);
  if (overridden.length)
    io.stderr(
      `! armada run: the project's ${overridden.join(", ")} override${overridden.length === 1 ? "s" : ""} the variable${overridden.length === 1 ? "" : "s"} of the same name in this environment\n`,
    );
  const env = { ...io.env, ...values };
  if (io.stdoutIsTTY && args.options.redact !== "true") {
    io.stderr("armada: warning: interactive output is not masked; use --redact to force masked pipes\n");
    return io.spawn(command, commandArgs, { cwd: io.cwd, env });
  }
  const redact = commandRedactor(io, [...release.secrets, ...credentialSecrets(credentials)]);
  const stdout = redact.stream();
  const stderr = redact.stream();
  try {
    return await io.spawn(command, commandArgs, {
      cwd: io.cwd,
      env,
      output: {
        stdout: (chunk) => io.stdout(stdout.write(chunk)),
        stderr: (chunk) => io.stderr(stderr.write(chunk)),
      },
    });
  } finally {
    io.stdout(stdout.end());
    io.stderr(stderr.end());
  }
}
