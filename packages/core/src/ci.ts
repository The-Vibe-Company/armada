// Pure CI diagnosis, shared by workers, the coordinator and future rerun rules.
import type { CiConfig } from "./config.ts";

export interface FailedCheck {
  id: number | null;
  name: string;
  conclusion: string;
  url: string | null;
  app: string | null;
  runId: number | null;
  headSha: string;
  summary: string | null;
  annotations: { title: string | null; message: string; path: string; line: number | null }[];
  attempt?: number | null;
  superseded?: boolean;
  /** Actions' job steps, read only for a possible dependency-only failure. */
  steps?: { name: string; conclusion: string | null; number: number }[];
}

export interface JobLog {
  lines: string[];
  warnings: string[];
}

export interface Explanation {
  check: string;
  conclusion: string;
  url: string | null;
  /** Latest workflow attempt; a partially rerun job can have logs from an older attempt. */
  attempt: number | null;
  tests: string[];
  error: string[];
  class: "known" | "runner" | "dependent" | "failure" | "external";
  /** Failed checks in the same workflow that this summary reports. */
  dependencies?: string[];
  known?: { ticket: string; pattern: string };
  /** All matching root-cause declarations when a job contains several known failures. */
  knownMatches?: { ticket: string; pattern: string }[];
  /** Informational: a cancelled old head is not a failure. */
  superseded?: boolean;
}

/** Validates the project's test-name regex, including exactly one capture. */
export function failurePattern(pattern: string): RegExp {
  const re = new RegExp(pattern);
  let captures = 0;
  let bracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") bracket = true;
    else if (c === "]") bracket = false;
    else if (!bracket && c === "(" && (pattern[i + 1] !== "?" || /^\(\?<[^=!]/.test(pattern.slice(i)))) captures++;
  }
  if (captures !== 1) throw new Error("expected exactly one capture group for the test name");
  return re;
}

const TEST_PATTERNS = [
  /\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/,
  /^\s*[✕×]\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?$/,
  /^\s*FAIL\s+(.+)/,
  /^\s*FAILED\s+(\S+::\S+)/,
  /^\s*--- FAIL:\s+(.+?)(?:\s+\([\d.]+s\))?$/,
  /^\s*test\s+(.+?)\s+\.\.\.\s+FAILED\s*$/,
];
const RUNNER =
  /No space left on device|The runner has received a shutdown signal|lost communication with the server|The hosted runner encountered an error|The job was not acquired by Runner of type hosted/i;

/** Strip transport timestamps and terminal escapes, retaining useful indentation. */
export function ciLine(line: string): string {
  return (
    line
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes from CI logs
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
      .replace(/\r$/, "")
      .slice(0, 1000)
  );
}

/** Only a gate that prints named dependency failures and exits, with no other commands/errors.
 * Unknown aggregate scripts remain failures: job names alone are never evidence.
 */
function summaryDependencies(check: FailedCheck, log?: JobLog): string[] {
  if (!log || log.warnings.length || check.conclusion !== "FAILURE" || !check.steps?.length) return [];
  const exitError = "##[error]Process completed with exit code 1.";
  const gateNotice = (text: string | null) =>
    !text?.trim() || [exitError, "Process completed with exit code 1."].includes(text.trim());
  if (!gateNotice(check.summary) || check.annotations.some((a) => !gateNotice(a.title) || !gateNotice(a.message)))
    return [];
  // ciLine bounds diagnostic lines; lossy text cannot establish a gate's complete script.
  if (log.lines.some((line) => line.length > 1000)) return [];
  if (check.steps.filter((s) => s.conclusion === "failure").length !== 1) return [];
  // Whole-job logs do not identify custom step names. A gate-only job binds the sole
  // Run block to its sole executed user step, excluding a continued successful gate.
  const setup = check.steps[0];
  const complete = check.steps.at(-1);
  if (
    setup?.name !== "Set up job" ||
    setup.number !== 1 ||
    setup.conclusion !== "success" ||
    complete?.name !== "Complete job" ||
    complete.conclusion !== "success" ||
    complete.number !== Math.max(...check.steps.map((s) => s.number))
  )
    return [];
  const userSteps = check.steps.slice(1, -1);
  if (
    userSteps.filter((s) => s.conclusion === "failure").length !== 1 ||
    userSteps.some((s) => s.conclusion !== "failure" && s.conclusion !== "skipped")
  )
    return [];
  const lines = log.lines
    .map(ciLine)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.filter((l) => l.includes("##[error]")).join("\n") !== exitError) return [];
  if (lines.filter((l) => l.startsWith("##[group]Run ")).length !== 1) return [];
  const start = lines.findIndex((l) => l.startsWith('##[group]Run echo "Dependency failed: '));
  const end = lines.indexOf("##[endgroup]", start);
  const failed = lines.indexOf(exitError, end);
  if (start < 0 || end < 0 || failed < 0) return [];
  const script = lines.slice(start + 1, end).filter((l) => !l.startsWith("shell: "));
  if (script.pop() !== "exit 1" || !script.length) return [];
  const commands = script.map((l) => l.match(/^echo "Dependency failed: ([^"$`\\]+)"$/)?.[1]);
  if (commands.some((name) => !name)) return [];
  if (lines[start] !== `##[group]Run ${script[0]}`) return [];
  const output = lines.slice(end + 1, failed);
  if (output.length !== commands.length || output.some((l, i) => l !== `Dependency failed: ${commands[i]}`)) return [];
  return [...new Set(commands as string[])];
}

export function explainChecks(
  checks: readonly FailedCheck[],
  logs: ReadonlyMap<number, JobLog>,
  config?: CiConfig,
): Explanation[] {
  const patterns = [...(config?.failurePatterns ?? []).map(failurePattern), ...TEST_PATTERNS];
  const explanations: Explanation[] = checks.map((check) => {
    const log = check.id === null ? [] : (logs.get(check.id)?.lines ?? []).map(ciLine);
    // Dependency gates must pass their stricter proof even when a declaration or
    // runner signature would otherwise classify the summary's own error as safe.
    const dependencyCandidate = log.some((line) => line.trim().startsWith('##[group]Run echo "Dependency failed: '));
    const annotations = check.annotations.flatMap((a) => [a.title ?? "", ...a.message.split("\n")]).map(ciLine);
    const summary = (check.summary ?? "").split("\n").map(ciLine);
    const tests = new Set<string>();
    const nameAt = (line: string) => patterns.map((p) => p.exec(line)?.[1]?.trim()).find(Boolean);
    let mocha = false;
    for (const line of [...annotations, ...log]) {
      if (/^\s*\d+ failing\s*$/.test(line)) mocha = true;
      const name = nameAt(line) ?? (mocha ? line.match(/^\s*\d+\)\s+(.+?):?\s*$/)?.[1]?.replace(/:$/, "") : undefined);
      if (name) tests.add(name);
    }
    const evidence = [...annotations, ...summary, ...log].join("\n");
    const runner = RUNNER.test(evidence) || (/exit code 137/i.test(evidence) && /\bKilled\b/.test(evidence));
    const lines = log.some((l) => l.trim())
      ? log
      : (check.app === "github-actions" ? [...annotations, ...summary] : [...summary, ...annotations]).filter(Boolean);
    // A final Actions exit-code annotation must not hide an earlier test error.
    const first =
      check.app !== "github-actions" && check.summary?.trim()
        ? 0
        : lines.findIndex(
            (l) =>
              l.includes("##[error]") ||
              !!nameAt(l) ||
              RUNNER.test(l) ||
              /\d+ failing|\bKilled\b|error[: ]|AssertionError|^\s*Expected:/i.test(l),
          );
    const start = Math.max(0, first - 8);
    const error = check.superseded ? ["superseded by a newer head"] : lines.slice(start, start + 40);
    const declarations =
      check.app === "github-actions" && !check.superseded
        ? (config?.knownFailures ?? [])
            .filter((k) => k.check === check.name)
            .map((k) => ({ ...k, regex: new RegExp(k.pattern) }))
        : [];
    const names = [...tests];
    const matches = (name: string) => declarations.filter((k) => k.regex.test(name));
    // An error-block signature can identify one otherwise unrecognized failing test.
    // With several failures, each name must be covered independently.
    const blockMatches = names.length <= 1 ? declarations.filter((k) => k.regex.test(error.join("\n"))) : [];
    const unknownNames = names.filter((name) => !matches(name).length && !blockMatches.length);
    const matched = [...new Set([...names.flatMap(matches), ...blockMatches])];
    const known = !dependencyCandidate && !unknownNames.length ? matched[0] : undefined;
    const knownMatches = matched.map(({ ticket, pattern }) => ({ ticket, pattern }));
    const runnerOnly = !dependencyCandidate && runner && !unknownNames.length;
    return {
      check: check.name,
      conclusion: check.conclusion,
      url: check.url,
      attempt: check.attempt ?? null,
      tests: [...unknownNames, ...names.filter((name) => !unknownNames.includes(name))].slice(0, 20),
      error,
      class: check.app !== "github-actions" ? "external" : known ? "known" : runnerOnly ? "runner" : "failure",
      ...(known
        ? {
            known: { ticket: known.ticket, pattern: known.pattern },
            ...(knownMatches.length > 1 ? { knownMatches } : {}),
          }
        : {}),
      ...(check.superseded ? { superseded: true } : {}),
    };
  });
  // Resolve summaries from their real failures, never from another workflow or a cycle.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [i, check] of checks.entries()) {
      const explanation = explanations[i];
      if (explanation?.class !== "failure" || explanation.tests.length || check.runId === null || check.superseded)
        continue;
      const dependencies = summaryDependencies(check, check.id === null ? undefined : logs.get(check.id));
      if (!dependencies.length) continue;
      const covered = dependencies.every((name) => {
        const peers = checks.flatMap((c, j) =>
          j !== i && c.name === name && c.runId === check.runId && c.headSha === check.headSha && !c.superseded
            ? [explanations[j]]
            : [],
        );
        return peers.length > 0 && peers.every((e) => e && ["known", "runner", "dependent"].includes(e.class));
      });
      if (covered) {
        explanation.class = "dependent";
        explanation.dependencies = dependencies;
        changed = true;
      }
    }
  }
  return explanations;
}

export interface RerunDecision {
  allowed: boolean;
  reason: string;
  tickets: string[];
}

/** Evaluate one workflow run; GitHub's attempt is the only rerun record. */
export function rerunDecision(explanations: readonly Explanation[], attempt: number | null): RerunDecision {
  const refuse = (reason: string): RerunDecision => ({ allowed: false, reason, tickets: [] });
  if (attempt !== null && attempt > 1) return refuse(`already rerun once, attempt ${attempt}`);
  if (attempt !== 1) return refuse("attempt unavailable; cannot establish that this is the first attempt");
  const failures = explanations.filter((e) => !e.superseded);
  if (!failures.length) return refuse("No failing checks to rerun");
  const unknown = failures.filter((e) => !["known", "runner", "dependent"].includes(e.class));
  if (unknown.length) return refuse(`unknown or external failures: ${unknown.map((e) => e.check).join("; ")}`);
  if (!failures.some((e) => e.class === "known" || e.class === "runner"))
    return refuse("No real failing checks to rerun");
  if (failures.some((e) => e.class === "known" && !e.known)) return refuse("known failure has no root-cause ticket");
  return {
    allowed: true,
    reason: "all failures are known flaky failures or runner problems",
    tickets: [...new Set(failures.flatMap((e) => (e.knownMatches ?? (e.known ? [e.known] : [])).map((k) => k.ticket)))],
  };
}
