// `armada doctor`: what this repository lacks to be run by Armada, each
// problem with its fix. Exit 1 when anything is an error.
import {
  type Check,
  CONFIG_FILE,
  ConfigError,
  checkLabels,
  checkRepository,
  LINEAR_KEY,
  parseConfig,
  readLabels,
} from "@armada/core";
import { loadCredentials } from "./auth.ts";
import type { Io } from "./io.ts";
import { fsRepoView, gitRoot } from "./repo.ts";

export interface DoctorReport {
  schemaVersion: 1;
  root: string;
  armadaVersion: string;
  checks: Check[];
  errors: number;
  warnings: number;
}

async function labelChecks(io: Io, root: string): Promise<Check[]> {
  const text = await fsRepoView(root).readFile(CONFIG_FILE);
  if (text === null) return [];
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(text, CONFIG_FILE);
  } catch (err) {
    if (err instanceof ConfigError) return []; // already reported by the config check
    throw err;
  }
  const { linearApiKey } = (await loadCredentials(io)).credentials;
  if (!linearApiKey)
    return [
      {
        id: "labels",
        level: "warning",
        message: `Linear labels not checked: ${LINEAR_KEY.variable} is not set`,
        fix: `set ${LINEAR_KEY.variable} or run \`armada auth login\`, then run doctor again`,
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
  const checks = [...(await checkRepository(fsRepoView(root), armadaVersion)), ...(await labelChecks(io, root))];
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
