// `armada doctor`: what this repository lacks to be run by Armada, each
// problem with its fix, and whether this terminal is signed in to Armada, so
// that the briefs it makes give workers a launch token instead of keys. Exit 1
// when anything is an error.
import {
  API_KEY_VARIABLE,
  ArmadaApiError,
  armadaApi,
  type Check,
  CONFIG_FILE,
  ConfigError,
  type Credentials,
  checkLabels,
  checkRepository,
  LINEAR_KEY,
  parseConfig,
  RETIRED_VARIABLES,
  readLabels,
  STORED_KEYS,
} from "@armada/core";
import { loadCredentials, type Machine } from "./auth.ts";
import type { Io } from "./io.ts";
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
async function signInChecks(io: Io, credentials: Credentials): Promise<Check[]> {
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
    const identity = await armadaApi({
      url: credentials.armadaApi.url,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    }).whoami(signIn);
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

async function labelChecks(io: Io, root: string, credentials: Credentials): Promise<Check[]> {
  const text = await fsRepoView(root).readFile(CONFIG_FILE);
  if (text === null) return [];
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(text, CONFIG_FILE);
  } catch (err) {
    if (err instanceof ConfigError) return []; // already reported by the config check
    throw err;
  }
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
    const state = await readLabels(config, { apiKey: linearApiKey, ...(io.fetch ? { fetch: io.fetch } : {}) });
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

export async function buildDoctor(io: Io, armadaVersion: string): Promise<DoctorReport> {
  const root = (io.exec ? await gitRoot(io.exec, io.cwd) : null) ?? io.cwd;
  const { machine, credentials } = await loadCredentials(io);
  const checks = [
    ...(await checkRepository(fsRepoView(root), armadaVersion)),
    ...(await signInChecks(io, credentials)),
    ...keyFileChecks(machine, credentials),
    ...(await labelChecks(io, root, credentials)),
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
  return `${lines.join("\n")}\n`;
}

export async function doctor(io: Io, json: boolean, armadaVersion: string): Promise<number> {
  const report = await buildDoctor(io, armadaVersion);
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report));
  return report.errors ? 1 : 0;
}
