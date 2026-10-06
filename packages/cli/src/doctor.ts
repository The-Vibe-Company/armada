// `armada doctor`: what this repository lacks to be run by Armada, each
// problem with its fix, whether this terminal is signed in to Armada, so
// that the briefs it makes give workers a launch token instead of keys,
// whether this CLI is as recent as Armada expects, and whether the conductor
// command the runtime guide launches workers with is found, and which
// secrets the project expects (`[secrets] names`) are not set in Armada, by
// name only. Exit 1 when anything is an error.
import { join } from "node:path";
import {
  API_KEY_VARIABLE,
  type ArmadaApi,
  ArmadaApiError,
  type ArmadaConfig,
  BUNDLED_SKILLS,
  type Check,
  CONFIG_FILE,
  ConfigError,
  type Credentials,
  checkLabels,
  checkRepository,
  compareVersions,
  installCommand,
  LINEAR_KEY,
  parseConfig,
  projectOf,
  RETIRED_VARIABLES,
  readLabels,
  STORED_KEYS,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { describeSource, loadCredentials, type Machine } from "./auth.ts";
import type { Io } from "./io.ts";
import { httpOptions } from "./io.ts";
import {
  detectLocalTools,
  dshInformation,
  localHarnesses,
  localModelProfiles,
  offerLocalInstalls,
  offerLocalModels,
} from "./local-tools.ts";
import { describeIdentity, hostOf } from "./login.ts";
import { fsRepoView, gitRoot } from "./repo.ts";

export interface DoctorReport {
  schemaVersion: 1;
  root: string;
  armadaVersion: string;
  checks: Check[];
  errors: number;
  warnings: number;
}

const SIGN_IN_FIX = `\`armada login\`; a headless coordinator sets ${API_KEY_VARIABLE} to an organization API key`;

/**
 * Whether this terminal is signed in to Armada, asked to Armada itself. Not
 * an error: without a sign-in Armada still works on the keys of the
 * environment (CI, self-hosting), but the briefs carry no launch token.
 */
async function signInChecks(credentials: Credentials, api: ArmadaApi): Promise<Check[]> {
  const host = hostOf(credentials.armadaApi.url);
  const signIn = credentials.armadaSignIn;
  const warning = (message: string, fix: string): Check[] => [{ id: "sign-in", level: "warning", message, fix }];
  if (!signIn) {
    const elsewhere = credentials.armadaSignInElsewhere;
    if (elsewhere)
      return warning(
        `this terminal is signed in to ${hostOf(elsewhere)}, not to ${host} (named by ARMADA_API_URL or [api] url)`,
        `\`armada login\` to sign in to ${host}, or point ARMADA_API_URL back to ${elsewhere}`,
      );
    const workers = credentials.workerTickets.length
      ? `\nThe worker session${credentials.workerTickets.length === 1 ? "" : "s"} of ${credentials.workerTickets.join(", ")} sign${credentials.workerTickets.length === 1 ? "s" : ""} in only that ticket's claim, report, ask and release.`
      : "";
    return warning(
      `not signed in to Armada (${host}): \`armada brief\` gives workers no launch token, so each worker needs the fleet's keys in its environment${workers}`,
      SIGN_IN_FIX,
    );
  }
  try {
    const identity = await api.whoami(signIn);
    if (!identity.organization)
      return warning(
        `signed in to ${host} as ${describeIdentity(identity)}: launch tokens need an organization`,
        `create or join an organization on ${credentials.armadaApi.url}`,
      );
    return [
      { id: "sign-in", level: "ok", message: `signed in to ${host} as ${describeIdentity(identity)}`, fix: null },
    ];
  } catch (err) {
    if (!(err instanceof ArmadaApiError)) throw err;
    if (err.upgrade) throw err; // the version check says it
    if (err.signedOut)
      return warning(
        `the Armada sign-in of this terminal no longer works: ${err.message}`,
        signIn.kind === "api-key" && signIn.source.kind === "env"
          ? `replace ${API_KEY_VARIABLE} with a valid organization API key`
          : SIGN_IN_FIX,
      );
    return warning(`Armada sign-in not checked: ${err.message}`, err.next ?? "run doctor again once Armada answers");
  }
}

/** Keys still in the credentials file while Armada gives this terminal the same ones: no longer needed. */
function keyFileChecks(machine: Machine, credentials: Credentials): Check[] {
  const store = machine.store;
  if (!store?.exists) return [];
  const retired = RETIRED_VARIABLES.filter((v) => store.assigned.includes(v));
  const checks: Check[] = retired.length
    ? [
        {
          id: "retired-keys",
          level: "warning",
          message: `${store.path} still holds ${retired.join(", ")}, which this version never reads: the CLI reaches the fleet's data through Armada`,
          fix: `\`armada login\` removes ${retired.length === 1 ? "it" : "them"} as it signs this terminal in; or delete ${retired.length === 1 ? "its line" : "their lines"} from ${store.path}`,
        },
      ]
    : [];
  if (!credentials.armadaSignIn) return checks;
  const unneeded = STORED_KEYS.filter(
    (k) => store.values[k.variable]?.trim() && credentials.sources[k.name]?.kind === "armada",
  ).map((k) => k.variable);
  if (!unneeded.length) return checks;
  return [
    ...checks,
    {
      id: "local-keys",
      level: "warning",
      message: `${store.path} still holds ${unneeded.join(", ")}, which Armada now gives this terminal: ${unneeded.length === 1 ? "it is" : "they are"} no longer needed`,
      fix: `\`armada auth logout\` removes ${unneeded.length === 1 ? "it" : "them"} from this machine; the sign-in to Armada stays`,
    },
  ];
}

/** The repository's armada.toml; null when absent or invalid (the config check reports it). */
async function projectConfig(root: string): Promise<ArmadaConfig | null> {
  const text = await fsRepoView(root).readFile(CONFIG_FILE);
  if (text === null) return null;
  try {
    return parseConfig(text, CONFIG_FILE);
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

async function labelChecks(io: Io, config: ArmadaConfig | null, credentials: Credentials): Promise<Check[]> {
  if (!config) return [];
  const { linearApiKey } = credentials;
  if (!linearApiKey)
    return [
      {
        id: "labels",
        level: "warning",
        message: `Linear labels not checked: no Linear key (${LINEAR_KEY.variable})`,
        fix: `\`armada login\` to an Armada that keeps your organization's keys, or set ${LINEAR_KEY.variable}, then run doctor again`,
      },
    ];
  try {
    const state = await readLabels(config, { apiKey: linearApiKey, ...httpOptions(io) });
    return checkLabels(state);
  } catch (err) {
    return [
      {
        id: "labels",
        level: "warning",
        message: `Linear labels not checked: ${err instanceof Error ? err.message : String(err)}`,
        fix: "run doctor again once Linear answers",
      },
    ];
  }
}

/**
 * Whether this CLI is as recent as the Armada it talks to expects, from what
 * that Armada said on its answers. None when it was not asked (signed out) or
 * says nothing (an older server).
 */
function versionChecks(host: string, api: ArmadaApi, armadaVersion: string, outdated: ArmadaApiError | null): Check[] {
  if (outdated?.upgrade)
    return [
      {
        id: "cli-version",
        level: "error",
        message: `Armada ${armadaVersion} is older than ${host} expects: it no longer reads its answers`,
        fix: installCommand(outdated.upgrade),
      },
    ];
  const server = api.serverCli();
  if (!server) return [];
  const newer = server.latest && compareVersions(server.latest, armadaVersion) > 0 ? server.latest : null;
  return [
    {
      id: "cli-version",
      level: "ok",
      message: `Armada ${armadaVersion} is recent enough for ${host} (${server.minimum} or newer)${newer ? `; ${newer} is out: ${installCommand(newer)}` : ""}`,
      fix: null,
    },
  ];
}

/** Where the Conductor app for macOS ships its command line tool; it is not on PATH by itself. */
export const CONDUCTOR_INSTALL_FIX =
  "on a Mac, install the Conductor app, then run doctor again; elsewhere, put a conductor command on PATH (a Conductor workspace has one)";
export const BUNDLED_CONDUCTOR = "/Applications/Conductor.app/Contents/Resources/bin/conductor";

/**
 * The first line `<command> --version` prints, "" when it prints none or
 * fails (it is there all the same); null when it cannot be run at all.
 */
async function versionOf(io: Io, command: string): Promise<string | null> {
  if (!io.exec) return null;
  try {
    const r = await io.exec(command, ["--version"], { cwd: io.cwd });
    return r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "") : "";
  } catch {
    return null; // not installed there
  }
}

/**
 * Whether the `conductor` command the runtime guide launches workers with is
 * found: on PATH, or only inside the macOS app, where the fix is a link from a
 * directory already on PATH (no sudo), else a PATH line, else a link in
 * /usr/local/bin. Only for a project with a profile that runs on Conductor.
 */
async function conductorChecks(io: Io, config: ArmadaConfig | null): Promise<Check[]> {
  if (!io.exec || !Object.values(config?.conductor.profiles ?? {}).some((p) => p.runtime === "conductor")) return [];
  const onPath = await versionOf(io, "conductor");
  if (onPath !== null)
    return [
      { id: "conductor-cli", level: "ok", message: `conductor ${onPath ? `${onPath} ` : ""}is on PATH`, fix: null },
    ];
  const home = io.env.HOME?.replace(/\/+$/, "");
  const path = (io.env.PATH ?? "").split(":").map((d) => d.replace(/\/+$/, ""));
  const userBin = home ? [".local/bin", "bin"].find((d) => path.includes(`${home}/${d}`)) : undefined;
  const link = (dir: string) => `ln -s "${BUNDLED_CONDUCTOR}" ${dir}/conductor`;
  const pathLine = `export PATH="${BUNDLED_CONDUCTOR.slice(0, -"/conductor".length)}:$PATH"`;
  const fix = userBin
    ? link(`~/${userBin}`)
    : `add \`${pathLine}\` to your shell profile (~/.zshrc), or \`sudo ${link("/usr/local/bin")}\``;
  if ((await versionOf(io, BUNDLED_CONDUCTOR)) !== null)
    return [
      {
        id: "conductor-cli",
        level: "warning",
        message: `conductor is not on PATH; the Conductor app ships it at ${BUNDLED_CONDUCTOR}`,
        fix,
      },
    ];
  return [
    {
      id: "conductor-cli",
      level: "warning",
      message: `conductor is not on PATH, nor at ${BUNDLED_CONDUCTOR}: the armada-runtime-conductor guide launches workers with it`,
      fix: CONDUCTOR_INSTALL_FIX,
    },
  ];
}

/** Read-only review setup checks. The bootstrap comes from the trusted CLI bundle. */
export async function reviewRuntimeChecks(io: Io, root: string): Promise<Check[]> {
  if (!io.exec)
    return [
      {
        id: "review-runtime",
        level: "warning",
        message: "review-code-dev prerequisites could not be checked",
        fix: "run doctor in a terminal with Python 3.9+ and Git 2.41+",
      },
    ];
  const exec = io.exec;
  const checks: Check[] = [];
  let pythonReady = false;
  for (const [command, id, minimum] of [
    ["python3", "review-python", "3.9.0"],
    ["git", "review-git", "2.41.0"],
  ] as const) {
    const result = await exec(command, ["--version"], { cwd: root }).catch(() => null);
    const version =
      result?.code === 0 ? `${result.stdout} ${result.stderr}`.match(/\b(\d+\.\d+(?:\.\d+)?)/)?.[1] : null;
    const ready = !!version && compareVersions(version, minimum) >= 0;
    if (command === "python3") pythonReady = ready;
    checks.push({
      id,
      level: ready ? "ok" : "warning",
      message: ready
        ? `${command} ${version} supports review-code-dev`
        : `review-code-dev needs ${command} ${minimum}+; ${version ? `found ${version}` : "not available"}`,
      fix: ready ? null : `install ${command} ${minimum}+ on this worker before running ship-pr-dev`,
    });
  }
  if (pythonReady) {
    const bootstrap = BUNDLED_SKILLS.find((s) => s.name === "review-code-dev")?.files.find(
      (f) => f.path === "scripts/ocr.py",
    )?.content;
    if (!bootstrap) throw new Error("the bundled review-code-dev bootstrap is missing");
    const result = await exec("python3", ["-c", bootstrap, "check"], { cwd: root }).catch(() => null);
    checks.push({
      id: "review-ocr",
      level: result?.code === 0 ? "ok" : "warning",
      message: result ? (result.stdout || result.stderr).trim() : "review-code-dev OCR cache could not be checked",
      fix:
        result?.code === 0
          ? null
          : "follow review-code-dev setup notes; run `python3 .agents/skills/review-code-dev/scripts/ocr.py version` to bootstrap OCR 1.12.1 (GitHub HTTPS access and writable cache; no extra API key)",
    });
  }
  return checks;
}

/** The secrets the project expects (`[secrets] names` in armada.toml) that Armada does not keep for it. Names only. */
async function secretChecks(api: ArmadaApi, config: ArmadaConfig | null, credentials: Credentials): Promise<Check[]> {
  const expected = config?.secrets.names ?? [];
  if (!config || !expected.length) return [];
  const signIn = credentials.armadaSignIn;
  const list = expected.join(", ");
  const warning = (message: string, fix: string): Check[] => [{ id: "secrets", level: "warning", message, fix }];
  if (!signIn)
    return warning(`the project expects the secrets ${list}; not checked: not signed in to Armada`, SIGN_IN_FIX);
  let set: string[];
  try {
    set = (await api.listSecrets(signIn, projectOf(config))).map((s) => s.name);
  } catch (err) {
    if (!(err instanceof ArmadaApiError)) throw err;
    return warning(
      `the project expects the secrets ${list}; not checked: ${err.message}`,
      err.next ?? "run doctor again once Armada answers",
    );
  }
  const missing = expected.filter((n) => !set.includes(n));
  if (!missing.length)
    return [{ id: "secrets", level: "ok", message: `the secrets the project expects are set: ${list}`, fix: null }];
  return warning(
    `the project expects the secrets ${list}; not set in Armada: ${missing.join(", ")}`,
    "an owner or admin runs `armada secrets set <NAME>` for each (or sets it on the Keys page of Armada)",
  );
}

/** Same diagnostics and offers as launch; cloud-only projects require no local tools. */
export async function localRuntimeChecks(
  io: Io,
  config: Parameters<typeof localHarnesses>[0] | null,
  options: { readOnly?: boolean; configPath?: string } = { readOnly: true },
): Promise<Check[]> {
  const harnesses = config ? localHarnesses(config) : [];
  if (!harnesses.length) return [];
  const result = await offerLocalInstalls(
    io,
    await detectLocalTools(io, harnesses, config ? localModelProfiles(config) : []),
    options,
  );
  const selected = await offerLocalModels(io, result, options.configPath ?? join(io.cwd, CONFIG_FILE), options);
  return [
    ...selected.checks,
    ...(harnesses.some((harness) => harness === "opencode" || harness === "deepseek")
      ? [
          {
            id: "local-opencode-effort",
            level: "warning" as const,
            message:
              "effort is not applied for OpenCode (including DeepSeek); the interactive UI uses its default variant",
            fix: null,
          },
        ]
      : []),
    ...(harnesses.includes("deepseek") ? [await dshInformation(io)] : []),
  ];
}

export async function buildDoctor(
  io: Io,
  armadaVersion: string,
  options: { readOnly?: boolean } = { readOnly: true },
): Promise<DoctorReport> {
  const root = (io.exec ? await gitRoot(io.exec, io.cwd) : null) ?? io.cwd;
  // Older than Armada expects, it gets no keys from it: the checks go on with this machine's.
  const upgrade = (err: unknown) => (err instanceof ArmadaApiError && err.upgrade ? err : null);
  let outdated: ArmadaApiError | null = null;
  let loaded: Awaited<ReturnType<typeof loadCredentials>>;
  const config = await projectConfig(root);
  try {
    // The project's own Linear key, when it keeps one, is the one its labels are checked with.
    loaded = await loadCredentials(io, config ? { project: config.project.slug } : {});
  } catch (err) {
    outdated = upgrade(err);
    if (!outdated) throw err;
    loaded = await loadCredentials(io, { armada: false });
  }
  const { machine, credentials } = loaded;
  const api = apiOf(io, credentials.armadaApi.url, armadaVersion);
  let signIn: Check[] = [];
  try {
    signIn = await signInChecks(credentials, api);
  } catch (err) {
    outdated = upgrade(err);
    if (!outdated) throw err;
  }
  const checks = [
    ...(await checkRepository(fsRepoView(root), armadaVersion)),
    ...signIn,
    ...versionChecks(hostOf(credentials.armadaApi.url), api, armadaVersion, outdated),
    ...keyFileChecks(machine, credentials),
    {
      id: "linear-key",
      level: credentials.sources.linearApiKey ? "ok" : "warning",
      message: `LINEAR_API_KEY: ${credentials.sources.linearApiKey ? describeSource(credentials.sources.linearApiKey) : "missing"}`,
      fix: credentials.sources.linearApiKey ? null : "armada auth login",
    } satisfies Check,
    ...(machine.keysFallback
      ? [
          {
            id: "armada-keys",
            level: "warning" as const,
            message: `Last keys failure at ${machine.keysFallback.failedAt}: ${machine.keysFallback.reason}`,
            fix: "armada auth status",
          },
        ]
      : []),
    ...(await labelChecks(io, config, credentials)),
    ...(await conductorChecks(io, config)),
    ...(config?.conductor.projectId || config?.conductor.baseBranch
      ? [
          {
            id: "conductor-launch",
            level: "ok" as const,
            message: `Conductor launches use ${config.conductor.projectId ? `project ${config.conductor.projectId}` : `repository ${config.github.repository}`} on ${config.conductor.baseBranch ?? "origin’s default branch"}`,
            fix: null,
          },
        ]
      : []),
    ...(await localRuntimeChecks(io, config, { ...options, configPath: join(root, CONFIG_FILE) })),
    ...(config ? await reviewRuntimeChecks(io, root) : []),
    ...(await secretChecks(api, config, credentials)),
  ];
  return {
    schemaVersion: 1,
    root,
    armadaVersion,
    checks,
    errors: checks.filter((c) => c.level === "error").length,
    warnings: checks.filter((c) => c.level === "warning").length,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderDoctor(r: DoctorReport): string {
  const lines = [`Armada ${r.armadaVersion} doctor · ${r.root}`, ""];
  for (const c of r.checks) {
    const [first, ...more] = c.message.split("\n");
    lines.push(`  ${c.level.padEnd(8)} ${first}`);
    for (const m of more) lines.push(`           ${m}`);
    if (c.fix) lines.push(`           fix: ${c.fix}`);
  }
  lines.push("");
  if (!r.errors && !r.warnings) lines.push("Everything Armada needs is in place.");
  else
    lines.push(
      `${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}.${r.errors ? " Workers cannot be launched until the errors are fixed." : ""}`,
    );
  const errors = r.checks.filter((c) => c.level === "error");
  if (errors.length)
    lines.push(
      errors.some((c) => c.fix?.includes("armada init"))
        ? "Next: armada init, which opens one pull request with the fixes it can make"
        : `Next: ${errors[0]?.fix}`,
    );
  if (r.checks.some((c) => c.id === "local-herdr"))
    lines.push(
      "Local first-run setup: armada setup local — the owner answers trust, updates, project MCP, sign-in and model questions in herdr; new worktrees may still ask once.",
    );
  return `${lines.join("\n")}\n`;
}

export async function doctor(io: Io, json: boolean, armadaVersion: string): Promise<number> {
  const report = await buildDoctor(io, armadaVersion, { readOnly: json });
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report));
  return report.errors ? 1 : 0;
}
