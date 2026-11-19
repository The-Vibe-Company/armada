import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import config from "../../.oxlintrc.json";
import baseline from "./landmines-baseline.json";

type Counts = Record<string, Record<string, number>>;
type LintConfig = {
  rules?: Record<string, unknown>;
  overrides?: { files: string[]; rules?: Record<string, unknown> }[];
};

type Diagnostic = {
  code?: string;
  filename?: string;
  message: string;
  labels: { span: { line: number; column: number } }[];
};

const root = join(import.meta.dir, "../..");
const baselinePath = "scripts/ci/landmines-baseline.json";
const configPath = ".oxlintrc.json";

function nativeAllowances({ rules: globalRules = {}, overrides = [] }: LintConfig) {
  for (const [rule, setting] of Object.entries(globalRules)) {
    if (Array.isArray(setting) && setting[1]?.allow)
      throw new Error(`${rule}: put allowances in path-specific overrides`);
  }
  const allowances: Counts = {};
  for (const { files, rules = {} } of overrides) {
    for (const [rule, setting] of Object.entries(rules)) {
      if (!Array.isArray(setting) || !setting[1]?.allow) continue;
      const entries = Object.entries<number>(setting[1].allow);
      if (entries.length !== files.length || entries.some(([file]) => !files.includes(file))) {
        throw new Error(`${rule}: override paths must exactly match the allowance paths`);
      }
      allowances[rule] ??= {};
      const counts = allowances[rule];
      for (const [file, count] of entries) {
        if (Object.hasOwn(counts, file)) throw new Error(`${file}: duplicate ${rule} allowance`);
        counts[file] = count;
      }
    }
  }
  return allowances;
}

function checkShrinkOnly(current: Counts, previous: Counts) {
  const errors: string[] = [];
  for (const [rule, files] of Object.entries(current)) {
    for (const [file, count] of Object.entries(files)) {
      if (count > (previous[rule]?.[file] ?? 0)) errors.push(`${file}: ${rule} allowance can only shrink`);
    }
  }
  return errors;
}

function checkAgainstBase(base: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  if (!git("ls-tree", base, "--", baselinePath, configPath).trim()) return [];
  const previous: Counts = JSON.parse(git("show", `${base}:${baselinePath}`));
  const previousConfig: LintConfig = JSON.parse(git("show", `${base}:${configPath}`));
  return [
    ...checkShrinkOnly(baseline, previous),
    ...checkShrinkOnly(nativeAllowances(config), nativeAllowances(previousConfig)),
  ];
}

function checkDiagnostics(diagnostics: Diagnostic[]) {
  const limits: Counts = baseline;
  const seen = new Map<string, number>();
  const errors: string[] = [];
  for (const diagnostic of diagnostics) {
    const { filename, code, message, labels } = diagnostic;
    const rule = code?.replace(/\(([^)]+)\)$/, "/$1");
    const limit = rule && filename ? limits[rule]?.[filename] : undefined;
    if (limit !== undefined) {
      const key = `${rule}\0${filename}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count <= limit) continue;
    }
    const span = labels[0]?.span;
    const location = span ? `${filename}:${span.line}:${span.column}` : filename;
    errors.push([location, rule, message].filter(Boolean).join(": "));
  }
  for (const [rule, files] of Object.entries(limits)) {
    for (const [file, limit] of Object.entries(files)) {
      const count = seen.get(`${rule}\0${file}`) ?? 0;
      if (count < limit) errors.push(`${file}: lower ${rule} baseline to ${count} (remove at zero)`);
    }
  }
  for (const [rule, files] of Object.entries(nativeAllowances(config))) {
    for (const file of Object.keys(files)) {
      if (!existsSync(join(root, file))) errors.push(`${file}: remove stale ${rule} allowance for missing file`);
    }
  }
  return errors;
}

function lint() {
  const start = performance.now();
  const result = spawnSync(
    "node",
    [
      "node_modules/oxlint/bin/oxlint",
      "--config",
      configPath,
      "--threads",
      "4",
      "--disable-nested-config",
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  if ((result.status !== 0 && result.status !== 1) || !result.stdout.trim()) {
    throw new Error(`Oxlint did not complete (status ${result.status}, signal ${result.signal}): ${result.stdout}`);
  }
  const report: { diagnostics: Diagnostic[]; number_of_files: number; number_of_rules: number } = JSON.parse(
    result.stdout,
  );
  if (
    report.number_of_files < 1 ||
    report.number_of_rules !== 10 ||
    (result.status === 1 && !report.diagnostics.length)
  ) {
    throw new Error("Oxlint did not report a complete run of the ten recommended Landmines rules");
  }
  const errors = checkDiagnostics(report.diagnostics);
  console.log(
    `Landmines checked ${report.number_of_files} files in ${((performance.now() - start) / 1000).toFixed(2)} s`,
  );
  return errors;
}

const base = process.argv[2];
const errors = base ? checkAgainstBase(base) : lint();
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
