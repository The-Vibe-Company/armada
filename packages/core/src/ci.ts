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
  class: "known" | "runner" | "failure" | "external";
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

export function explainChecks(
  checks: readonly FailedCheck[],
  logs: ReadonlyMap<number, JobLog>,
  config?: CiConfig,
): Explanation[] {
  const patterns = [...(config?.failurePatterns ?? []).map(failurePattern), ...TEST_PATTERNS];
  return checks.map((check) => {
    const log = check.id === null ? [] : (logs.get(check.id)?.lines ?? []).map(ciLine);
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
    const known = !unknownNames.length ? matched[0] : undefined;
    const knownMatches = matched.map(({ ticket, pattern }) => ({ ticket, pattern }));
    const runnerOnly = runner && !unknownNames.length;
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
  const unknown = failures.filter((e) => e.class !== "known" && e.class !== "runner");
  if (unknown.length) return refuse(`unknown or external failures: ${unknown.map((e) => e.check).join("; ")}`);
  if (failures.some((e) => e.class === "known" && !e.known)) return refuse("known failure has no root-cause ticket");
  return {
    allowed: true,
    reason: "all failures are known flaky failures or runner problems",
    tickets: [...new Set(failures.flatMap((e) => (e.knownMatches ?? (e.known ? [e.known] : [])).map((k) => k.ticket)))],
  };
}
